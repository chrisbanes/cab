import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { TaskRead } from "../src/operator/contracts.js";
import { optionalSummary } from "../web/src/composer-summary.js";
import { emptyInput } from "../web/src/composer-state.js";
import {
  assignmentRow,
  briefParts,
  criterionRows,
  originLabel,
  sourceLine,
  stopConsequences,
  taskStatusLine,
} from "../web/src/task-overview.js";

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

test("taskStatusLine states recorded state, wait and lead", () => {
  const base = {
    task: { state: "open", ready: true },
    execution: { state: "idle", holds },
    admission: { reasons: [] },
    source: null,
    lead: { name: "Mira" },
  };
  const line = (patch: Record<string, unknown>) =>
    taskStatusLine({ ...base, ...patch } as unknown as Data);
  assert.equal(line({}), "Ready / Accountable project lead: Mira");
  assert.equal(
    line({ task: { state: "open", ready: false } }),
    "Draft / Accountable project lead: Mira",
  );
  assert.equal(
    line({
      admission: { reasons: ["imported-blockers-blocked"] },
      source: {
        nativeBlockers: [
          { repositoryName: "acme/design-system", number: 87, state: "open" },
        ],
      },
    }),
    "Ready · waiting on acme/design-system#87 / Accountable project lead: Mira",
  );
  assert.equal(
    line({ execution: { state: "stopping", holds: { ...holds, stop: true } } }),
    "Stopping; effects may continue / Accountable project lead: Mira",
  );
  assert.equal(
    line({
      execution: { state: "uncertain", holds: { ...holds, uncertainty: true } },
    }),
    "Execution uncertain / Accountable project lead: Mira",
  );
  assert.equal(
    line({ task: { state: "done", ready: true } }),
    "Done / Accountable project lead: Mira",
  );
  assert.equal(
    line({ task: { state: "cancelled", ready: true } }),
    "Cancelled / Accountable project lead: Mira",
  );
  // A paused project outranks readiness and other waits, as on the Board.
  assert.equal(
    line({
      task: { state: "open", ready: false },
      admission: { reasons: ["task-unready", "project-paused"] },
    }),
    "Draft · project paused / Accountable project lead: Mira",
  );
  assert.equal(
    line({
      admission: { reasons: ["local-dependency", "project-paused"] },
      execution: { state: "paused", holds },
    }),
    "Ready · project paused / Accountable project lead: Mira",
  );
  // Execution facts outrank the terminal task state, as in OperatorApi.execution().
  assert.equal(
    line({
      task: { state: "done", ready: true },
      execution: { state: "stopping", holds: { ...holds, stop: true } },
    }),
    "Stopping; effects may continue / Accountable project lead: Mira",
  );
  assert.equal(
    line({
      task: { state: "cancelled", ready: true },
      execution: { state: "uncertain", holds },
    }),
    "Execution uncertain / Accountable project lead: Mira",
  );
  assert.equal(
    line({
      task: { state: "done", ready: true },
      execution: { state: "running", holds },
    }),
    "Done · running / Accountable project lead: Mira",
  );
  assert.equal(
    line({
      task: { state: "open", ready: false },
      execution: { state: "uncertain", holds },
    }),
    "Execution uncertain / Accountable project lead: Mira",
  );
  assert.equal(
    line({ lead: null }),
    "Ready / Accountable project lead: Unconfigured",
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
  assert.equal(
    optionalSummary(emptyInput(), options, {}, {}).summary,
    "Optional settings · none supplied",
  );
  const input = {
    ...emptyInput(),
    context: "final key bindings",
    links: ["https://example.com/notes"],
    profileId: profile,
    blockerTaskIds: deps,
  };
  const full = optionalSummary(input, options, {}, {});
  assert.equal(full.summary, "Optional settings · 4 supplied");
  assert.deepEqual(full.lines, [
    "Context: final key bindings · Reference: https://example.com/notes",
    "Assignee: Eli (permitted) · Depends on: Task 0, Task 1",
  ]);
  assert.equal(full.fix, null);
  const one = optionalSummary(input, options, {}, { links: "bad" });
  assert.equal(one.summary, "Optional settings · 1 error");
  assert.equal(one.fix, "Open settings to fix the link.");
  assert.equal(
    optionalSummary(input, options, { profileId: "gone" }, { links: "bad" })
      .summary,
    "Optional settings · 2 errors",
  );
});

test("sourceLine reports the latest successful sync across every selection", () => {
  const membership = (lastSuccessfulAt: string | null) => ({
    sync: { lastSuccessfulAt },
  });
  const source = (memberships: unknown[]) =>
    ({
      repositoryName: "acme/atlas",
      number: 142,
      state: "open",
      memberships,
    }) as unknown as Data["source"];
  assert.equal(sourceLine(null), "Local task");
  assert.equal(
    sourceLine(
      source([
        membership(null),
        membership("2026-10-10T11:02:00Z"),
        membership("2026-10-09T08:00:00Z"),
      ]),
    ),
    "GitHub · acme/atlas#142 · open · last successful sync 2026-10-10T11:02:00Z · read-only requirements",
  );
  assert.match(sourceLine(source([membership(null)])), /no successful sync/);
});
