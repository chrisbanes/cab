import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import type { WorkspaceMaintenanceAttention } from "../../src/core/inbox-lifecycle.js";
import { WorkspaceLifecycleStore } from "../../src/core/workspace-lifecycle.js";
import type { WorkspaceMaintenanceSettings } from "../../src/operator/workspace-maintenance-settings.js";
import { claudeTemporaryBase } from "../../src/standalone/claude.js";
import { OperatorApi } from "../../src/standalone/operator-api.js";
import type { StandaloneServiceOptions } from "../../src/standalone/service.js";
import {
  type MaintenanceCandidate,
  type MaintenanceOutcome,
  maintenanceReason,
  retentionDue,
  WorkspaceMaintenance,
} from "../../src/standalone/workspace-maintenance.js";
import {
  type MeasureRoot,
  measureInWorker,
} from "../../src/standalone/workspace-maintenance-worker.js";
import { controlledGit } from "../fixtures/controlled-git.js";
import { processIdentityDenied } from "../fixtures/host-access.js";
import { createOperatorFixture } from "../fixtures/operator-web.js";
import { tmpdir } from "../fixtures/temp.js";
import { finishTask } from "../fixtures/workspace-removal.js";
import { startedOf } from "../fixtures/service-internals.js";

const H = 3_600_000;
const GB = 1_000_000_000;
const settings = (
  overrides: Partial<WorkspaceMaintenanceSettings> = {},
): WorkspaceMaintenanceSettings => ({
  idleHours: 24,
  deliveredRetentionHours: 24,
  mergedRetentionHours: 1,
  diskCapGb: 10,
  ...overrides,
});
/** Ordered ids, so an exact idle tie is broken visibly. */
const wid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const candidate = (
  n: number,
  overrides: Partial<MaintenanceCandidate> = {},
): MaintenanceCandidate => ({
  taskId: `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
  workspaceId: wid(n),
  roots: [{ path: `/w/${n}`, optional: false }],
  writable: true,
  terminal: false,
  terminalAt: null,
  lastTurnEndedAt: null,
  trimmedSinceTurn: false,
  lastPushAt: null,
  pushUnknown: false,
  allMergedAt: null,
  fingerprint: "facts-1",
  ...overrides,
});

/**
 * A fake service: stored candidates, a size table the trims and removals change, and scripted
 * refusals. It records every call in order.
 */
function fakeWorld(
  candidates: MaintenanceCandidate[],
  sizes: Record<number, number | null> = {},
  options: {
    settings?: Partial<WorkspaceMaintenanceSettings>;
    refuse?: Record<string, MaintenanceOutcome & { done: false }>;
    /** Bytes a trim leaves, by candidate number; default: unchanged. */
    trimmed?: Record<number, number>;
  } = {},
) {
  const list = [...candidates];
  const table = new Map(
    Object.entries(sizes).map(([n, bytes]) => [wid(Number(n)), bytes]),
  );
  const calls: string[] = [];
  const reports: Array<WorkspaceMaintenanceAttention | null> = [];
  const clock = { now: 0 };
  let measured = 0;
  const walked: number[] = [];
  const number = (c: MaintenanceCandidate) => Number(c.workspaceId.slice(-12));
  const effect = async (
    kind: "trim" | "remove",
    c: MaintenanceCandidate,
    trigger: string,
  ): Promise<MaintenanceOutcome> => {
    calls.push(`${kind}:${trigger}:${number(c)}`);
    const refused = options.refuse?.[`${kind}:${number(c)}`];
    if (refused) return refused;
    if (kind === "remove") {
      list.splice(list.indexOf(c), 1);
      table.delete(c.workspaceId);
    } else {
      const left = options.trimmed?.[number(c)];
      if (left !== undefined) table.set(c.workspaceId, left);
      list[list.indexOf(c)] = { ...c, trimmedSinceTurn: true };
    }
    return { done: true };
  };
  const make = (extra: Partial<WorkspaceMaintenanceSettings> = {}) =>
    new WorkspaceMaintenance({
      settings: settings({ ...options.settings, ...extra }),
      host: {
        candidates: () => [...list],
        trim: (c, trigger) => effect("trim", c, trigger),
        remove: (c, trigger) => effect("remove", c, trigger),
        report: (attention) => {
          reports.push(attention);
        },
      },
      measure: async (roots: readonly MeasureRoot[]) => {
        measured++;
        walked.push(...roots.map((r) => Number(r.key.slice(-12))));
        return new Map(
          roots.map((r) => [r.key, table.has(r.key) ? table.get(r.key)! : 0]),
        );
      },
      now: () => clock.now,
      every: () => () => {},
    });
  return {
    list,
    table,
    calls,
    reports,
    clock,
    measured: () => measured,
    walked,
    make,
    total: () =>
      [...table.values()].reduce<number>((sum, b) => sum + (b ?? 0), 0),
  };
}

test("delivered retention removes exactly at 24 hours after the last push, once terminal", async () => {
  for (const [at, removed] of [
    [24 * H - 1, false],
    [24 * H, true],
    [24 * H + 1, true],
  ] as const) {
    const w = fakeWorld([
      candidate(1, { terminal: true, terminalAt: 2 * H, lastPushAt: 0 }),
    ]);
    w.clock.now = at;
    const report = await w.make().wake();
    assert.deepEqual(w.calls, removed ? ["remove:delivered:1"] : [], `${at}`);
    assert.equal(report?.attention, null);
  }
  // Open work is never removed by age.
  const open = fakeWorld([candidate(1, { lastPushAt: 0 })]);
  open.clock.now = 100 * H;
  await open.make().wake();
  assert.deepEqual(open.calls, []);
});

test("merged retention removes 1 hour after every change request merged, and the sooner retention wins", () => {
  const s = settings();
  const due = (c: Partial<MaintenanceCandidate>, now: number) =>
    retentionDue(candidate(1, { terminal: true, terminalAt: 0, ...c }), s, now);
  assert.equal(due({ lastPushAt: 0, allMergedAt: 5 * H }, 6 * H - 1), null);
  assert.deepEqual(due({ lastPushAt: 0, allMergedAt: 5 * H }, 6 * H), {
    trigger: "merged",
    expiredAt: 6 * H,
  });
  // Merged an hour before the delivered limit: delivered expires first.
  assert.deepEqual(due({ lastPushAt: 0, allMergedAt: 30 * H }, 24 * H), {
    trigger: "delivered",
    expiredAt: 24 * H,
  });
  // An exact tie is merged.
  assert.deepEqual(due({ lastPushAt: 0, allMergedAt: 23 * H }, 24 * H), {
    trigger: "merged",
    expiredAt: 24 * H,
  });
  // A cancelled task with nothing pushed counts from becoming terminal.
  assert.equal(due({ terminalAt: 10 * H }, 34 * H - 1), null);
  assert.deepEqual(due({ terminalAt: 10 * H }, 34 * H), {
    trigger: "delivered",
    expiredAt: 34 * H,
  });
  // Unknown legacy anchors are never expired: a named gap instead.
  assert.equal(due({ terminalAt: null }, 1_000 * H), "unknown");
  assert.equal(due({ pushUnknown: true, lastPushAt: 0 }, 1_000 * H), "unknown");
  // A known merge still applies when the push anchor is unknown.
  assert.deepEqual(due({ pushUnknown: true, allMergedAt: 0 }, H), {
    trigger: "merged",
    expiredAt: H,
  });
  // Each retention off disables only that trigger.
  const mergedOff = settings({ mergedRetentionHours: "off" });
  assert.deepEqual(
    retentionDue(
      candidate(1, { terminal: true, lastPushAt: 0, allMergedAt: 0 }),
      mergedOff,
      24 * H,
    ),
    { trigger: "delivered", expiredAt: 24 * H },
  );
  const deliveredOff = settings({ deliveredRetentionHours: "off" });
  assert.equal(
    retentionDue(
      candidate(1, { terminal: true, lastPushAt: 0 }),
      deliveredOff,
      1_000 * H,
    ),
    "unknown",
  );
  const bothOff = settings({
    deliveredRetentionHours: "off",
    mergedRetentionHours: "off",
  });
  assert.equal(
    retentionDue(
      candidate(1, { terminal: true, lastPushAt: 0, allMergedAt: 0 }),
      bothOff,
      1_000 * H,
    ),
    null,
  );
});

test("a pass records unknown anchors as gaps and a backward clock never expires anything", async () => {
  const w = fakeWorld([
    candidate(1, { terminal: true, terminalAt: null }),
    candidate(2, { terminal: true, terminalAt: 0 }),
  ]);
  const m = w.make();
  w.clock.now = 10 * H;
  const report = await m.wake();
  assert.deepEqual(report?.gaps, [
    { workspaceId: wid(1), reason: "clock-unknown" },
  ]);
  assert.deepEqual(w.calls, []);
  // The wall clock steps back; elapsed time never goes backward with it.
  w.clock.now = 1;
  await m.wake();
  assert.deepEqual(w.calls, []);
  w.clock.now = 24 * H;
  await m.wake();
  assert.deepEqual(w.calls, ["remove:delivered:2"]);
});

test("idle trimming runs once per last-ended-turn epoch, across repeated and restarted passes", async () => {
  const w = fakeWorld([candidate(1, { lastTurnEndedAt: 0 })]);
  const m = w.make();
  w.clock.now = 24 * H - 1;
  await m.wake();
  assert.deepEqual(w.calls, []);
  w.clock.now = 24 * H;
  await m.wake();
  await m.wake();
  // A restarted coordinator sees the completed trim in the stored facts.
  await w.make().wake();
  assert.deepEqual(w.calls, ["trim:idle:1"]);
  // A transient refusal backs off and is retried in the same epoch, not every minute.
  const refused = fakeWorld(
    [candidate(2, { lastTurnEndedAt: 0 })],
    {},
    {
      refuse: { "trim:2": { done: false, reason: "unsettled" } },
    },
  );
  refused.clock.now = 30 * H;
  const r = refused.make();
  await r.wake();
  refused.clock.now += 60_000;
  await r.wake();
  assert.deepEqual(refused.calls, ["trim:idle:2"]);
  refused.clock.now += 5 * 60_000;
  await r.wake();
  assert.deepEqual(refused.calls, ["trim:idle:2", "trim:idle:2"]);
  // A refusal that will not clear by itself ends the epoch.
  const final = fakeWorld(
    [candidate(3, { lastTurnEndedAt: 0 })],
    {},
    { refuse: { "trim:3": { done: false, reason: "refused" } } },
  );
  final.clock.now = 30 * H;
  const fm = final.make();
  await fm.wake();
  final.clock.now += 2 * H;
  await fm.wake();
  assert.deepEqual(final.calls, ["trim:idle:3"]);
  // A new turn end is a new epoch.
  w.list[0] = {
    ...w.list[0]!,
    lastTurnEndedAt: 30 * H,
    trimmedSinceTurn: false,
  };
  w.clock.now = 54 * H;
  await m.wake();
  assert.deepEqual(w.calls, ["trim:idle:1", "trim:idle:1"]);
});

test("each limit off disables only its trigger", async () => {
  const expired = () => [
    candidate(1, {
      terminal: true,
      terminalAt: 0,
      lastPushAt: 0,
      lastTurnEndedAt: 0,
    }),
  ];
  const run = async (off: Partial<WorkspaceMaintenanceSettings>) => {
    const w = fakeWorld(expired(), { 1: 20 * GB }, { settings: off });
    w.clock.now = 48 * H;
    await w.make().wake();
    return { calls: w.calls, measured: w.measured() };
  };
  // The removed root is never walked.
  assert.deepEqual(await run({}), {
    calls: ["remove:delivered:1"],
    measured: 0,
  });
  assert.deepEqual(
    await run({
      idleHours: "off",
      deliveredRetentionHours: "off",
      mergedRetentionHours: "off",
    }),
    {
      calls: ["trim:disk:1"],
      measured: 2,
    },
  );
  assert.deepEqual(
    await run({
      diskCapGb: "off",
      deliveredRetentionHours: "off",
      mergedRetentionHours: "off",
    }),
    {
      calls: ["trim:idle:1"],
      measured: 0,
    },
  );
  assert.deepEqual(
    await run({
      deliveredRetentionHours: "off",
      idleHours: "off",
      diskCapGb: "off",
    }),
    {
      calls: [],
      measured: 0,
    },
  );
});

test("the disk cap trims oldest idle first and stops once trimming is enough", async () => {
  const w = fakeWorld(
    [
      candidate(3, { lastTurnEndedAt: 5 }),
      candidate(2, { lastTurnEndedAt: 1, terminal: true, terminalAt: 1 }),
      candidate(1, { lastTurnEndedAt: 1 }),
    ],
    { 1: 6 * GB, 2: 3 * GB, 3: 3 * GB },
    { trimmed: { 1: 1 * GB }, settings: { idleHours: "off" } },
  );
  w.clock.now = 2 * H;
  const report = await w.make().wake();
  // 1 and 2 tie on idle time; the workspace id orders them.
  assert.deepEqual(w.calls, ["trim:disk:1"]);
  assert.equal(w.total(), 7 * GB);
  assert.equal(report?.usage, null);
  assert.equal(report?.attention, null);
});

test("when trimming is not enough it removes terminal workspaces oldest idle first until exactly at the cap", async () => {
  const w = fakeWorld(
    [
      candidate(1, { lastTurnEndedAt: 1 }),
      candidate(2, { lastTurnEndedAt: 2, terminal: true, terminalAt: 2 }),
      candidate(3, { lastTurnEndedAt: 3, terminal: true, terminalAt: 3 }),
      candidate(4, { lastTurnEndedAt: 4, terminal: true, terminalAt: 4 }),
    ],
    { 1: 4 * GB, 2: 3 * GB, 3: 3 * GB, 4: 3 * GB },
    { settings: { idleHours: "off", deliveredRetentionHours: 1_000 } },
  );
  w.clock.now = 10 * H;
  const report = await w.make().wake();
  assert.deepEqual(w.calls, [
    "trim:disk:1",
    "trim:disk:2",
    "trim:disk:3",
    "trim:disk:4",
    "remove:disk:2",
  ]);
  assert.equal(w.total(), 10 * GB);
  assert.equal(report?.attention, null);
});

test("refused candidates leave residual pressure named by one attention report", async () => {
  const w = fakeWorld(
    [
      candidate(1, { lastTurnEndedAt: 1 }),
      candidate(2, { lastTurnEndedAt: 2, terminal: true, terminalAt: 20 * H }),
      candidate(3, { lastTurnEndedAt: 3, terminal: true, terminalAt: 20 * H }),
      candidate(4, {
        lastTurnEndedAt: 4,
        terminal: true,
        terminalAt: 20 * H,
        writable: false,
      }),
      candidate(5, {
        lastTurnEndedAt: null,
        terminal: true,
        terminalAt: 20 * H,
      }),
      candidate(6, {
        lastTurnEndedAt: 0,
        terminal: true,
        terminalAt: 0,
        lastPushAt: 0,
      }),
    ],
    { 1: 4 * GB, 2: 3 * GB, 3: 2 * GB, 4: 2 * GB, 5: 1 * GB, 6: 1 * GB },
    {
      settings: { idleHours: "off" },
      refuse: {
        "trim:2": { done: false, reason: "unsettled" },
        "remove:3": { done: false, reason: "uncommitted" },
        "remove:6": { done: false, reason: "push-refused" },
      },
    },
  );
  w.clock.now = 30 * H;
  const report = await w.make().wake();
  assert.deepEqual(w.calls, [
    "remove:delivered:6",
    "trim:disk:6",
    "trim:disk:1",
    "trim:disk:2",
    "trim:disk:3",
    // 6 was refused removal this pass on the same facts, so it is not tried again.
    "remove:disk:3",
  ]);
  const attention = report!.attention!;
  assert.deepEqual(attention.usage, {
    measuredBytes: 13 * GB,
    capBytes: 10 * GB,
  });
  assert.deepEqual(
    attention.blockers.map((b) => [
      b.condition,
      Number(b.workspaceId.slice(-12)),
      b.reason,
    ]),
    [
      ["retention", 6, "push-refused"],
      ["disk-cap", 1, "task-open"],
      ["disk-cap", 2, "unsettled"],
      ["disk-cap", 3, "uncommitted"],
      ["disk-cap", 4, "project-read-only"],
      ["disk-cap", 5, "clock-unknown"],
      ["disk-cap", 6, "push-refused"],
    ],
  );
  assert.equal(w.reports.length, 1);
});

test("blockers beyond the stored bound are counted, not silently cut", async () => {
  const many = Array.from({ length: 55 }, (_, i) =>
    candidate(i + 1, { terminal: true, terminalAt: 0, lastPushAt: 0 }),
  );
  const w = fakeWorld(
    many,
    {},
    {
      settings: { diskCapGb: "off", idleHours: "off" },
      refuse: Object.fromEntries(
        many.map((_, i) => [
          `remove:${i + 1}`,
          { done: false, reason: "uncommitted" },
        ]),
      ),
    },
  );
  w.clock.now = 25 * H;
  const report = await w.make().wake();
  assert.equal(report?.attention?.blockers.length, 50);
  assert.equal(report?.attention?.total, 55);
});

test("with both retentions off the cap only trims, and with the cap off it neither measures nor reports", async () => {
  const both = fakeWorld(
    [
      candidate(1, {
        lastTurnEndedAt: 1,
        terminal: true,
        terminalAt: 0,
        lastPushAt: 0,
      }),
    ],
    { 1: 12 * GB },
    {
      settings: {
        idleHours: "off",
        deliveredRetentionHours: "off",
        mergedRetentionHours: "off",
      },
    },
  );
  both.clock.now = 100 * H;
  const report = await both.make().wake();
  assert.deepEqual(both.calls, ["trim:disk:1"]);
  assert.deepEqual(
    report?.attention?.blockers.map((b) => b.reason),
    ["removal-off"],
  );
  const off = fakeWorld(
    [candidate(1, { lastTurnEndedAt: 1 })],
    { 1: 99 * GB },
    {
      settings: { diskCapGb: "off", idleHours: "off" },
    },
  );
  const quiet = await off.make().wake();
  assert.equal(off.measured(), 0);
  assert.deepEqual(off.calls, []);
  assert.equal(quiet?.attention, null);
});

test("unknown usage is never zero: it never resolves the cap and names each unmeasured workspace", async () => {
  const w = fakeWorld(
    [
      candidate(1, { lastTurnEndedAt: 1 }),
      candidate(2, { lastTurnEndedAt: 2 }),
    ],
    { 1: 11 * GB, 2: null },
    { settings: { idleHours: "off" } },
  );
  const m = w.make();
  const over = await m.wake();
  assert.deepEqual(
    over?.attention?.blockers.map((b) => b.reason),
    ["task-open", "unmeasured"],
  );
  // Known usage now under the cap but one root unknown: the item stays, naming that workspace.
  w.table.set(wid(1), 1 * GB);
  w.clock.now += 16 * 60_000;
  const unknown = await m.wake();
  assert.equal(unknown?.usage, "unknown");
  assert.deepEqual(unknown?.attention, {
    usage: null,
    blockers: [
      {
        taskId: candidate(2).taskId,
        workspaceId: wid(2),
        condition: "disk-cap",
        reason: "unmeasured",
      },
    ],
    total: 1,
  });
  w.table.set(wid(2), 1 * GB);
  assert.equal((await m.wake())?.attention, null);
});

test("a trim that brings known usage under the cap keeps unmeasured roots listed", async () => {
  const w = fakeWorld(
    [
      candidate(1, { lastTurnEndedAt: 1 }),
      candidate(2, { lastTurnEndedAt: 2 }),
    ],
    { 1: 11 * GB, 2: null },
    { settings: { idleHours: "off" }, trimmed: { 1: 1 * GB } },
  );
  const report = await w.make().wake();
  assert.deepEqual(w.calls, ["trim:disk:1"]);
  assert.equal(report?.usage, "unknown");
  assert.deepEqual(report?.attention, {
    usage: null,
    blockers: [
      {
        taskId: candidate(2).taskId,
        workspaceId: wid(2),
        condition: "disk-cap",
        reason: "unmeasured",
      },
    ],
    total: 1,
  });
});

test("an unchanged root is not walked again until it is stale, and only a touched root is walked after an effect", async () => {
  const w = fakeWorld(
    [
      candidate(1, { lastTurnEndedAt: 1 }),
      candidate(2, { lastTurnEndedAt: 2 }),
    ],
    { 1: 6 * GB, 2: 6 * GB },
    { settings: { idleHours: "off" }, trimmed: { 1: 1 * GB } },
  );
  const m = w.make();
  await m.wake();
  // The first pass walks both, then only the trimmed root.
  assert.deepEqual(w.walked, [1, 2, 1]);
  await m.wake();
  assert.deepEqual(w.walked, [1, 2, 1], "a second pass walks no tree");
  w.clock.now += 15 * 60_000;
  await m.wake();
  assert.deepEqual(w.walked, [1, 2, 1, 1, 2]);
  // A new turn end makes a root stale at once.
  w.list[1] = { ...w.list[1]!, lastTurnEndedAt: 3 };
  await m.wake();
  assert.deepEqual(w.walked, [1, 2, 1, 1, 2, 2]);
});

test("a refused removal on unchanged facts backs off, doubling to an hour, and retries when the facts change", async () => {
  const w = fakeWorld(
    [candidate(1, { terminal: true, terminalAt: 0, lastPushAt: 0 })],
    {},
    {
      settings: { diskCapGb: "off" },
      refuse: { "remove:1": { done: false, reason: "push-refused" } },
    },
  );
  const m = w.make();
  const passAt = async (at: number) => {
    w.clock.now = at;
    return m.wake();
  };
  const base = 25 * H;
  for (const minute of [0, 1, 2]) {
    const report = await passAt(base + minute * 60_000);
    // Skipped passes still name the blocker.
    assert.deepEqual(
      report?.attention?.blockers.map((b) => b.reason),
      ["push-refused"],
    );
  }
  assert.equal(w.calls.length, 1);
  await passAt(base + 5 * 60_000);
  assert.equal(w.calls.length, 2);
  await passAt(base + 14 * 60_000);
  assert.equal(w.calls.length, 2, "the second wait is ten minutes");
  await passAt(base + 15 * 60_000);
  assert.equal(w.calls.length, 3);
  // Changed facts, such as a new delivery policy, retry at once.
  w.list[0] = { ...w.list[0]!, fingerprint: "facts-2" };
  await passAt(base + 16 * 60_000);
  assert.equal(w.calls.length, 4);
});

test("service refusal text maps to fixed reason codes, never to its detail", () => {
  for (const [text, code] of [
    ["Only a done or cancelled task's workspace can be removed", "task-open"],
    ["Task execution is not settled or its workspace is held", "unsettled"],
    ["Uncommitted work remains in R1: modified tracked files", "uncommitted"],
    [
      "Result r recorded uncommitted changes in R1 that are neither",
      "pending-result",
    ],
    [
      "Pushing R1 to its task branch was refused: fatal: /private/path",
      "push-refused",
    ],
    ["The history of R1 does not provably follow its last push", "history"],
    [
      "The task has delivery actions whose outcome is not settled",
      "delivery-unsettled",
    ],
    ["Workspace has unfinished maintenance", "maintenance-held"],
    ["Archived projects are read-only", "project-read-only"],
    ["git: /secret/stderr", "refused"],
  ] as const)
    assert.equal(maintenanceReason(text), code, text);
});

test("the worker measures allocated bytes without following links or counting a hard link twice", async () => {
  const root = mkdtempSync(join(tmpdir(), "cab-maintenance-measure-"));
  try {
    const workspace = join(root, "workspace"),
      outside = join(root, "outside");
    mkdirSync(join(workspace, "repo-1"), { recursive: true });
    mkdirSync(outside);
    writeFileSync(join(outside, "big.bin"), Buffer.alloc(4 * 1024 * 1024, 1));
    writeFileSync(
      join(workspace, "repo-1", "file.bin"),
      Buffer.alloc(256 * 1024, 1),
    );
    linkSync(
      join(workspace, "repo-1", "file.bin"),
      join(workspace, "link.bin"),
    );
    symlinkSync(outside, join(workspace, "outside-link"));
    const sparse = join(workspace, "sparse.bin");
    writeFileSync(sparse, "");
    truncateSync(sparse, 512 * 1024 * 1024);
    const base = claudeTemporaryBase(workspace);
    mkdirSync(base);
    writeFileSync(join(base, "tmp.bin"), Buffer.alloc(128 * 1024, 1));
    const allocated = (...paths: string[]) =>
      paths.reduce((sum, p) => sum + lstatSync(p).blocks * 512, 0);
    const expected = allocated(
      workspace,
      join(workspace, "repo-1"),
      join(workspace, "repo-1", "file.bin"),
      join(workspace, "outside-link"),
      sparse,
      base,
      join(base, "tmp.bin"),
    );
    const sizes = await measureInWorker(
      [
        {
          key: "a",
          paths: [
            { path: workspace, optional: false },
            { path: base, optional: true },
          ],
        },
        // A second root reaching the same inode adds nothing.
        {
          key: "b",
          paths: [{ path: join(workspace, "link.bin"), optional: false }],
        },
        {
          key: "missing",
          paths: [{ path: join(root, "gone"), optional: false }],
        },
        {
          key: "no-base",
          paths: [
            { path: outside, optional: false },
            { path: join(root, "no-base"), optional: true },
          ],
        },
      ],
      new AbortController().signal,
    );
    assert.equal(sizes.get("a"), expected);
    assert.ok(
      expected < 64 * 1024 * 1024,
      "the sparse file counts its allocation only",
    );
    assert.equal(sizes.get("b"), 0);
    assert.equal(
      sizes.get("missing"),
      null,
      "a missing root is unknown, never zero",
    );
    assert.equal(
      sizes.get("no-base"),
      allocated(outside, join(outside, "big.bin")),
    );
    // An unreadable directory makes its root unknown.
    const locked = join(root, "locked");
    mkdirSync(join(locked, "inner"), { recursive: true });
    chmodSync(join(locked, "inner"), 0);
    try {
      const unreadable = await measureInWorker(
        [{ key: "locked", paths: [{ path: locked, optional: false }] }],
        new AbortController().signal,
      );
      assert.equal(unreadable.get("locked"), null);
    } finally {
      chmodSync(join(locked, "inner"), 0o700);
    }
    // Cancellation terminates the worker and rejects.
    const abort = new AbortController();
    const pending = measureInWorker(
      [{ key: "a", paths: [{ path: workspace, optional: false }] }],
      abort.signal,
    );
    abort.abort(new Error("cancelled"));
    await assert.rejects(pending, /cancelled/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** A held promise: the test decides when it settles. */
const gate = () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { held, release };
};

/**
 * A real service whose maintenance runs only when the test wakes it, on a test clock offset from
 * real time (persisted anchors are real wall times), with sizes from a table unless measured.
 */
async function serviceWorld(
  t: TestContext,
  options: {
    settings?: StandaloneServiceOptions["workspaceMaintenance"];
    measure?: NonNullable<
      StandaloneServiceOptions["maintenancePass"]
    >["measure"];
    service?: StandaloneServiceOptions;
  } = {},
) {
  const clock = { offset: 0 };
  const sizes = new Map<string, number | null>();
  let measures = 0;
  const f = await createOperatorFixture(
    null,
    undefined,
    undefined,
    {},
    undefined,
    {
      ...options.service,
      workspaceMaintenance: { idleHours: "off", ...options.settings },
      maintenancePass: {
        now: () => Date.now() + clock.offset,
        every: () => () => {},
        measure:
          options.measure ??
          (async (roots) => {
            measures++;
            return new Map(
              roots.map((r) => [
                r.key,
                sizes.has(r.key) ? sizes.get(r.key)! : 0,
              ]),
            );
          }),
      },
    },
  );
  t.after(() => f.close());
  const domain = f.service.domain();
  const projectId = randomUUID();
  domain.execute({
    type: "project.create",
    actor: "operator",
    key: randomUUID(),
    projectId,
    name: "Maintenance",
    leadProfileId: null,
  });
  const task = async (title = "Maintained task") => {
    const taskId = randomUUID();
    domain.execute({
      type: "task.create",
      actor: "operator",
      key: randomUUID(),
      projectId,
      taskId,
      title,
      outcome: "O",
    });
    const binding = await f.service.provisionTask(taskId, []);
    assert.equal(binding.state, "ready", binding.reason ?? "");
    return { taskId, binding };
  };
  const lifecycle = () =>
    // biome-ignore lint/complexity/useLiteralKeys: the service's own database
    new WorkspaceLifecycleStore(f.service["cache"]!);
  const turnEnded = (
    binding: { taskId: string; workspaceId: string },
    at: number,
  ) =>
    lifecycle().observe(binding, {
      kind: "turn-ended",
      eventId: `turn-ended:${randomUUID()}`,
      at,
      workId: randomUUID(),
      turnId: randomUUID(),
    });
  // Rebuilt per call: a restart replaces the fixture's service.
  const api = () => new OperatorApi(f.service, [f.directory]);
  const maintenanceItems = async (params = new URLSearchParams()) =>
    (await api().readInbox(params)).data.items.filter(
      (i) => i.kind === "workspace-maintenance",
    );
  return {
    f,
    clock,
    sizes,
    measures: () => measures,
    domain,
    projectId,
    task,
    lifecycle,
    turnEnded,
    api,
    maintenanceItems,
    pass: () => f.service.runWorkspaceMaintenance(),
    writerHold: (taskId: string) =>
      f.seedPersistedState((db) =>
        db
          .prepare(
            "INSERT INTO task_writer_holds (taskId, reason) VALUES (?, ?)",
          )
          .run(taskId, "writer"),
      ),
    releaseWriterHold: (taskId: string) =>
      f.seedPersistedState((db) =>
        db.prepare("DELETE FROM task_writer_holds WHERE taskId=?").run(taskId),
      ),
  };
}

test("an expired cancelled workspace with nothing pushed is removed by the pass, at its terminal time plus 24 hours", async (t) => {
  const w = await serviceWorld(t);
  const { taskId, binding } = await w.task();
  finishTask(w.f.service, taskId, "cancelled");
  const terminalAt = w.lifecycle().current(taskId)!.terminal!.at;
  w.clock.offset = terminalAt + 24 * H - 1 - Date.now();
  await w.pass();
  assert.equal(existsSync(binding.path), true);
  w.clock.offset = terminalAt + 24 * H - Date.now();
  const report = await w.pass();
  assert.deepEqual(report?.removed, [
    { workspaceId: binding.workspaceId, trigger: "delivered" },
  ]);
  assert.equal(existsSync(binding.path), false);
  const records = w.f.service.taskWorkspaceRecords(taskId);
  assert.equal(records.binding?.state, "archived");
  assert.equal(records.removal?.trigger, "delivered");
  assert.deepEqual(await w.maintenanceItems(), []);
});

test("ordinary pushes restart the delivered clock; a removal's push does not; partial merges never count as merged", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "cab-maintenance-repos-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (cwd: string, ...args: string[]) =>
    execFileSync(
      "git",
      [
        "-C",
        cwd,
        "-c",
        "user.name=M",
        "-c",
        "user.email=m@example.invalid",
        ...args,
      ],
      {
        encoding: "utf8",
        env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" },
      },
    ).trim();
  const sources = ["R1", "R2"].map((id) => {
    const source = join(root, id);
    mkdirSync(source);
    git(source, "init", "--quiet", "--initial-branch=main");
    writeFileSync(join(source, "README.md"), `${id}\n`);
    git(source, "add", ".");
    git(source, "commit", "--quiet", "-m", "base");
    return { repositoryId: id, path: source, ref: "main" };
  });
  const w = await serviceWorld(t);
  const domain = w.domain;
  const provision = async () => {
    const taskId = randomUUID();
    domain.execute({
      type: "task.create",
      actor: "operator",
      key: randomUUID(),
      projectId: w.projectId,
      taskId,
      title: "Two repositories",
      outcome: "O",
    });
    const binding = await w.f.service.provisionTask(taskId, sources);
    assert.equal(binding.state, "ready", binding.reason ?? "");
    finishTask(w.f.service, taskId);
    return { taskId, binding };
  };
  const candidates = (): MaintenanceCandidate[] =>
    // biome-ignore lint/complexity/useLiteralKeys: the derivation under test
    w.f.service["maintenanceCandidates"]();
  const of = (workspaceId: string) =>
    candidates().find((c) => c.workspaceId === workspaceId)!;
  const commit = "a".repeat(40);
  const ordinary = await provision();
  const t0 = w.lifecycle().current(ordinary.taskId)!.terminal!.at;
  w.lifecycle().observe(ordinary.binding, {
    kind: "push",
    eventId: `push:${randomUUID()}`,
    at: t0 + 10 * H,
    repositoryId: "R1",
    commit,
    removalOperationId: null,
  });
  const cleanup = await provision();
  const t1 = w.lifecycle().current(cleanup.taskId)!.terminal!.at;
  const operationId = randomUUID();
  w.lifecycle().beginOperation(cleanup.binding, {
    operationId,
    kind: "remove",
    trigger: "delivered",
    startedAt: t1,
  });
  w.lifecycle().refuseOperation(cleanup.binding, operationId, "test refusal");
  w.lifecycle().recordRemovalPush(
    { ...cleanup.binding, removalOperationId: operationId },
    "R1",
    randomUUID(),
    commit,
    t1 + 10 * H,
  );
  const s = settings();
  assert.equal(of(ordinary.binding.workspaceId).lastPushAt, t0 + 10 * H);
  assert.equal(
    retentionDue(of(ordinary.binding.workspaceId), s, t0 + 24 * H),
    null,
  );
  assert.equal(of(cleanup.binding.workspaceId).lastPushAt, null);
  assert.equal(
    (
      retentionDue(of(cleanup.binding.workspaceId), s, t1 + 24 * H) as {
        trigger: string;
      }
    ).trigger,
    "delivered",
  );
  // One repository merged is not all merged; the second completes the episode.
  const merge = (repositoryId: string, merged: boolean, at: number) =>
    w.lifecycle().observe(ordinary.binding, {
      kind: "merge",
      eventId: `merge:${randomUUID()}`,
      at,
      repositoryId,
      changeRequestId: `${repositoryId}-pr`,
      merged,
    });
  merge("R1", true, t0 + 11 * H);
  merge("R2", false, t0 + 11 * H);
  assert.equal(of(ordinary.binding.workspaceId).allMergedAt, null);
  merge("R2", true, t0 + 12 * H);
  assert.equal(of(ordinary.binding.workspaceId).allMergedAt, t0 + 12 * H);
  // Reopening clears the terminal and merge episode; a new turn resets idle trimming.
  finishTask(w.f.service, ordinary.taskId, "open");
  const reopened = of(ordinary.binding.workspaceId);
  assert.equal(reopened.terminal, false);
  assert.equal(reopened.allMergedAt, null);
  assert.equal(retentionDue(reopened, s, t0 + 1_000 * H), null);
});

test("idle trimming at the service records the idle trigger once per turn epoch, across a restart", async (t) => {
  const w = await serviceWorld(t, { settings: { idleHours: 24 } });
  const { taskId, binding } = await w.task();
  writeFileSync(join(binding.path, "scratch", "cache.bin"), "x");
  const ended = Date.now();
  w.turnEnded(binding, ended);
  w.clock.offset = 24 * H - 60_000;
  await w.pass();
  assert.equal(w.f.service.taskWorkspaceRecords(taskId).trim, undefined);
  w.clock.offset = 24 * H + 60_000;
  const report = await w.pass();
  assert.deepEqual(report?.trimmed, [
    { workspaceId: binding.workspaceId, trigger: "idle" },
  ]);
  assert.equal(existsSync(join(binding.path, "scratch", "cache.bin")), false);
  const first = w.f.service.taskWorkspaceRecords(taskId).trim!;
  assert.equal(first.trigger, "idle");
  await w.pass();
  await w.f.reopen();
  await w.pass();
  assert.equal(
    w.f.service.taskWorkspaceRecords(taskId).trim?.operationId,
    first.operationId,
  );
});

test("one Inbox item names cap pressure and a refused expired removal, refreshes, clears, recurs and survives restart", async (t) => {
  const w = await serviceWorld(t, { settings: { diskCapGb: 1 } });
  const open = await w.task("Open and large");
  const held = await w.task("Done but held");
  finishTask(w.f.service, held.taskId);
  w.writerHold(held.taskId);
  w.turnEnded(open.binding, Date.now());
  w.sizes.set(open.binding.workspaceId, 2 * GB);
  w.clock.offset = 25 * H;
  await w.pass();
  let [item] = await w.maintenanceItems();
  assert.ok(item?.kind === "workspace-maintenance");
  assert.equal(item.dismissible, false);
  assert.deepEqual(item.usage, { measuredBytes: 2 * GB, capBytes: GB });
  assert.match(
    item.reason,
    /over the 1\.0 GB disk limit; a workspace past its retention was not removed/,
  );
  assert.deepEqual(
    item.blockers.map((b) => [
      b.taskTitle,
      b.condition,
      b.reason,
      b.destination,
    ]),
    [
      ["Done but held", "retention", "unsettled", `/tasks/${held.taskId}`],
      ["Open and large", "disk-cap", "task-open", `/tasks/${open.taskId}`],
    ],
  );
  assert.equal(JSON.stringify(item).includes(open.binding.path), false);
  // Exactly one item; a project filter excludes it, the kind filter selects it.
  assert.equal((await w.maintenanceItems()).length, 1);
  assert.deepEqual(
    await w.maintenanceItems(new URLSearchParams({ project: w.projectId })),
    [],
  );
  assert.equal(
    (
      await w
        .api()
        .readInbox(new URLSearchParams({ kind: "workspace-maintenance" }))
    ).data.items.length,
    1,
  );
  await assert.rejects(
    w.api().execute({
      type: "inbox.dismiss",
      key: randomUUID(),
      itemId: item.id,
      expectedRevision: item.lifecycle!.revision,
    }),
  );
  const createdAt = item.createdAt;
  // A refresh with a changed reason keeps the same item and episode.
  w.sizes.set(open.binding.workspaceId, 0);
  // Past the measurement reuse and refusal back-off windows.
  w.clock.offset += 16 * 60_000;
  await w.pass();
  [item] = await w.maintenanceItems();
  assert.ok(item?.kind === "workspace-maintenance");
  assert.equal(item.usage, null);
  assert.equal(item.createdAt, createdAt);
  assert.deepEqual(
    item.blockers.map((b) => b.taskTitle),
    ["Done but held"],
  );
  // Restart keeps it until the next pass decides.
  await w.f.reopen();
  assert.equal((await w.maintenanceItems()).length, 1);
  // Both conditions clear: the item resolves.
  w.releaseWriterHold(held.taskId);
  // The start-up pass refused it again; wait out that refusal's back-off.
  w.clock.offset += 6 * 60_000;
  await w.pass();
  assert.deepEqual(await w.maintenanceItems(), []);
  const resolved = await w.maintenanceItems(
    new URLSearchParams({ status: "resolved" }),
  );
  assert.equal(resolved.length, 1);
  // A recurrence reactivates the same item as a new episode.
  w.sizes.set(open.binding.workspaceId, 3 * GB);
  w.clock.offset += 16 * 60_000;
  await w.pass();
  [item] = await w.maintenanceItems();
  assert.equal(item?.id, resolved[0]!.id);
  assert.ok(item!.createdAt > createdAt);
  // A blocker in an archived project keeps a named read-only reason.
  w.f.seedPersistedState((db) =>
    db
      .prepare("UPDATE domain_projects SET archived=1 WHERE id=?")
      .run(w.projectId),
  );
  await w.pass();
  [item] = await w.maintenanceItems();
  assert.ok(item?.kind === "workspace-maintenance");
  assert.deepEqual(
    item.blockers.map((b) => b.reason),
    ["project-read-only"],
  );
});

test("coordination progresses while maintenance is stalled in its worker measurement, and new tasks never wait", async (t) => {
  const held = gate();
  let entered!: () => void;
  const measuring = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const w = await serviceWorld(t, {
    measure: async (roots, signal) => {
      entered();
      await held.held;
      return measureInWorker(roots, signal);
    },
  });
  const { binding } = await w.task("Measured");
  const pass = w.pass();
  await measuring;
  const web = await w.f.startWeb();
  t.after(() => web.close());
  // While the pass is held: a scheduler wake, an authenticated read and a new task's workspace.
  let response = await fetch(`${web.origin}/api/operator/session`);
  let cookie = response.headers.get("set-cookie")?.split(";")[0] ?? "";
  let session = (await response.json()) as { csrfToken: string };
  response = await fetch(`${web.origin}/api/operator/login`, {
    method: "POST",
    headers: {
      cookie,
      origin: web.origin,
      "x-csrf-token": session.csrfToken,
      "content-type": "application/json",
    },
    body: JSON.stringify({ password: web.password }),
  });
  assert.equal(response.status, 200);
  cookie = response.headers.get("set-cookie")?.split(";")[0] ?? "";
  session = (await response.json()) as { csrfToken: string };
  const read = await fetch(`${web.origin}/api/operator/inbox`, {
    headers: { cookie },
  });
  assert.equal(read.status, 200);
  // biome-ignore lint/complexity/useLiteralKeys: the scheduler wake under test
  await w.f.service["wakeScheduler"]();
  const admitted = await w.task("Admitted during the pass");
  assert.equal(admitted.binding.state, "ready");
  let settled = false;
  void pass.then(() => {
    settled = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false, "the pass is still held");
  held.release();
  const report = await pass;
  assert.equal(report?.usage, null);
  assert.equal(existsSync(binding.path), true);
});

test("coordination progresses while a maintenance trim's Git child is stalled", {
  skip: processIdentityDenied(),
}, async (t) => {
  const controlled = controlledGit();
  t.after(() => controlled.cleanup());
  const repoRoot = mkdtempSync(join(tmpdir(), "cab-maintenance-git-"));
  t.after(() => rmSync(repoRoot, { recursive: true, force: true }));
  const source = join(repoRoot, "R1");
  mkdirSync(source);
  const git = (...args: string[]) =>
    execFileSync(
      "git",
      [
        "-C",
        source,
        "-c",
        "user.name=M",
        "-c",
        "user.email=m@example.invalid",
        ...args,
      ],
      {
        env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" },
      },
    );
  git("init", "--quiet", "--initial-branch=main");
  writeFileSync(join(source, "README.md"), "R1\n");
  git("add", ".");
  git("commit", "--quiet", "-m", "base");
  const w = await serviceWorld(t, {
    settings: { idleHours: 24 },
    service: {
      workspaceManager: {
        gitExecutable: controlled.executable,
        gitTimeoutMs: { "trim-scan": 2_000 },
        gitTerminationGraceMs: 50,
        gitTerminationObservationMs: 40,
      },
    },
  });
  const taskId = randomUUID();
  w.domain.execute({
    type: "task.create",
    actor: "operator",
    key: randomUUID(),
    projectId: w.projectId,
    taskId,
    title: "Stalled trim",
    outcome: "O",
  });
  const binding = await w.f.service.provisionTask(taskId, [
    { repositoryId: "R1", path: source, ref: "main" },
  ]);
  assert.equal(binding.state, "ready", binding.reason ?? "");
  w.turnEnded(binding, Date.now());
  w.clock.offset = 25 * H;
  controlled.setRule({
    commandPrefix: "--no-optional-locks status",
    behavior: "stall",
  });
  const pass = w.pass();
  const started = Date.now();
  while (
    !controlled
      .events()
      .some((e) => e.event === "start" && e.command?.includes("status"))
  ) {
    assert.ok(Date.now() - started < 10_000, "the trim's Git child started");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  // The Git child is held: an Inbox read, a scheduler wake and a new task all complete.
  assert.equal((await w.api().readInbox()).data.complete, true);
  // biome-ignore lint/complexity/useLiteralKeys: the scheduler wake under test
  await w.f.service["wakeScheduler"]();
  const other = await w.task("Admitted during the stalled trim");
  assert.equal(other.binding.state, "ready");
  controlled.setRule(undefined);
  // The pass ends once the stalled child is settled, either way.
  assert.ok(await pass);
});

test("final service checks refuse what a stale snapshot chose: a reopened task and a swapped root", async (t) => {
  let hook: (() => void) | undefined;
  const w = await serviceWorld(t, {
    settings: { diskCapGb: 1 },
  });
  const reopened = await w.task("Reopened during the pass");
  const swapped = await w.task("Swapped during the pass");
  for (const task of [reopened, swapped]) {
    finishTask(w.f.service, task.taskId);
    w.turnEnded(task.binding, Date.now());
    w.sizes.set(task.binding.workspaceId, GB);
  }
  const outside = mkdtempSync(join(tmpdir(), "cab-maintenance-outside-"));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  writeFileSync(join(outside, "sentinel"), "keep");
  // biome-ignore lint/complexity/useLiteralKeys: wrap the advisory candidate snapshot
  const original = w.f.service["maintenanceCandidates"].bind(w.f.service);
  // biome-ignore lint/complexity/useLiteralKeys: wrap the advisory candidate snapshot
  w.f.service["maintenanceCandidates"] = () => {
    const snapshot = original();
    hook?.();
    hook = undefined;
    return snapshot;
  };
  hook = () => {
    // After the snapshot: one task is reopened and admitted work may start; the other's root
    // becomes a link to an outside directory.
    finishTask(w.f.service, reopened.taskId, "open");
    renameSync(swapped.binding.path, `${swapped.binding.path}.moved`);
    symlinkSync(outside, swapped.binding.path);
  };
  const report = await w.pass();
  assert.deepEqual(report?.removed, []);
  assert.equal(existsSync(reopened.binding.path), true);
  assert.equal(existsSync(join(outside, "sentinel")), true);
  assert.equal(existsSync(`${swapped.binding.path}.moved`), true);
});

test("shutdown cancels a measurement in flight and closes the database after the pass drains", async (t) => {
  let aborted = false;
  let entered!: () => void;
  const measuring = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const w = await serviceWorld(t, {
    measure: (_roots, signal) =>
      new Promise((_, reject) => {
        entered();
        signal.addEventListener("abort", () => {
          aborted = true;
          reject(signal.reason);
        });
      }),
  });
  await w.task();
  const pass = w.pass();
  await measuring;
  await w.f.service.stop();
  assert.equal(aborted, true);
  assert.equal(await pass, undefined);
  // Nothing late reaches the closed database, and a stopped service runs no pass.
  assert.equal(await w.f.service.runWorkspaceMaintenance(), undefined);
});

test("after a restart an unmeasurable root keeps the active item instead of resolving it", async (t) => {
  const w = await serviceWorld(t, { settings: { diskCapGb: 1 } });
  const { binding } = await w.task("Unmeasurable");
  w.turnEnded(binding, Date.now());
  w.sizes.set(binding.workspaceId, 2 * GB);
  await w.pass();
  assert.equal((await w.maintenanceItems()).length, 1);
  // The root can no longer be measured, and the service restarts: memory of the cap is gone.
  w.sizes.set(binding.workspaceId, null);
  await w.f.reopen();
  await w.pass();
  const [item] = await w.maintenanceItems();
  assert.ok(item?.kind === "workspace-maintenance");
  assert.equal(item.usage, null);
  assert.deepEqual(
    item.blockers.map((b) => [b.workspaceId, b.reason]),
    [[binding.workspaceId, "unmeasured"]],
  );
  assert.equal(
    item.reason,
    "The disk usage of some workspaces could not be measured, so the disk limit is unconfirmed.",
  );
});

test("a refused push is attempted once across passes on unchanged facts, with one operation row", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "cab-maintenance-push-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (cwd: string, ...args: string[]) =>
    execFileSync(
      "git",
      [
        "-C",
        cwd,
        "-c",
        "user.name=M",
        "-c",
        "user.email=m@example.invalid",
        ...args,
      ],
      {
        encoding: "utf8",
        env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" },
      },
    ).trim();
  const source = join(root, "R1");
  mkdirSync(source);
  git(source, "init", "--quiet", "--initial-branch=main");
  writeFileSync(join(source, "README.md"), "R1\n");
  git(source, "add", ".");
  git(source, "commit", "--quiet", "-m", "base");
  const w = await serviceWorld(t, { settings: { diskCapGb: "off" } });
  const taskId = randomUUID();
  w.domain.execute({
    type: "task.create",
    actor: "operator",
    key: randomUUID(),
    projectId: w.projectId,
    taskId,
    title: "Unpushed work",
    outcome: "O",
  });
  const binding = await w.f.service.provisionTask(taskId, [
    { repositoryId: "R1", path: source, ref: "main" },
  ]);
  assert.equal(binding.state, "ready", binding.reason ?? "");
  const worktree = binding.repositories[0]!.workspacePath;
  writeFileSync(join(worktree, "work.txt"), "committed, not pushed\n");
  git(worktree, "add", "work.txt");
  git(worktree, "commit", "--quiet", "-m", "work");
  finishTask(w.f.service, taskId);
  const operations = () =>
    // biome-ignore lint/complexity/useLiteralKeys: the service's own database
    w.f.service["cache"]!.prepare(
      "SELECT count(*) AS n FROM workspace_maintenance_operations WHERE workspaceId=?",
    ).get(binding.workspaceId) as { n: number };
  w.clock.offset = 25 * H;
  for (let pass = 0; pass < 3; pass++) {
    await w.pass();
    w.clock.offset += 60_000;
  }
  assert.equal(operations().n, 1);
  const [item] = await w.maintenanceItems();
  assert.ok(item?.kind === "workspace-maintenance");
  assert.deepEqual(
    item.blockers.map((b) => [b.condition, b.reason]),
    [["retention", "push-refused"]],
  );
  assert.equal(existsSync(worktree), true);
});

test("the measurement walk runs in the worker: the main thread never stats and keeps serving timers", async () => {
  const root = mkdtempSync(join(tmpdir(), "cab-maintenance-offloop-"));
  const fs = (await import("node:fs")).default;
  const { syncBuiltinESMExports } = await import("node:module");
  const original = fs.lstatSync;
  try {
    for (let d = 0; d < 40; d++) {
      mkdirSync(join(root, `d${d}`));
      for (let f = 0; f < 100; f++)
        writeFileSync(join(root, `d${d}`, `f${f}`), "x");
    }
    let mainStats = 0;
    fs.lstatSync = ((...args: Parameters<typeof original>) => {
      mainStats++;
      return original(...args);
    }) as typeof original;
    syncBuiltinESMExports();
    let ticks = 0;
    const timer = setInterval(() => ticks++, 1);
    const sizes = await measureInWorker(
      [{ key: "tree", paths: [{ path: root, optional: false }] }],
      new AbortController().signal,
    );
    clearInterval(timer);
    assert.ok((sizes.get("tree") ?? 0) > 0);
    assert.equal(mainStats, 0, "no lstat on the main thread");
    assert.ok(ticks > 0, "timers ran while the worker walked 4000 files");
  } finally {
    fs.lstatSync = original;
    syncBuiltinESMExports();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a trim interrupted by a crash keeps no hold after restart, and the workspace can be trimmed and removed", async (t) => {
  const w = await serviceWorld(t);
  const { taskId, binding } = await w.task("Crashed trim");
  writeFileSync(join(binding.path, "scratch", "cache.bin"), "x");
  // A trim had begun its first effect when the process died, holding the archival lease.
  const operationId = randomUUID();
  w.lifecycle().beginOperation(binding, {
    operationId,
    kind: "trim",
    trigger: "idle",
    startedAt: Date.now(),
  });
  w.lifecycle().startEffect(binding, operationId, {
    effectId: randomUUID(),
    target: { kind: "scratch" },
    startedAt: Date.now(),
  });
  assert.equal(
    startedOf(w.f.service).state.beginArchive(taskId, operationId),
    true,
  );
  await w.f.reopen();
  const state = startedOf(w.f.service).state;
  // The open task is admissible again: no archival hold, no task hold reason.
  assert.equal(state.isArchiveHeld(taskId), false);
  assert.equal(
    w.lifecycle().operation(binding, operationId).state,
    "held",
    "the journal still records that it did not finish",
  );
  const trimmed = await w.f.service.trimTaskWorkspace(taskId, "manual");
  assert.equal(trimmed.outcome, "trimmed", JSON.stringify(trimmed));
  assert.equal(existsSync(join(binding.path, "scratch", "cache.bin")), false);
  finishTask(w.f.service, taskId);
  const removed = await w.f.service.removeTaskWorkspace(taskId, "manual");
  assert.equal(removed.outcome, "cleaned", JSON.stringify(removed));
  assert.equal(existsSync(binding.path), false);
});

test("a trim held by unreadable scratch blocks nothing: once fixed it trims, and the workspace is removed", async (t) => {
  const w = await serviceWorld(t);
  const { taskId, binding } = await w.task("Read-only scratch");
  const locked = join(binding.path, "scratch", "locked");
  mkdirSync(locked);
  writeFileSync(join(locked, "file"), "x");
  chmodSync(locked, 0o555);
  // Restored for cleanup if the test stops before it does; removal deletes the path.
  t.after(() => {
    if (existsSync(locked)) chmodSync(locked, 0o755);
  });
  const held = await w.f.service.trimTaskWorkspace(taskId, "manual");
  assert.equal(held.outcome, "held", JSON.stringify(held));
  assert.equal(startedOf(w.f.service).state.isArchiveHeld(taskId), false);
  chmodSync(locked, 0o755);
  const trimmed = await w.f.service.trimTaskWorkspace(taskId, "manual");
  assert.equal(trimmed.outcome, "trimmed", JSON.stringify(trimmed));
  finishTask(w.f.service, taskId);
  const removed = await w.f.service.removeTaskWorkspace(taskId, "manual");
  assert.equal(removed.outcome, "cleaned", JSON.stringify(removed));
});
