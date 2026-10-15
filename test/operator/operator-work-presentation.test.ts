import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import {
  taskSourceSummarySchema,
  type InboxItem,
  type TaskListSummary,
} from "../../src/operator/contracts.js";
import {
  activeColumns,
  attentionCandidate,
  columnCounts,
  columns,
  filterTasks,
  operatorNext,
  parseTaskFilters,
  readyButBlocked,
  taskColumn,
  taskNext,
  taskReasons,
  taskRouteSubtitle,
  visibleColumns,
} from "../../web/src/tasks.js";
import {
  interventionRequester,
  requestActionLabel,
  requestHref,
  requestKindLabel,
  requestMeta,
  requestTime,
} from "../../web/src/request-presentation.js";
import { summary, type Overrides } from "../fixtures/task-summary.js";

test("an imported Draft task names its unmet readiness conditions; other tasks keep the generic reason", () => {
  const label = (name: string) => ({ kind: "label", name });
  const field = {
    kind: "project-field",
    projectNodeId: "P_1",
    fieldNodeId: "F_1",
    optionNodeId: "O_1",
  };
  const draft = (readiness?: object, closure: "held" | null = null) =>
    summary({ ready: false, closure, reasons: ["task-unready"], readiness });
  const unmet = (mode: string, conditions: object[], missing: object[]) =>
    taskReasons(
      draft({
        rule: { kind: "rule", mode, conditions },
        outcome: "unmet",
        unmet: missing,
      }),
    );
  assert.deepEqual(unmet("all", [label("ready")], [label("ready")]), [
    "Not Ready: missing label `ready`",
  ]);
  assert.deepEqual(unmet("all", [label("a"), field], [label("a"), field]), [
    "Not Ready: missing label `a`, Project field F_1 = O_1",
  ]);
  assert.deepEqual(
    unmet("any", [label("a"), label("b")], [label("a"), label("b")]),
    ["Not Ready: needs any of label `a`, label `b`"],
  );
  const rule = { kind: "rule", mode: "all", conditions: [label("a")] };
  for (const task of [
    draft({ rule, outcome: "matched", unmet: [] }),
    draft({ rule, outcome: "not-evaluated", unmet: [] }),
    summary({ ready: false, reasons: ["task-unready"] }),
  ]) {
    assert.deepEqual(taskReasons(task), ["Draft: not Ready"]);
    assert.equal(taskColumn(task), "Draft");
  }
  const held = draft({ rule, outcome: "not-evaluated", unmet: [] }, "held");
  assert.deepEqual(taskReasons(held), ["Held · closed on GitHub"]);
  assert.equal(
    taskColumn(draft({ rule, outcome: "unmet", unmet: [label("a")] })),
    "Draft",
  );
});

test("closure provenance places held tasks in Paused and names provider completion", () => {
  for (const ready of [true, false]) {
    const held = summary({
      ready,
      closure: "held",
      reasons: ["task-unready", "source-held"],
    });
    assert.equal(taskColumn(held), "Paused");
    assert.ok(taskReasons(held).includes("Held · closed on GitHub"));
    assert.equal(taskReasons(held).includes("Draft: not Ready"), false);
  }
  const completed = summary({ state: "done", closure: "completed" });
  assert.equal(taskColumn(completed), "Done");
  assert.ok(
    taskReasons(completed).includes(
      "Closed on GitHub, not delivered by Ensemble",
    ),
  );
  for (const plain of [
    summary({ state: "done", closure: null }),
    summary({ state: "done" }),
  ]) {
    assert.equal(taskColumn(plain), "Done");
    assert.equal(
      taskReasons(plain).some((reason) => reason.includes("GitHub")),
      false,
    );
  }
});

test("columns follow the design order and Active tasks hides only terminal work", () => {
  assert.deepEqual(
    [...columns],
    [
      "Ready",
      "Running",
      "Waiting",
      "Paused",
      "Stopping",
      "Uncertain",
      "Draft",
      "Done",
      "Cancelled",
    ],
  );
  assert.deepEqual([...activeColumns], columns.slice(0, 7));
  assert.deepEqual([...visibleColumns("")], [...activeColumns]);
  assert.deepEqual([...visibleColumns("all")], [...columns]);
  assert.deepEqual([...visibleColumns("Done")], [...activeColumns, "Done"]);
  assert.deepEqual([...visibleColumns("Stopping")], [...activeColumns]);
  const tasks = [
    summary(),
    summary({ execution: "running" }),
    summary({ state: "done" }),
    summary({ state: "cancelled" }),
    summary({ ready: false }),
  ];
  const counts = columnCounts(tasks);
  assert.equal(counts.Ready, 1);
  assert.equal(counts.Running, 1);
  assert.equal(counts.Draft, 1);
  assert.equal(
    Object.values(counts).reduce((a, b) => a + b, 0),
    tasks.length,
  );
  assert.equal(filterTasks(tasks, parseTaskFilters("")).length, 3);
  assert.equal(filterTasks(tasks, parseTaskFilters("?state=all")).length, 5);
  assert.equal(filterTasks(tasks, parseTaskFilters("?state=Done")).length, 1);
});

test("the next actor is derived from recorded attention and state only", () => {
  const next = (o: Overrides) => taskNext(summary(o));
  assert.equal(next({ codes: ["question"] }), "Next: you · answer question");
  assert.equal(
    next({ codes: ["approval"] }),
    "Next: you · review material & decide",
  );
  assert.equal(
    next({ codes: ["question", "execution-uncertain"] }),
    "Next: you · inspect execution",
  );
  assert.equal(next({ codes: ["lead-review"] }), "Next: you · review task");
  assert.equal(next({ state: "done" }), "Next: none · no decision");
  assert.equal(next({ state: "cancelled" }), "Next: none · history retained");
  assert.equal(next({}), "No operator decision");
  // The Uncertain column alone (no attention code) reads the same in the row and the bar.
  const columnOnly = summary({ execution: "uncertain" });
  assert.equal(taskNext(columnOnly), "Next: you · inspect execution");
  assert.equal(attentionCandidate([summary(), columnOnly]), columnOnly);
});

test("only Ready work that admission holds keeps its Ready label in Waiting", () => {
  const held = summary({ ready: true, reasons: ["local-dependency"] });
  assert.equal(taskColumn(held), "Waiting");
  assert.equal(readyButBlocked(held), true);
  // Waiting on a decision with eligible admission is not the dependency-blocked card.
  const deciding = summary({ ready: true, execution: "waiting" });
  assert.equal(taskColumn(deciding), "Waiting");
  assert.equal(readyButBlocked(deciding), false);
  for (const other of [
    summary({ ready: false }),
    summary(),
    summary({ execution: "running" }),
    summary({ paused: true, reasons: ["project-paused"] }),
  ])
    assert.equal(readyButBlocked(other), false, taskColumn(other));
});

test("the operator is next only while an attention code names them", () => {
  assert.equal(operatorNext(summary({ codes: ["question"] })), true);
  assert.equal(operatorNext(summary({ codes: ["approval"] })), true);
  assert.equal(operatorNext(summary()), false);
});

test("source summaries only accept https links", () => {
  const source = (url: string | null) =>
    taskSourceSummarySchema.safeParse({
      identity: { provider: "github.com", nodeId: "n", repositoryId: "r" },
      repositoryName: "a/b",
      number: 1,
      url,
      state: "open",
      closure: null,
      readiness: {
        rule: { kind: "none" },
        outcome: "not-evaluated",
        unmet: [],
      },
    }).success;
  assert.equal(source("https://github.com/a/b/issues/1"), true);
  assert.equal(source(null), true);
  for (const bad of ["javascript:alert(1)", "http://x", "data:text/html,x"])
    assert.equal(source(bad), false);
});

test("route subtitles count active tasks and name the accountable lead", () => {
  const a = randomUUID(),
    b = randomUUID(),
    lead = randomUUID();
  const workspace = {
    projects: [
      { id: a, leadProfileId: lead },
      { id: b, leadProfileId: null },
    ],
    profiles: [{ id: lead, name: "Mira Chen" }],
  };
  const tasks = [
    summary({ projectId: a }),
    summary({ projectId: a, execution: "running" }),
    summary({ projectId: b }),
    summary({ projectId: b, state: "done" }),
  ];
  assert.equal(
    taskRouteSubtitle("tasks", tasks, workspace),
    "3 active tasks · 2 projects",
  );
  assert.equal(
    taskRouteSubtitle("tasks", [tasks[0] as TaskListSummary], {
      ...workspace,
      projects: [workspace.projects[0] as never],
    }),
    "1 active task · 1 project",
  );
  assert.equal(
    taskRouteSubtitle("project", tasks, workspace, a),
    "2 active tasks · accountable lead Mira Chen",
  );
  assert.equal(
    taskRouteSubtitle("project", tasks, workspace, b),
    "1 active task · no accountable lead",
  );
  assert.equal(taskRouteSubtitle("tasks", undefined, workspace), undefined);
  assert.equal(
    taskRouteSubtitle("overview", undefined, null),
    "Decisions first. Work and completed results stay separate.",
  );
});

test("the attention summary prefers uncertain ownership, then Stopping, and ignores terminal work", () => {
  const stopping = summary({ execution: "stopping" }),
    uncertain = summary({
      codes: ["execution-uncertain"],
      execution: "stopping",
    });
  assert.equal(attentionCandidate([stopping, uncertain]), uncertain);
  assert.equal(attentionCandidate([summary(), stopping]), stopping);
  assert.equal(
    attentionCandidate([
      summary({ state: "done", codes: ["execution-uncertain"] }),
      summary({ state: "cancelled" }),
    ]),
    null,
  );
  assert.equal(attentionCandidate([]), null);
});

test("request wording is exhaustive and links match the Inbox selection", () => {
  const kinds: InboxItem["kind"][] = ["question", "approval", "intervention"];
  assert.deepEqual(kinds.map(requestKindLabel), [
    "Question",
    "Approval",
    "Intervention",
  ]);
  assert.deepEqual(kinds.map(requestActionLabel), [
    "Answer question",
    "Review material & decide",
    "Inspect execution",
  ]);
  const taskId = randomUUID();
  const item = (kind: InboxItem["kind"], rest: object = {}) => ({
    id: "interaction:1/x",
    kind,
    taskId,
    destination:
      kind === "approval"
        ? `/coordination/task/${taskId}#a`
        : `/app/tasks/${taskId}`,
    requesterName: "Jonas",
    createdAt: new Date(2026, 9, 9, 9, 5).getTime(),
    ...rest,
  });
  assert.equal(
    requestHref(item("question")),
    `/app/inbox?task=${taskId}&request=interaction%3A1%2Fx`,
  );
  assert.equal(requestHref(item("approval")), `/coordination/task/${taskId}#a`);
  assert.equal(requestHref(item("intervention")), `/app/tasks/${taskId}`);
  assert.equal(requestMeta(item("question")), "Question · Jonas · 09:05");
  assert.equal(
    requestMeta(item("intervention", { requesterName: null, createdAt: null })),
    "Intervention · Responsibility unknown · Age unknown",
  );
  assert.equal(requestTime(null), "Age unknown");
  // Only an intervention names who is responsible for execution; a question's requester does not.
  const other = { taskId, kind: "question", requesterName: "Nora" } as const;
  assert.equal(interventionRequester([other], taskId), null);
  assert.equal(
    interventionRequester(
      [other, { ...other, kind: "intervention", requesterName: "Jonas" }],
      taskId,
    ),
    "Jonas",
  );
  assert.equal(
    interventionRequester(
      [{ ...other, kind: "intervention", requesterName: null }],
      taskId,
    ),
    null,
  );
  assert.equal(
    interventionRequester(
      [{ ...other, kind: "intervention", taskId: randomUUID() }],
      taskId,
    ),
    null,
  );
});
