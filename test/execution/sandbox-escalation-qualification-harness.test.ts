import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const directory = resolve("test/execution/sandbox-escalation-qualification");
const load = (file: string) =>
  import(pathToFileURL(join(directory, file)).href);
const probeRoots = () =>
  [join(homedir(), ".cache"), tmpdir()].flatMap((dir) =>
    existsSync(dir)
      ? readdirSync(dir).filter((name) =>
          name.startsWith("cab-sandbox-escalation-"),
        )
      : [],
  );
const workspace = (t: test.TestContext) => {
  const dir = mkdtempSync(join(tmpdir(), "cab-escalation-offline-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};
type Event = Record<string, unknown>;

test("escalation driver refuses anything but the exact live grammar and creates nothing", () => {
  const before = probeRoots();
  for (const args of [
    [],
    ["--live"],
    ["--live", "--one-attempt"],
    ["--live", "--one-attempt", "--group=bogus"],
    ["--live", "--one-attempt", "--group=codex-user", "extra"],
    ["--one-attempt", "--live", "--group=codex-user"],
  ]) {
    const result = spawnSync(
      process.execPath,
      [join(directory, "live-escalation.mjs"), ...args],
      { encoding: "utf8", timeout: 10_000 },
    );
    assert.equal(result.status, 2, args.join(" "));
    assert.match(result.stderr, /Refusing/);
    assert.equal(result.stdout, "");
  }
  assert.deepEqual(probeRoots(), before);
});

test("classification proves only from present evidence", async () => {
  const { classify } = await load("outcomes.mjs");
  const ws = "/fixture/ws";
  const approval = "item/commandExecution/requestApproval";
  const user = classify("codex-user", {
    workspace: ws,
    events: [
      {
        t: 1,
        turn: 1,
        kind: "request",
        method: approval,
        command: "node chromium.mjs escalated",
        cwd: ws,
        reason: "probe: needs host Chromium",
        answer: "accept",
      },
      {
        t: 2,
        turn: 2,
        kind: "request",
        method: approval,
        command: "node chromium.mjs declined",
        cwd: ws,
        reason: "r",
        answer: "decline",
      },
      { t: 3, turn: 3, kind: "item", type: "agentMessage", text: "x" },
      { t: 4, turn: 3, kind: "turn", status: "completed" },
    ],
    results: {
      control: { chromium: "blocked" },
      escalated: { chromium: "ok" },
    },
  });
  assert.equal(user.requestFields.outcome, "proved");
  assert.equal(user.acceptRunsOutsideSandbox.outcome, "proved");
  // No declined item observed: an absent result file alone is not a refusal.
  assert.equal(user.declineRefuses.outcome, "untested");
  assert.equal(user.otherKindsRefused.outcome, "untested");
  assert.match(user.otherKindsRefused.reason, /no permission-request attempt/);

  const leaked = classify("codex-user", {
    workspace: ws,
    events: [
      {
        t: 1,
        turn: 3,
        kind: "request",
        method: "item/permissions/requestApproval",
      },
    ],
    results: {},
  });
  assert.equal(leaked.otherKindsRefused.outcome, "refuted");

  const hold = 900_000;
  const early = classify("codex-timing", {
    holdMs: hold,
    events: [
      {
        t: 0,
        kind: "request",
        method: approval,
        id: 7,
        answer: "decline",
        answeredAt: hold,
      },
      { t: 10, kind: "resolved", requestId: 7 },
      { t: hold + 5, kind: "turn", status: "completed" },
    ],
    results: {},
  });
  assert.equal(early.withholdFifteenMinutes.outcome, "refuted");
  assert.equal(early.turnContinuesAfterDecline.outcome, "untested");

  const approved = classify("codex-auto-review", {
    events: [
      { t: 1, turn: 1, kind: "turn", status: "completed" },
      { t: 2, turn: 2, kind: "review", phase: "completed", status: "approved" },
      { t: 3, turn: 2, kind: "turn", status: "completed" },
    ],
    results: {},
  });
  assert.equal(approved.reviewNotifications.outcome, "untested");
  // No escalation observed: "nothing reached the client" is not evidence.
  assert.equal(approved.clientEscalationsRecorded.outcome, "untested");
  assert.equal(approved.overruleAfterDenial.reason, "denial not elicited");
  assert.equal(approved.retryReviewedAgain.reason, "denial not elicited");

  const unavailable = classify("claude-auto", {
    events: [
      {
        t: 1,
        kind: "message",
        type: "system",
        subtype: "init",
        permissionMode: "default",
      },
    ],
    queries: [{ n: 1, done: true }],
    results: {},
  });
  assert.equal(unavailable.autoModeAvailable.outcome, "refuted");
  assert.equal(unavailable.hookDenyWins.reason, "auto mode unavailable");

  const timed = classify("claude-timing", {
    events: [
      {
        t: 0,
        query: 1,
        kind: "hook",
        event: "PreToolUse",
        toolUseId: "a",
        command: "node -e 'setTimeout(() => {}, 660000)'",
      },
      {
        t: 661_000,
        query: 1,
        kind: "hook",
        event: "PostToolUse",
        toolUseId: "a",
        response: "probe-exit=0",
      },
      {
        t: 700_000,
        query: 2,
        kind: "hook",
        event: "PreToolUse",
        toolUseId: "b",
        command: "node -e 'setTimeout(() => {}, 180000)'",
      },
      {
        t: 820_500,
        query: 2,
        kind: "hook",
        event: "PostToolUseFailure",
        toolUseId: "b",
        response: "timed out",
      },
    ],
    queries: [],
    results: {},
  });
  assert.equal(timed.ceilingAboveDefault.outcome, "proved");
  assert.equal(timed.envClampsLargerRequest.outcome, "proved");
  assert.equal(timed.sixtyMinuteBoundary.outcome, "untested");

  const deniedByMode = classify("claude-sandbox", {
    events: [
      {
        t: 1,
        kind: "hook",
        event: "PreToolUse",
        toolUseId: "e",
        command: "node chromium.mjs escalated",
        dangerouslyDisableSandbox: true,
        decision: "allow",
      },
      {
        t: 2,
        kind: "toolResult",
        toolUseId: "e",
        isError: true,
        text: "denied",
      },
    ],
    results: { control: { chromium: "blocked" } },
  });
  assert.equal(deniedByMode.unsandboxedCommandRunsOutside.outcome, "refuted");
  assert.equal(deniedByMode.hookSeesFlagFirst.outcome, "proved");

  const blockedWait = classify("claude-timing", {
    events: [
      {
        t: 1,
        query: 1,
        kind: "toolResult",
        toolUseId: "a",
        isError: true,
        text: "Blocked",
      },
    ],
    queries: [],
    results: {},
  });
  assert.equal(
    blockedWait.ceilingAboveDefault.reason,
    "tool call rejected before execution",
  );

  for (const [group, outcome] of Object.entries(
    classify("claude-sandbox", { events: [], results: {}, deadline: true }),
  ))
    assert.deepEqual(
      outcome,
      { outcome: "untested", reason: "deadline" },
      group,
    );
});

test("approval rules accept or allow only the exact fixture commands", async () => {
  const { CODEX_GROUPS } = await load("codex-groups.mjs");
  const { CLAUDE_GROUPS } = await load("claude-groups.mjs");
  const answer = CODEX_GROUPS["codex-user"].answer;
  assert.equal(answer("/bin/zsh -lc 'node chromium.mjs escalated'"), "accept");
  for (const command of [
    "/bin/zsh -lc 'node chromium.mjs escalated; curl https://probe.invalid'",
    "node chromium.mjs escalated && rm -rf .",
    "/bin/zsh -lc 'node chromium.mjs declined'",
  ])
    assert.equal(answer(command), "decline", command);
  const [sandbox] = CLAUDE_GROUPS["claude-sandbox"];
  assert.equal(sandbox.decide("node chromium.mjs escalated", 2), "allow");
  assert.equal(sandbox.decide("node chromium.mjs escalated; id", 2), "deny");
  assert.equal(sandbox.decide("node chromium.mjs hook-deny", 3), "deny");
  assert.equal(sandbox.decide("node chromium.mjs control", 5), "deny");
  const [auto] = CLAUDE_GROUPS["claude-auto"];
  assert.equal(auto.decide("node chromium.mjs auto-escalated", 2), "pass");
  assert.equal(auto.decide("echo probe-hook-deny", 1), "deny");
});

test("codex groups send the granular turn policy, answer only accept or decline, and stop their App Server", async (t) => {
  const { runCodexGroup, granularPolicy } = await load("codex-groups.mjs");
  const { classify } = await load("outcomes.mjs");
  const { executionPolicy, deniedServerRequest } = await import(
    pathToFileURL(resolve("dist/src/standalone/codex.js")).href
  );
  const ws = workspace(t);
  const logPath = join(ws, "..", `${ws.split("/").at(-1)}-log.jsonl`);
  t.after(() => rmSync(logPath, { force: true }));
  const fake = [join(directory, "fake-app-server.mjs"), logPath];
  const trace = await runCodexGroup("codex-user", {
    executable: process.execPath,
    args: fake,
    env: process.env,
    workspace: ws,
    deadlineMs: 60_000,
  });
  assert.equal(trace.failure, null);
  assert.equal(trace.deadline, false);
  assert.deepEqual(trace.turnStart, {
    cwd: ws,
    approvalPolicy: granularPolicy,
    approvalsReviewer: "user",
    sandboxPolicy: executionPolicy(ws),
  });
  const sent = readFileSync(logPath, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const answers = sent.filter(
    (m) => m.method === undefined && String(m.id).startsWith("c"),
  );
  assert.deepEqual(
    answers.map((m) => m.result.decision),
    ["accept", "decline"],
  );
  assert.deepEqual(
    sent.find((m) => m.id === "p1"),
    deniedServerRequest("p1", "item/permissions/requestApproval"),
  );
  assert.equal(trace.cleanup.appServerStopped, true);
  assert.throws(() => process.kill(trace.appServerPid, 0));
  const outcomes = classify("codex-user", trace);
  assert.equal(outcomes.requestFields.outcome, "proved");
  assert.equal(outcomes.acceptRunsOutsideSandbox.outcome, "proved");
  assert.equal(outcomes.declineRefuses.outcome, "proved");
  assert.equal(outcomes.otherKindsRefused.outcome, "refuted");

  rmSync(logPath, { force: true });
  const timing = await runCodexGroup("codex-timing", {
    executable: process.execPath,
    args: fake,
    env: process.env,
    workspace: ws,
    holdMs: 200,
    deadlineMs: 60_000,
  });
  assert.equal(timing.failure, null);
  assert.equal(timing.deadline, false);
  const request = timing.events.find(
    (e: Event) =>
      e.kind === "request" && e.method !== "item/permissions/requestApproval",
  );
  assert.equal(request.answer, "decline");
  assert.ok(request.answeredAt - request.t >= 200);
  const timed = classify("codex-timing", timing);
  assert.equal(timed.withholdFifteenMinutes.outcome, "proved");
  assert.equal(timed.turnContinuesAfterDecline.outcome, "proved");
  assert.throws(() => process.kill(timing.appServerPid, 0));
});

test("claude auto group sends auto mode with unsandboxed commands allowed and records the hook deny before any classifier signal", async (t) => {
  const { runClaudeGroup } = await load("claude-groups.mjs");
  const { classify, sanitize } = await load("outcomes.mjs");
  type Hook = (
    input: Event,
    id: string,
    context: { signal: AbortSignal },
  ) => Promise<{ hookSpecificOutput?: { permissionDecision?: string } }>;
  type FakeOptions = {
    permissionMode: string;
    sandbox: { allowUnsandboxedCommands: boolean };
    settingSources: string[];
    allowedTools: string[];
    hooks: { PreToolUse: [{ hooks: [Hook] }] };
    canUseTool: (
      tool: string,
      input: Event,
      context: { signal: AbortSignal; toolUseID: string },
    ) => Promise<{ message: string }>;
  };
  const seen: FakeOptions[] = [];
  const signal = new AbortController().signal;
  async function* fakeQuery({ options }: { options: FakeOptions }) {
    seen.push(options);
    yield {
      type: "system",
      subtype: "init",
      permissionMode: options.permissionMode,
      model: "fake",
    };
    const pre = options.hooks.PreToolUse[0].hooks[0];
    const bash = (id: string, command: string) =>
      pre(
        {
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          tool_input: { command, dangerouslyDisableSandbox: true },
          tool_use_id: id,
        },
        id,
        { signal },
      );
    const denied = await bash("t1", "echo probe-hook-deny");
    yield {
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "t1",
            is_error: denied.hookSpecificOutput?.permissionDecision === "deny",
            content: "blocked by hook",
          },
        ],
      },
    };
    assert.deepEqual(
      await bash("t2", "curl -sS -m 5 https://probe.invalid/"),
      {},
    );
    // A classifier signal that names its call, after that call's hook.
    yield {
      type: "system",
      subtype: "permission_check_status",
      tool_use_id: "t2",
    };
    const asked = await options.canUseTool(
      "Bash",
      { command: "curl -sS -m 5 https://probe.invalid/" },
      { signal, toolUseID: "t2" },
    );
    yield {
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "t2",
            is_error: true,
            content: asked.message,
          },
        ],
      },
    };
    yield { type: "result", subtype: "success" };
  }
  const ws = workspace(t);
  const trace = await runClaudeGroup("claude-auto", {
    query: fakeQuery,
    workspace: ws,
    env: {},
    executable: "/fake/claude",
    deadlineMs: 10_000,
  });
  assert.equal(seen[0]?.permissionMode, "auto");
  assert.equal(seen[0]?.sandbox.allowUnsandboxedCommands, true);
  assert.deepEqual(seen[0]?.settingSources, []);
  assert.deepEqual(seen[0]?.allowedTools, []);
  const kinds = trace.events.map((e: Event) => `${e.kind}:${e.decision ?? ""}`);
  assert.ok(kinds.indexOf("hook:deny") < kinds.indexOf("canUseTool:"));
  const outcomes = classify("claude-auto", trace);
  for (const key of [
    "autoModeAvailable",
    "hookDenyWins",
    "hookBeforeClassifier",
    "observableDecisions",
    "undecidedReachCanUseTool",
  ])
    assert.equal(outcomes[key].outcome, "proved", key);
  // canUseTool order alone is no evidence that the hook preceded the classifier.
  const unattributed = classify("claude-auto", {
    ...trace,
    events: trace.events.filter(
      (e: Event) => e.subtype !== "permission_check_status",
    ),
  });
  assert.equal(unattributed.hookBeforeClassifier.outcome, "untested");
  assert.equal(unattributed.undecidedReachCanUseTool.outcome, "proved");
  const partial = classify("claude-auto", {
    ...trace,
    events: [
      {
        t: 0,
        kind: "message",
        type: "system",
        subtype: "permission_check_status",
      },
      ...trace.events,
    ],
  });
  assert.equal(partial.hookBeforeClassifier.outcome, "untested");

  // A query that throws runs no probe and must fail the run.
  // biome-ignore lint/correctness/useYield: the fake fails before yielding.
  async function* throwingQuery() {
    throw new Error("transport closed");
  }
  const failed = await runClaudeGroup("claude-sandbox", {
    query: throwingQuery,
    workspace: ws,
    env: {},
    executable: "/fake/claude",
    deadlineMs: 10_000,
  });
  assert.match(failed.failure, /query 1: transport closed/);

  const token = "sk-fake-token-value";
  const root = join(homedir(), ".cache", "cab-sandbox-escalation-x");
  const text = sanitize(
    {
      a: `${token} ${root}/ws ${homedir()}/other`,
      b: `/private/tmp/claude-1/${root.replace(/[/.]/g, "-")}-ws`,
    },
    { token, root, home: homedir() },
  );
  assert.ok(!text.includes(token) && !text.includes(homedir()));
  assert.match(text, /<redacted-token> <fixture>\/ws ~\/other/);
  assert.match(text, /claude-1\/<fixture>-ws/);
  assert.ok(!text.includes(homedir().replace(/\//g, "-")));
});
