import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { TaskRead } from "../../src/operator/contracts.js";
import { optionalSummary } from "../../web/src/composer-summary.js";
import { emptyInput } from "../../web/src/composer-state.js";
import {
  assignmentRow,
  briefParts,
  criterionRows,
  originLabel,
  sourceFacts,
  stopConsequences,
  taskIdentity,
  taskReadiness,
} from "../../web/src/task-overview.js";

type Data = TaskRead["data"];
const holds = {
  stop: false,
  writer: false,
  capacity: false,
  uncertainty: false,
  task: false,
};

test("briefParts keeps prose and labels retained criteria C1/C2", () => {
  const parts = briefParts({
    body: "Intro\n\n- [ ] Open with the keyboard\n- [x] Escape closes the menu\n\nMore",
    criteria: [
      { criterionId: "a", position: 2, text: "Open with the keyboard" },
      { criterionId: "b", position: 3, text: "Escape closes the menu" },
    ],
    criteriaOmittedCount: 0,
  });
  assert.equal(parts.prose, "Intro\n\nMore");
  assert.deepEqual(
    parts.criteria.map((c) => [c.label, c.text]),
    [
      ["C1", "Open with the keyboard"],
      ["C2", "Escape closes the menu"],
    ],
  );
  assert.equal(parts.known, true);
  const lines = Array.from({ length: 130 }, (_, i) => `- [ ] item ${i}`);
  const partial = briefParts({
    body: lines.join("\n"),
    criteria: lines.slice(0, 128).map((_, i) => ({
      criterionId: `c${i}`,
      position: i,
      text: `item ${i}`,
    })),
    criteriaOmittedCount: 2,
  });
  assert.equal(partial.prose, "- [ ] item 128\n- [ ] item 129");
  assert.equal(partial.known, true);
  assert.deepEqual(
    briefParts({ body: null, criteria: [], criteriaOmittedCount: null }),
    { prose: "", criteria: [], known: false },
  );
  assert.deepEqual(
    briefParts({ body: "Prose only", criteria: [], criteriaOmittedCount: 0 }),
    { prose: "Prose only", criteria: [], known: true },
  );
  assert.equal(
    briefParts({ body: "Prose", criteria: [], criteriaOmittedCount: null })
      .known,
    false,
  );
});

test("criterionRows reports recorded outcomes and never an aggregate", () => {
  const sourceId = randomUUID(),
    newer = randomUUID(),
    resultId = randomUUID();
  const source = (id: string, revision: number) => ({
    sourceId: id,
    revision,
    criteria: ["a", "b", "c", "d"].map((c, i) => ({
      criterionId: c,
      position: i,
      text: `criterion ${c}`,
    })),
  });
  const record = (criterionId: string, outcome: string) => ({
    criterionId,
    outcome,
    scope: "s",
    provenance: "p",
  });
  const data = {
    review: {
      sources: [source(sourceId, 1)],
      results: [
        {
          resultId,
          metadata: {
            criteria: [
              record("a", "supported"),
              record("b", "failed"),
              record("d", "supported"),
              record("d", "failed"),
            ],
          },
        },
      ],
    },
  } as unknown as Data;
  const rows = criterionRows(data, resultId, sourceId);
  assert.deepEqual(
    rows.map((r) => [r.label, r.status, r.records.length]),
    [
      ["C1", "Supported by recorded evidence", 1],
      ["C2", "Failed recorded check", 1],
      ["C3", "Unverified", 0],
      ["C4", "Unknown", 2],
    ],
  );
  assert.equal(rows[0]?.stale, false);
  assert.deepEqual(Object.keys(rows).length, 4);
  for (const row of rows)
    assert.deepEqual(Object.keys(row).sort(), [
      "criterionId",
      "label",
      "position",
      "record",
      "records",
      "revision",
      "stale",
      "status",
      "text",
    ]);
  (data.review as unknown as { sources: unknown[] }).sources.push(
    source(newer, 2),
  );
  assert.equal(criterionRows(data, resultId, sourceId)[0]?.stale, true);
});

test("taskReadiness states recorded state and wait", () => {
  const base = {
    task: { state: "open", ready: true },
    execution: { state: "idle", holds },
    admission: { reasons: [] },
    waits: [],
    source: null,
  };
  const line = (patch: Record<string, unknown>) =>
    taskReadiness({ ...base, ...patch } as unknown as Data);
  assert.equal(line({}), "Ready");
  assert.equal(
    line({
      task: { state: "open", ready: false },
      source: { closure: "held" },
    }),
    "Held · closed on GitHub",
  );
  assert.equal(
    line({
      task: { state: "open", ready: false },
      source: { closure: "held" },
      execution: { state: "running", holds },
    }),
    "Held · closed on GitHub · running",
  );
  assert.equal(
    line({
      task: { state: "open", ready: false },
      source: { closure: "unattributed" },
    }),
    "Held · closure not attributed to cab",
  );
  assert.equal(
    line({
      task: { state: "done", ready: false },
      source: { closure: "completed" },
    }),
    "Done · closed on GitHub",
  );
  assert.equal(
    line({ task: { state: "done", ready: false }, source: { closure: null } }),
    "Done",
  );
  assert.equal(line({ task: { state: "open", ready: false } }), "Draft");
  const rule = {
    kind: "rule",
    mode: "all",
    conditions: [{ kind: "label", operator: "has", name: "ready" }],
  };
  assert.equal(
    line({
      task: { state: "open", ready: false },
      source: {
        closure: null,
        readiness: {
          rule,
          outcome: "unmet",
          unmet: [{ kind: "label", operator: "has", name: "ready" }],
        },
      },
    }),
    "Draft · needs label `ready`",
  );
  for (const outcome of ["matched", "not-evaluated"])
    assert.equal(
      line({
        task: { state: "open", ready: false },
        source: { closure: null, readiness: { rule, outcome, unmet: [] } },
      }),
      "Draft",
    );
  assert.equal(
    line({
      admission: { reasons: ["imported-blockers-blocked"] },
      waits: [{ code: "imported-blockers-blocked" }],
      source: {
        nativeBlockers: [
          {
            repositoryName: "acme/design-system",
            number: 87,
            state: "open",
            label: "acme/design-system#87",
          },
        ],
      },
    }),
    "Ready · waiting on acme/design-system#87",
  );
  // A label that starts with a proper noun keeps its capitals mid-sentence.
  assert.equal(
    line({
      admission: { reasons: ["imported-blockers-unknown"] },
      waits: [{ code: "imported-blockers-unknown" }],
    }),
    "Ready · GitHub dependencies unconfirmed",
  );
  // The header names the first wait in the flow's order.
  assert.equal(
    line({ waits: [{ code: "local-dependency" }, { code: "capacity" }] }),
    "Ready · blocked by a task dependency",
  );
  assert.equal(
    line({ execution: { state: "stopping", holds: { ...holds, stop: true } } }),
    "Stopping; effects may continue",
  );
  assert.equal(
    line({
      execution: { state: "uncertain", holds: { ...holds, uncertainty: true } },
    }),
    "Execution uncertain",
  );
  assert.equal(line({ task: { state: "done", ready: true } }), "Done");
  assert.equal(
    line({ task: { state: "cancelled", ready: true } }),
    "Cancelled",
  );
  // A paused project outranks readiness and other waits, as on the Board.
  assert.equal(
    line({
      task: { state: "open", ready: false },
      admission: { reasons: ["task-unready", "project-paused"] },
    }),
    "Draft · project paused",
  );
  assert.equal(
    line({
      admission: { reasons: ["local-dependency", "project-paused"] },
      execution: { state: "paused", holds },
    }),
    "Ready · project paused",
  );
  // Execution facts outrank the terminal task state, as in OperatorApi.execution().
  assert.equal(
    line({
      task: { state: "done", ready: true },
      execution: { state: "stopping", holds: { ...holds, stop: true } },
    }),
    "Stopping; effects may continue",
  );
  assert.equal(
    line({
      task: { state: "cancelled", ready: true },
      execution: { state: "uncertain", holds },
    }),
    "Execution uncertain",
  );
  assert.equal(
    line({
      task: { state: "done", ready: true },
      execution: { state: "running", holds },
    }),
    "Done · running",
  );
  assert.equal(
    line({
      task: { state: "open", ready: false },
      execution: { state: "uncertain", holds },
    }),
    "Execution uncertain",
  );
});

test("stopConsequences counts unfinished delegated assignments", () => {
  const lead = randomUUID();
  const a = (state: string, id = randomUUID()) => ({ assignmentId: id, state });
  const data = (assignments: unknown[], hasLead = true, stop = false) =>
    ({
      lead: hasLead ? { name: "Mira" } : null,
      leadAssignmentId: lead,
      assignments,
      execution: { holds: { ...holds, stop } },
    }) as unknown as Data;
  assert.deepEqual(
    stopConsequences(data([a("running", lead), a("running"), a("completed")])),
    {
      affected: "Mira (lead) and 1 delegated assignment is affected.",
      held: false,
    },
  );
  assert.equal(
    stopConsequences(data([a("running", lead), a("running"), a("pending")]))
      .affected,
    "Mira (lead) and 2 delegated assignments are affected.",
  );
  assert.equal(
    stopConsequences(data([], false)).affected,
    "This task's assignments are affected.",
  );
  assert.equal(stopConsequences(data([], true, true)).held, true);
});

test("assignmentRow names requester, destination, wait and short id", () => {
  const lead = {
    assignmentId: randomUUID(),
    name: "Mira",
    requesterAssignmentId: null,
    resultDestination: "task result",
    runtime: { harness: "codex" },
  };
  const builder = (brief: string) => ({
    assignmentId: randomUUID(),
    name: "Builder",
    runtime: { harness: "claude", model: "sonnet", reasoningEffort: null },
    brief,
    requesterAssignmentId: lead.assignmentId,
    resultRecipientAssignmentId: lead.assignmentId,
  });
  const one = builder("x".repeat(90)),
    two = builder("Independent focus review");
  const all = [lead, one, two] as unknown as Data["assignments"];
  const row = assignmentRow(one as never, all);
  assert.equal(row.title, `Builder · ${"x".repeat(80)}…`);
  assert.equal(row.flow, "Mira → Mira");
  assert.equal(row.wait, "Waiting reason unknown");
  assert.equal(
    assignmentRow({ ...one, state: "held" } as never, all).state,
    "Held",
  );
  const waiting = (waitReason: string) =>
    assignmentRow({ ...one, waitReason } as never, all).wait;
  assert.equal(
    waiting("project-paused; task-unready"),
    "Project paused; Draft: not Ready",
  );
  assert.equal(
    waiting("Claude runtime is not configured"),
    "Claude runtime is not configured",
  );
  assert.equal(row.runtime, "Claude · sonnet · default effort");
  assert.equal(assignmentRow(lead as never, all).runtime, "Codex");
  assert.equal(
    assignmentRow(lead as never, all).flow,
    "Operator → task result",
  );
  assert.notEqual(row.id, assignmentRow(two as never, all).id);
  assert.equal(row.id.length, 8);
});

test("originLabel names the originating view", () => {
  assert.equal(originLabel("/app/tasks?view=board"), "Board");
  assert.equal(originLabel("/app"), "Overview");
  assert.equal(originLabel("/app/inbox"), "Inbox");
  assert.equal(originLabel("/app/search?query=x"), "Search");
  assert.equal(originLabel("/app/tasks"), "Tasks");
  assert.equal(originLabel("/app/settings"), null);
});

test("optionalSummary counts supplied values and lets errors win", () => {
  const profile = randomUUID(),
    deps = [randomUUID(), randomUUID()];
  const options = {
    profiles: [{ id: profile, name: "Eli" }],
    dependencies: deps.map((id, i) => ({ id, title: `Task ${i}` })),
  } as never;
  const empty = optionalSummary(emptyInput(), options, {}, {});
  assert.equal(empty.summary, "Optional settings · none supplied");
  assert.deepEqual(empty.chips, []);
  const input = {
    ...emptyInput(),
    context: "final key bindings",
    links: ["https://example.com/notes"],
    profileId: profile,
    blockerTaskIds: deps,
  };
  const chip = (s: ReturnType<typeof optionalSummary>) =>
    s.chips.map((c) => [c.text, c.invalid]);
  const full = optionalSummary(input, options, {}, {});
  assert.equal(full.summary, "Optional settings · 4 supplied");
  assert.deepEqual(chip(full), [
    ["Context · final key bindings", false],
    ["Reference · https://example.com/notes", false],
    ["Assignee · Eli (permitted)", false],
    ["Depends on · Task 0, Task 1", false],
  ]);
  assert.equal(full.fix, null);
  const one = optionalSummary(input, options, {}, { links: "bad" });
  assert.equal(one.summary, "Optional settings · 1 error");
  assert.equal(one.fix, "Open settings to fix the link.");
  assert.deepEqual(
    one.chips.filter((c) => c.invalid).map((c) => c.field),
    ["links"],
  );
  const two = optionalSummary(
    input,
    options,
    { profileId: "gone" },
    { links: "bad" },
  );
  assert.equal(two.summary, "Optional settings · 2 errors");
  assert.deepEqual(
    two.chips.filter((c) => c.invalid).map((c) => c.field),
    ["links", "profileId"],
  );
  assert.equal(
    optionalSummary(
      { ...emptyInput(), profileId: randomUUID() },
      options,
      {},
      {},
    ).chips[0]?.text,
    "Assignee · unavailable",
  );
});

test("sourceFacts reports the latest successful sync across every selection", () => {
  const membership = (lastSuccessfulAt: string | null) => ({
    sync: { lastSuccessfulAt },
  });
  const source = (memberships: unknown[]) =>
    ({
      repositoryName: "acme/atlas",
      number: 142,
      state: "open",
      memberships,
    }) as unknown as NonNullable<Data["source"]>;
  assert.equal(taskIdentity({ source: null }).label, "Local task");
  assert.equal(
    sourceFacts(
      source([
        membership(null),
        membership("2026-10-10T11:02:00Z"),
        membership("2026-10-09T08:00:00Z"),
      ]),
    ).synced,
    "2026-10-10T11:02:00Z",
  );
  assert.equal(sourceFacts(source([membership(null)])).synced, null);
});
