import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import {
  ageLabel,
  assignmentChain,
  filterCounts,
  holdNotices,
  holdNoticesBesideRequests,
  queueGroups,
  requestActionLabel,
  requestHeading,
  requestIdentity,
  requestKindLabel,
  taskContext,
} from "../../web/src/inbox-presentation.js";
import type {
  RuntimeInboxItem,
  TaskInboxItem,
  TaskRead,
} from "../../src/operator/contracts.js";
import { orderWaits } from "../../src/operator/wait-reasons.js";

const minute = 60_000;
test("relative age reads at the largest useful unit and never goes negative", () => {
  const now = 1_700_000_000_000;
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

const runtimeItem = (
  harness: "codex" | "claude" = "codex",
): RuntimeInboxItem => ({
  id: `runtime:${harness}`,
  kind: "runtime",
  urgency: 0,
  createdAt: 1_000,
  harness,
  since: 1_000,
  headline: `${harness === "codex" ? "Codex" : "Claude"} runtime unavailable`,
  reason: "Restart retries exhausted",
  lastFailure: "exited",
  attempts: [],
  destination: "/app/settings/runtime",
});

test("kind and action labels cover every request kind", () => {
  assert.equal(requestKindLabel("runtime"), "Runtime");
  assert.equal(
    requestActionLabel({ kind: "runtime" }),
    "Open runtime settings",
  );
  assert.deepEqual(requestHeading(runtimeItem()), {
    title: "Codex runtime unavailable",
    subtitle: null,
    reason: "Retries exhausted",
  });
  for (const [kind, label, action] of [
    ["question", "Question", "Answer question"],
    ["approval", "Approval", "Review material & decide"],
    ["intervention", "Intervention", "Inspect execution"],
  ] as const) {
    assert.equal(requestKindLabel(kind), label);
    assert.equal(requestActionLabel({ kind, attentionCode: null }), action);
  }
  for (const [code, action] of [
    ["execution-uncertain", "Inspect execution"],
    ["unresolved-result", "Inspect execution"],
    ["completion-rejected", "Inspect execution"],
  ] as const)
    assert.equal(
      requestActionLabel({ kind: "intervention", attentionCode: code }),
      action,
    );
  // A recorded answer awaiting native delivery offers no answer action.
  assert.equal(
    requestActionLabel({
      kind: "question",
      attentionCode: "question-delivery",
    }),
    "View task",
  );
});

const item = (
  kind: TaskInboxItem["kind"],
  projectId: string,
): TaskInboxItem => ({
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
  headline: null,
  reason: "r",
  destination: "/",
  attentionCode: null,
  evidence: "/",
  conversation: null,
});

test("a request leads with its question or exact action and keeps only the reasons the operator needs", () => {
  const base = {
    taskTitle: "Guide",
    projectName: "Docs",
    reason: "Operator answer requested",
    attentionCode: null,
  } as const;
  assert.deepEqual(
    requestHeading({ ...base, kind: "question", headline: "Pick an audience" }),
    { title: "Pick an audience", subtitle: "Docs / Guide", reason: null },
  );
  assert.deepEqual(
    requestHeading({
      ...base,
      kind: "approval",
      reason: "Review exact approval material",
      headline: "Create a pull request.",
    }),
    { title: "Create a pull request.", subtitle: "Docs / Guide", reason: null },
  );
  // A recorded answer waiting on native delivery keeps its reason.
  assert.deepEqual(
    requestHeading({
      ...base,
      kind: "question",
      headline: "Pick an audience",
      reason: "Answer recorded; native delivery remains unresolved",
      attentionCode: "question-delivery",
    }),
    {
      title: "Pick an audience",
      subtitle: "Docs / Guide",
      reason: "Answer recorded; native delivery remains unresolved",
    },
  );
  assert.deepEqual(
    requestHeading({
      ...base,
      kind: "intervention",
      headline: null,
      reason: "Execution ownership is uncertain",
    }),
    {
      title: "Guide",
      subtitle: "Docs",
      reason: "Execution ownership is uncertain",
    },
  );
  // A withheld headline falls back to the task title, never an "Unavailable" title.
  assert.deepEqual(
    requestHeading({ ...base, kind: "question", headline: null }),
    { title: "Guide", subtitle: "Docs", reason: null },
  );
});

test("a request with neither headline nor task title has no title, so the page words its own fallback", () => {
  assert.deepEqual(
    requestHeading({
      kind: "question",
      headline: null,
      taskTitle: null,
      projectName: "Docs",
      reason: null,
      attentionCode: null,
    }),
    { title: null, subtitle: "Docs", reason: null },
  );
});

test("a runtime item counts toward the total and its kind but under no project", () => {
  const p = randomUUID(),
    counts = filterCounts([
      runtimeItem(),
      runtimeItem("claude"),
      item("question", p),
    ]);
  assert.equal(counts.total, 3);
  assert.deepEqual(counts.project, { [p]: 1 });
  assert.deepEqual(counts.kind, { runtime: 2, question: 1 });
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
  assert.deepEqual(holdNotices(task([]), "approve", null), []);
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
  const blocked = holdNotices(
    task(["imported-blockers-blocked"], { source }),
    "approve",
    null,
  );
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
  const unknown = holdNotices(
    task(["imported-blockers-unknown"]),
    "approve",
    null,
  );
  assert.equal(unknown.length, 1);
  assert.equal(unknown[0]?.title, "Execution held: dependencies unconfirmed");
  assert.deepEqual(unknown[0]?.items, []);
  assert.ok(!unknown[0]?.detail.includes("waits for the GitHub blocker"));
  // A source review or hold is its own hold, not a dependency.
  const held = holdNotices(task(["source-held"]), "approve", null);
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
    "approve",
    null,
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
      "approve",
      null,
    ).map((notice) => notice.id),
    ["paused", "dependency", "source-held"],
  );
  const paused = holdNotices(task(["project-paused"]), "approve", null);
  assert.equal(paused[0]?.title, "Project paused");
  assert.equal(paused[0]?.detail, "Approval does not resume work.");
});

test("every other admission reason still produces a hold notice", () => {
  for (const [reason, label] of [
    ["task-unready", "task not ready"],
    ["task-not-open", "task not open"],
    ["project-lead-unconfigured", "project lead not configured"],
    ["project-lead-revoked", "project lead revoked"],
    ["admission-blocked", "waiting to start"],
  ] as const) {
    const notices = holdNotices(task([reason]), "approve", null);
    assert.equal(notices.length, 1, reason);
    assert.equal(notices[0]?.title, `Execution held (${label})`);
    assert.equal(notices[0]?.detail, "Approving does not clear it.");
  }
  // Several reasons give several notices; an ineligible task with no known reason still says so.
  assert.equal(
    holdNotices(task(["task-unready", "project-paused"]), "approve", null)
      .length,
    2,
  );
  const unexplained = holdNotices(
    task([], { admission: { eligible: false, reasons: [] } }),
    "approve",
    null,
  );
  assert.equal(unexplained.length, 1);
  assert.equal(unexplained[0]?.title, "Execution held");
});

test("a hold notice keeps a proper noun's capitals when the wait label sits inside the title", () => {
  for (const [code, label] of [
    ["claude-token-unavailable", "Claude token unavailable"],
    ["runtime-unavailable", "runtime unavailable"],
    ["capacity", "capacity full"],
  ] as const) {
    const notices = holdNotices(
      task([], { waits: [{ code, fix: null, links: [] }] }),
      "approve",
      null,
    );
    assert.equal(notices.length, 1, code);
    assert.equal(notices[0]?.title, `Execution held (${label})`);
  }
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
    "approve",
    null,
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
  assert.deepEqual(holdNotices(withPower([]), "approve", null)[0]?.items, []);
  assert.equal(
    holdNotices(withPower([], reason), "answer", null)[0]?.detail,
    "Answering does not clear it.",
  );
});

test("assignment waits are hold notices in the waits' order, worded from their labels and naming the profile", () => {
  const waits = orderWaits([
    { code: "assignment-held", fix: null, links: [], detail: "Worker" },
    { code: "assignment-profile-revoked", fix: null, links: [] },
  ]);
  const notices = holdNotices(task([], { waits }), "approve", null);
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
    holdNotices(task([], { waits }), "answer", null).every(
      (n) => n.detail === "Answering does not clear it.",
    ),
  );
});

test("revoked repository access and unresolved recovery are hold notices in the waits' order", () => {
  const projectId = randomUUID(),
    assignmentId = randomUUID();
  const waits = orderWaits([
    {
      code: "assignment-recovery-unresolved",
      fix: null,
      links: [{ kind: "recovery", assignmentId, label: "Open recovery" }],
      detail: "Worker",
    },
    {
      code: "repository-access-revoked",
      fix: { kind: "open-repositories", projectId },
      links: [],
    },
  ]);
  assert.deepEqual(
    holdNotices(task([], { waits }), "approve", null).map(
      ({ id, title, items }) => ({
        id,
        title,
        items,
      }),
    ),
    [
      {
        id: "repository-access-revoked",
        title: "Execution held (repository access revoked)",
        items: [],
      },
      {
        id: "assignment-recovery-unresolved",
        title: "Execution held (assignment recovery unresolved)",
        items: ["Worker"],
      },
    ],
  );
});

const approvalWait = (
  extra: TaskRead["data"]["admission"]["reasons"],
  ...ids: string[]
) =>
  task(extra, {
    waits: orderWaits([
      ...task(extra).waits,
      {
        code: "approval",
        fix: null,
        links: ids.map((id) => ({
          kind: "request" as const,
          id,
          label: "Review material & decide",
        })),
      },
    ]),
  });
const held = ["Execution held (approval needs a decision)"];
const titles = (notices: ReturnType<typeof holdNotices>) =>
  notices.map((n) => n.title);

test("a pending approval is a hold unless it is the approval being decided", () => {
  // The selected approval alone is not a hold on itself.
  assert.deepEqual(holdNotices(approvalWait([], "a1"), "approve", "a1"), []);
  // Two open approvals, one in view: the other still holds.
  assert.deepEqual(
    titles(holdNotices(approvalWait([], "a1", "a2"), "approve", "a1")),
    held,
  );
  // With no approval in view, every pending approval holds execution.
  assert.deepEqual(
    titles(holdNotices(approvalWait([], "a1"), "approve", null)),
    held,
  );
  // Also when the wait names no request.
  assert.deepEqual(
    titles(holdNotices(approvalWait([]), "approve", null)),
    held,
  );
});

test("a question beside an open approval lists the approval as a hold in the answering wording", () => {
  const [notice, ...rest] = holdNotices(approvalWait([], "a1"), "answer", null);
  assert.equal(rest.length, 0);
  assert.equal(notice?.title, held[0]);
  assert.equal(notice?.detail, "Answering does not clear it.");
  assert.equal(
    holdNotices(approvalWait([], "a1"), "approve", null)[0]?.detail,
    "Approving does not clear it.",
  );
});

test("surfaces that list every open approval drop the merged approval hold unless one is in view", () => {
  // No approval in view: the approvals are rows already, so only the other holds remain.
  assert.deepEqual(
    holdNoticesBesideRequests(
      approvalWait(["task-unready"], "a1", "a2"),
      "approve",
      null,
    ).map((n) => n.id),
    ["task-unready"],
  );
  // One in view: the other approval is the hold.
  assert.deepEqual(
    titles(
      holdNoticesBesideRequests(approvalWait([], "a1", "a2"), "approve", "a1"),
    ),
    held,
  );
  assert.deepEqual(
    holdNoticesBesideRequests(approvalWait([], "a1"), "approve", "a1"),
    [],
  );
  // The remaining notices keep the action's wording.
  const wording = (action: "approve" | "answer") =>
    holdNoticesBesideRequests(
      approvalWait(["task-unready"], "a1"),
      action,
      null,
    ).map((n) => n.detail);
  assert.deepEqual(wording("approve"), ["Approving does not clear it."]);
  assert.deepEqual(wording("answer"), ["Answering does not clear it."]);
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
    holdNotices(task(...args), "answer", null);
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
    ["admission-blocked", "waiting to start"],
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
      shape(holdNotices(task(reasons, extra), "approve", null)),
      id,
    );
    assert.deepEqual(shape(notices), [{ id, title, items }], id);
    assert.equal(notices[0]?.detail, detail, id);
    assert.ok(!notices[0]?.detail.includes("Approv"), id);
  }
  const unexplained = holdNotices(
    task([], { admission: { eligible: false, reasons: [] } }),
    "answer",
    null,
  );
  assert.equal(unexplained[0]?.id, "held");
  assert.equal(unexplained[0]?.detail, "Answering does not clear it.");
  assert.deepEqual(answer([]), []);
});

test("the queue groups interventions first, then questions and approvals, keeping server order", () => {
  const [i1, i2] = [item("intervention", "p"), item("intervention", "p")],
    [q1, a1, q2] = [
      item("question", "p"),
      item("approval", "p"),
      item("question", "p"),
    ],
    groups = queueGroups([i1, i2, q1, a1, q2]);
  assert.deepEqual(
    groups.map(({ id, heading }) => ({ id, heading })),
    [
      { id: "intervention", heading: "Intervention · 2" },
      { id: "requests", heading: "Questions & approvals · oldest first" },
    ],
  );
  assert.deepEqual(groups[0]?.items, [i1, i2]);
  assert.deepEqual(groups[1]?.items, [q1, a1, q2]);
  assert.deepEqual(
    queueGroups([q1]).map((g) => g.id),
    ["requests"],
  );
  assert.deepEqual(queueGroups([]), []);
});

test("a runtime item leads the Intervention group and counts in its heading", () => {
  const [r, i1, q1] = [
      runtimeItem(),
      item("intervention", "p"),
      item("question", "p"),
    ],
    groups = queueGroups([r, i1, q1]);
  assert.deepEqual(
    groups.map(({ id, heading }) => ({ id, heading })),
    [
      { id: "intervention", heading: "Intervention · 2" },
      { id: "requests", heading: "Questions & approvals · oldest first" },
    ],
  );
  assert.deepEqual(groups[0]?.items, [r, i1]);
  assert.deepEqual(
    queueGroups([r]).map((g) => g.id),
    ["intervention"],
  );
});

test("a request's identity line names the requester, version and time from the read model", () => {
  const at = new Date(2026, 9, 1, 10, 52).getTime();
  assert.equal(
    requestIdentity({ requesterName: "Mira", revision: 2, createdAt: at }),
    "Mira · version 2 · 10:52",
  );
  assert.equal(
    requestIdentity({ requesterName: "Mira", revision: null, createdAt: at }),
    "Mira · 10:52",
  );
  // A missing requester or time is omitted, never printed as a placeholder.
  assert.equal(
    requestIdentity({ requesterName: null, revision: 1, createdAt: null }),
    "version 1",
  );
  assert.equal(
    requestIdentity({ requesterName: null, revision: null, createdAt: null }),
    "",
  );
});

const assignment = (
  assignmentId: string,
  name: string,
  requesterAssignmentId?: string | null,
) =>
  ({
    assignmentId,
    name,
    ...(requesterAssignmentId === undefined ? {} : { requesterAssignmentId }),
  }) as TaskRead["data"]["assignments"][number];

test("the assignment chain runs from the operator to the requesting assignment", () => {
  const [mira, jonas] = [randomUUID(), randomUUID()],
    assignments = [
      assignment(mira, "Mira", null),
      assignment(jonas, "Jonas", mira),
    ];
  assert.deepEqual(assignmentChain({ assignments }, jonas), [
    "Operator",
    "Mira",
    "Jonas",
  ]);
  assert.deepEqual(assignmentChain({ assignments }, mira), [
    "Operator",
    "Mira",
  ]);
  assert.deepEqual(
    assignmentChain({ assignments: [assignment(jonas, "Jonas")] }, jonas),
    ["Requester unknown", "Jonas"],
  );
  assert.deepEqual(
    assignmentChain(
      {
        assignments: [
          assignment(mira, "Mira", jonas),
          assignment(jonas, "Jonas", mira),
        ],
      },
      jonas,
    ),
    ["Requester unknown", "Mira", "Jonas"],
  );
  assert.deepEqual(assignmentChain({ assignments }, null), []);
  assert.deepEqual(assignmentChain({ assignments }, randomUUID()), []);
});

test("task context reads the source, lead and the task's next actor", () => {
  const read = (
    patch: Record<string, unknown>,
    codes: string[] = [],
    execution = "idle",
  ) =>
    ({
      task: { state: "open", ready: true, version: 1 },
      execution: {
        state: execution,
        holds: {
          stop: false,
          writer: false,
          capacity: false,
          uncertainty: false,
          task: false,
        },
      },
      admission: { eligible: true, reasons: [] },
      attention: { codes, count: codes.length },
      ...patch,
    }) as unknown as TaskRead["data"];
  const local = read(
      { source: null, lead: { profileId: randomUUID(), name: "Mira" } },
      ["question"],
    ),
    imported = read(
      { source: { repositoryName: "acme/atlas", number: 142 }, lead: null },
      ["approval"],
    );
  assert.deepEqual(taskContext(local, item("question", "p"), true), {
    source: "Local task",
    lead: "Mira",
    next: "Next: you · answer question",
  });
  assert.deepEqual(taskContext(imported, item("approval", "p"), true), {
    source: "acme/atlas#142",
    // Lead accountability stays visible, in the task views' wording.
    lead: "No lead configured",
    next: "Next: you · review material & decide",
  });
  // An imported task with an unreadable identity is never called local.
  assert.equal(
    taskContext(
      read({ source: { repositoryName: null, number: null }, lead: null }),
      item("approval", "p"),
      true,
    ).source,
    "repository unavailable#?",
  );
  // Before the task read lands, the item's own action or attention code names the next actor.
  assert.deepEqual(taskContext(undefined, item("intervention", "p"), true), {
    source: null,
    lead: "Unavailable",
    next: "Next: you · inspect execution",
  });
  assert.equal(
    taskContext(
      undefined,
      { ...item("question", "p"), attentionCode: "question-delivery" },
      true,
    ).next,
    "Next: Ensemble · delivering answer",
  );
  // Once it lands, the task's codes and column name it, as on the List and the task page.
  for (const [codes, execution, request, next] of [
    [
      ["question-delivery"],
      "idle",
      "question",
      "Next: Ensemble · delivering answer",
    ],
    [
      ["question", "approval"],
      "idle",
      "question",
      "Next: you · review material & decide",
    ],
    [["question"], "uncertain", "question", "Next: you · inspect execution"],
    [
      ["unresolved-result", "approval"],
      "idle",
      "intervention",
      "Next: you · review material & decide",
    ],
  ] as const)
    assert.equal(
      taskContext(
        read({ source: null, lead: null }, [...codes], execution),
        item(request, "p"),
        true,
      ).next,
      next,
    );
  // A recorded or resolved request is no longer the operator's next action.
  assert.equal(taskContext(imported, item("question", "p"), false).next, null);
});
