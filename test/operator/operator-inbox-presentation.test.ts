import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import {
  ageLabel,
  clockLabel,
  filterCounts,
  holdNotices,
  requestActionLabel,
  requestKindLabel,
} from "../../web/src/inbox-presentation.js";
import type { InboxItem, TaskRead } from "../../src/operator/contracts.js";
import { orderWaits } from "../../src/operator/wait-reasons.js";

const minute = 60_000;
test("relative age reads at the largest useful unit and never goes negative", () => {
  const now = 1_700_000_000_000;
  assert.equal(ageLabel(null, now), "Age unknown");
  assert.equal(ageLabel(now - 0, now), "just now");
  assert.equal(ageLabel(now - 59_000, now), "just now");
  assert.equal(ageLabel(now + 5 * minute, now), "just now");
  assert.equal(ageLabel(now - 61_000, now), "1m");
  assert.equal(ageLabel(now - 8 * minute, now), "8m");
  assert.equal(ageLabel(now - 106 * minute, now), "1h 46m");
  assert.equal(ageLabel(now - 120 * minute, now), "2h");
  assert.equal(ageLabel(now - 25 * 60 * minute, now), "1d 1h");
  assert.equal(ageLabel(now - 48 * 60 * minute, now), "2d");
});

test("clock label is two-digit local hours and minutes", () => {
  assert.equal(clockLabel(new Date(2026, 9, 1, 9, 5).getTime()), "09:05");
  assert.equal(clockLabel(new Date(2026, 9, 1, 23, 59).getTime()), "23:59");
});

test("kind and action labels cover every request kind", () => {
  for (const [kind, label, action] of [
    ["question", "Question", "Answer question"],
    ["approval", "Approval", "Review material & decide"],
    ["intervention", "Intervention", "Inspect execution"],
  ] as const) {
    assert.equal(requestKindLabel(kind), label);
    assert.equal(requestActionLabel(kind), action);
  }
});

const item = (kind: InboxItem["kind"], projectId: string): InboxItem => ({
  id: randomUUID(),
  kind,
  urgency: 1,
  createdAt: null,
  taskId: randomUUID(),
  projectId,
  projectName: "P",
  taskTitle: "T",
  requestingAssignmentId: null,
  requesterName: "R",
  interactionId: null,
  revision: null,
  reason: "r",
  destination: "/",
  evidence: "/",
  conversation: null,
});

test("filter counts add up per project and per kind", () => {
  const [a, b, c] = [randomUUID(), randomUUID(), randomUUID()],
    counts = filterCounts([
      item("question", a),
      item("question", a),
      item("approval", b),
      item("intervention", c),
      item("question", c),
    ]);
  assert.equal(counts.total, 5);
  assert.deepEqual(counts.project, { [a]: 2, [b]: 1, [c]: 2 });
  assert.deepEqual(counts.kind, { question: 3, approval: 1, intervention: 1 });
});

const task = (
  reasons: TaskRead["data"]["admission"]["reasons"],
  extra: Partial<TaskRead["data"]> = {},
) =>
  ({
    admission: { eligible: reasons.length === 0, reasons },
    // As the task read derives them: the flow's order, Drafts and closed tasks excluded.
    waits: orderWaits(
      reasons
        .filter((r) => r !== "task-unready" && r !== "task-not-open")
        .map((code) => ({ code, fix: null, links: [] })),
    ),
    localDependencies: [],
    source: null,
    ...extra,
  }) as unknown as TaskRead["data"];

test("hold notices name each independent hold and what approval does not clear", () => {
  assert.deepEqual(holdNotices(task([])), []);
  const source = {
    nativeBlockers: [
      {
        nodeId: "n1",
        repositoryId: "r1",
        repositoryName: "acme/design-system",
        number: 87,
        state: "open",
      },
      {
        nodeId: "n2",
        repositoryId: "r1",
        repositoryName: "acme/design-system",
        number: 12,
        state: "closed",
      },
    ],
  } as unknown as TaskRead["data"]["source"];
  const blocked = holdNotices(task(["imported-blockers-blocked"], { source }));
  assert.deepEqual(blocked, [
    {
      id: "blocked",
      title: "Execution blocked by dependency",
      items: ["acme/design-system#87"],
      detail:
        "Source-owned hold. Approval does not clear it; execution still waits for the GitHub blocker.",
    },
  ]);
  // Unknown blockers never claim a GitHub blocker that was not found.
  const unknown = holdNotices(task(["imported-blockers-unknown"]));
  assert.equal(unknown.length, 1);
  assert.equal(unknown[0]?.title, "Execution held: dependencies unconfirmed");
  assert.deepEqual(unknown[0]?.items, []);
  assert.ok(!unknown[0]?.detail.includes("waits for the GitHub blocker"));
  // A source review or hold is its own hold, not a dependency.
  const held = holdNotices(task(["source-held"]));
  assert.equal(held.length, 1);
  assert.equal(held[0]?.title, "Execution held by the source");
  assert.ok(!held[0]?.detail.includes("GitHub blocker"));
  const local = holdNotices(
    task(["local-dependency"], {
      localDependencies: [
        { id: randomUUID(), title: "Build the base", state: "open" },
        { id: randomUUID(), title: "Done already", state: "done" },
      ],
    }),
  );
  assert.deepEqual(local[0]?.items, ["Build the base"]);
  assert.equal(
    local[0]?.detail,
    "Dependency hold. Approval does not clear it.",
  );
  // Notices follow the waits' order, as task detail and the CLI do.
  assert.deepEqual(
    holdNotices(
      task(["source-held", "local-dependency", "project-paused"]),
    ).map((notice) => notice.id),
    ["paused", "dependency", "source-held"],
  );
  const paused = holdNotices(task(["project-paused"]));
  assert.equal(paused[0]?.title, "Project paused");
  assert.equal(paused[0]?.detail, "Approval does not resume work.");
});

test("every other admission reason still produces a hold notice", () => {
  for (const [reason, label] of [
    ["task-unready", "task not ready"],
    ["task-not-open", "task not open"],
    ["project-lead-unconfigured", "project lead not configured"],
    ["project-lead-revoked", "project lead revoked"],
    ["admission-blocked", "admission blocked"],
  ] as const) {
    const notices = holdNotices(task([reason]));
    assert.equal(notices.length, 1, reason);
    assert.equal(notices[0]?.title, `Execution held (${label})`);
    assert.equal(notices[0]?.detail, "Approving does not clear it.");
  }
  // Several reasons give several notices; an ineligible task with no known reason still says so.
  assert.equal(holdNotices(task(["task-unready", "project-paused"])).length, 2);
  const unexplained = holdNotices(
    task([], { admission: { eligible: false, reasons: [] } }),
  );
  assert.equal(unexplained.length, 1);
  assert.equal(unexplained[0]?.title, "Execution held");
});

test("a power hold notice lists the supervisor's reason in the waits' order", () => {
  const reason = "Power-event history is incomplete or ambiguous";
  const withPower = (
    reasons: TaskRead["data"]["admission"]["reasons"],
    detail?: string,
  ) =>
    task(reasons, {
      waits: orderWaits([
        ...task(reasons).waits,
        { code: "power-held", fix: null, links: [], ...(detail && { detail }) },
      ]),
    });
  const notices = holdNotices(
    withPower(["local-dependency", "project-paused"], reason),
  );
  assert.deepEqual(
    notices.map((notice) => notice.id),
    ["paused", "power-held", "dependency"],
  );
  assert.deepEqual(notices[1], {
    id: "power-held",
    title: "Execution held by power supervision",
    items: [reason],
    detail: "Approving does not clear it.",
  });
  assert.deepEqual(holdNotices(withPower([]))[0]?.items, []);
  assert.equal(
    holdNotices(withPower([], reason), "answer")[0]?.detail,
    "Answering does not clear it.",
  );
});

test("assignment waits are hold notices in the waits' order, worded from their labels and naming the profile", () => {
  const waits = orderWaits([
    { code: "assignment-held", fix: null, links: [], detail: "Worker" },
    { code: "assignment-profile-revoked", fix: null, links: [] },
  ]);
  const notices = holdNotices(task([], { waits }));
  assert.deepEqual(
    notices.map(({ id, title, items }) => ({ id, title, items })),
    [
      {
        id: "assignment-profile-revoked",
        title: "Execution held (assignment profile revoked)",
        items: [],
      },
      {
        id: "assignment-held",
        title: "Execution held (assignment held)",
        items: ["Worker"],
      },
    ],
  );
  assert.ok(notices.every((n) => n.detail === "Approving does not clear it."));
  assert.ok(
    holdNotices(task([], { waits }), "answer").every(
      (n) => n.detail === "Answering does not clear it.",
    ),
  );
});

test("answering a question words each hold notice for answers, with the same titles and items", () => {
  const source = {
    nativeBlockers: [
      {
        nodeId: "n1",
        repositoryId: "r1",
        repositoryName: "acme/design-system",
        number: 87,
        state: "open",
      },
    ],
  } as unknown as TaskRead["data"]["source"];
  const answer = (...args: Parameters<typeof task>) =>
    holdNotices(task(...args), "answer");
  const shape = (notices: ReturnType<typeof holdNotices>) =>
    notices.map(({ id, title, items }) => ({ id, title, items }));
  const cases: [
    TaskRead["data"]["admission"]["reasons"],
    Partial<TaskRead["data"]>,
    string,
    string,
    string[],
    string,
  ][] = [
    [
      ["imported-blockers-blocked"],
      { source },
      "blocked",
      "Execution blocked by dependency",
      ["acme/design-system#87"],
      "Source-owned hold. Answering does not clear it; execution still waits for the GitHub blocker.",
    ],
    [
      ["imported-blockers-unknown"],
      {},
      "blockers-unknown",
      "Execution held: dependencies unconfirmed",
      [],
      "GitHub blockers could not be confirmed. Answering does not clear this hold.",
    ],
    [
      ["source-held"],
      {},
      "source-held",
      "Execution held by the source",
      [],
      "Source review or hold is unresolved. Answering does not clear it.",
    ],
    [
      ["local-dependency"],
      {
        localDependencies: [
          { id: randomUUID(), title: "Build the base", state: "open" },
        ],
      },
      "dependency",
      "Execution blocked by dependency",
      ["Build the base"],
      "Dependency hold. Answering does not clear it.",
    ],
    [
      ["project-paused"],
      {},
      "paused",
      "Project paused",
      [],
      "Task paused. Recording answers does not resume execution.",
    ],
  ];
  for (const [reason, label] of [
    ["task-unready", "task not ready"],
    ["task-not-open", "task not open"],
    ["project-lead-unconfigured", "project lead not configured"],
    ["project-lead-revoked", "project lead revoked"],
    ["admission-blocked", "admission blocked"],
  ] as const) {
    cases.push([
      [reason],
      {},
      reason,
      `Execution held (${label})`,
      [],
      "Answering does not clear it.",
    ]);
  }
  for (const [reasons, extra, id, title, items, detail] of cases) {
    const notices = answer(reasons, extra);
    // Wording is the only difference from the approval notices.
    assert.deepEqual(
      shape(notices),
      shape(holdNotices(task(reasons, extra))),
      id,
    );
    assert.deepEqual(shape(notices), [{ id, title, items }], id);
    assert.equal(notices[0]?.detail, detail, id);
    assert.ok(!notices[0]?.detail.includes("Approv"), id);
  }
  const unexplained = holdNotices(
    task([], { admission: { eligible: false, reasons: [] } }),
    "answer",
  );
  assert.equal(unexplained[0]?.id, "held");
  assert.equal(unexplained[0]?.detail, "Answering does not clear it.");
  assert.deepEqual(answer([]), []);
});
