import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import {
  DeliveryStore,
  type DeliveryCaller,
  isOperatorAction,
} from "../../src/core/delivery.js";
import { DomainStore } from "../../src/core/domain.js";
import type { jiraReadinessSchema } from "../../src/core/github-source-contracts.js";
import {
  GitHubSourceStore,
  type IssueSnapshot,
} from "../../src/core/github-source.js";
import { StatusMappingRefusal } from "../../src/core/status-mapping.js";
import { StatusMappingStore } from "../../src/core/status-mapping.js";
import type { StatusMapping } from "../../src/core/status-mapping-contracts.js";
import { Store } from "../../src/core/store.js";
import type { z } from "zod";

const instance = "example.atlassian.net";
const jira = { provider: "jira", instance } as const;
const TODO = "10003",
  PROGRESS = "3",
  REVIEW = "10004",
  DONE = "10005";
type Rule = z.output<typeof jiraReadinessSchema> | null;
const readyRule: Rule = {
  mode: "all",
  conditions: [
    { kind: "status", operator: "in", statusIds: [TODO, PROGRESS, REVIEW] },
    { kind: "label", operator: "has", name: "cab-ready" },
  ],
};
const issue = (status: string, over: Partial<IssueSnapshot> = {}) =>
  ({
    providerInstance: instance,
    nodeId: "20001",
    repositoryId: "10001",
    repositoryName: "KAN",
    number: 1,
    title: "Imported",
    body: "Ship this",
    state: "open",
    labels: ["cab-ready"],
    status: { id: status, name: `Status ${status}`, categoryKey: "new" },
    selectFields: [],
    projectFields: [],
    ...over,
  }) satisfies IssueSnapshot;
const mapping = (
  events: Partial<Extract<StatusMapping, { tracker: "jira" }>["events"]> = {},
): StatusMapping => ({
  tracker: "jira",
  events: {
    turnStarted: PROGRESS,
    handedBack: REVIEW,
    held: TODO,
    done: DONE,
    ...events,
  },
});

/** A Jira project whose rule makes an issue Ready while it is To Do, In Progress or In Review and labelled. */
function setup(rule: Rule = readyRule) {
  const db = new DatabaseSync(":memory:");
  new Store(db).ensureHost("test");
  const domain = new DomainStore(db);
  domain.migrate();
  const delivery = new DeliveryStore(db);
  const projectId = randomUUID();
  domain.execute({
    type: "project.create",
    actor: "operator",
    key: randomUUID(),
    projectId,
    name: "A",
    leadProfileId: null,
  });
  domain.execute({
    type: "issue-tracker-credential.configure",
    actor: "operator",
    key: randomUUID(),
    issueTracker: "jira",
    instance,
    credential: {
      siteRef: "env:FIXTURE_JIRA_SITE",
      emailRef: "env:FIXTURE_JIRA_EMAIL",
      tokenRef: "env:FIXTURE_JIRA_TOKEN",
    },
  });
  domain.execute({
    type: "jira.configure",
    actor: "operator",
    key: randomUUID(),
    projectId,
    expectedVersion: 1,
    instance,
    selections: [{ id: "S-1", kind: "jql", jql: "project = KAN" }],
    readiness: rule,
  });
  const sources = new GitHubSourceStore(db, jira);
  const read = (...issues: IssueSnapshot[]) =>
    sources.reconcileSelection(
      projectId,
      "S-1",
      { complete: true, issues, reason: null },
      {
        projectId,
        configVersion: domain.jiraConfiguration(projectId)?.version ?? 0,
        credentialRef: null,
      },
    );
  read(issue(TODO));
  const taskId = String(sources.issue("20001")?.taskId);
  const grant = (
    statusIds: string[],
    mode: "allow" | "approval" = "allow",
  ) => ({
    action: "issue.status" as const,
    repositoryId: "10001",
    mode,
    statusIds,
  });
  const configureGrants = (grants: ReturnType<typeof grant>[]) =>
    domain.execute({
      type: "delivery.configure",
      actor: "operator",
      key: randomUUID(),
      projectId,
      expectedVersion: delivery.configuration(projectId).version,
      mode: "reviewable-pr",
      credentialRef: null,
      grants,
      requiredChecks: [],
    });
  configureGrants([grant([TODO, PROGRESS, REVIEW, DONE])]);
  const status = new StatusMappingStore(db);
  const save = (input: StatusMapping | null, expectedVersion?: number) =>
    domain.execute({
      type: "status-mapping.configure",
      actor: "operator",
      key: randomUUID(),
      projectId,
      expectedVersion: expectedVersion ?? status.current(projectId).version,
      mapping: input,
    });
  const refusal = (reason: string, event: string | null) => (e: unknown) =>
    e instanceof StatusMappingRefusal &&
    e.reason === reason &&
    e.event === event;
  return {
    db,
    domain,
    delivery,
    sources,
    status,
    projectId,
    taskId,
    read,
    grant,
    configureGrants,
    save,
    refusal,
    caller: (
      event: "turnStarted" | "handedBack" | "held" | "done",
    ): DeliveryCaller => ({
      actor: "service",
      purpose: "status-mapping",
      projectId,
      taskId,
      mappingVersion: status.current(projectId).version,
      event,
    }),
    write: (
      statusId: string,
      expected: string | null = TODO,
      target: Partial<{ repositoryId: string; number: number }> = {},
    ) => ({
      operationId: randomUUID(),
      action: {
        kind: "issue.status" as const,
        target: {
          repositoryId: "10001",
          number: 1,
          nodeId: "20001",
          ...target,
        },
        statusId,
        expected: { statusId: expected },
      },
    }),
  };
}

test("a Jira mapping is refused for a status without an allow grant, naming the event", () => {
  const f = setup();
  try {
    f.configureGrants([f.grant([TODO, PROGRESS, DONE])]);
    assert.throws(
      () => f.save(mapping()),
      f.refusal("ungranted", "handedBack"),
    );
    f.configureGrants([
      f.grant([TODO, PROGRESS, DONE]),
      f.grant([REVIEW], "approval"),
    ]);
    assert.throws(
      () => f.save(mapping()),
      f.refusal("approval-only", "handedBack"),
    );
    // Nothing was saved by the refusals.
    assert.equal(f.status.current(f.projectId).version, 1);
    // A grant for another statuses list is not a grant for this status.
    f.configureGrants([f.grant([TODO]), f.grant([PROGRESS, REVIEW, DONE])]);
    assert.equal(f.save(mapping()).version, 2);
  } finally {
    f.db.close();
  }
});

test("an in-flight Jira status must keep the task Ready; terminal events may remove readiness", () => {
  const f = setup();
  try {
    assert.throws(
      () => f.save(mapping({ turnStarted: DONE })),
      f.refusal("readiness", "turnStarted"),
    );
    assert.throws(
      () => f.save(mapping({ handedBack: DONE })),
      f.refusal("readiness", "handedBack"),
    );
    // `held` and `done` are terminal, and Done is outside the rule.
    const saved = f.save(mapping({ held: DONE, done: DONE }));
    assert.equal(saved.version, 2);
    assert.deepEqual(saved.mapping, mapping({ held: DONE, done: DONE }));
  } finally {
    f.db.close();
  }
});

test("a not-in status rule refuses the excluded status, and a rule with no status condition accepts any granted one", () => {
  const notIn = setup({
    mode: "all",
    conditions: [{ kind: "status", operator: "not-in", statusIds: [DONE] }],
  });
  try {
    notIn.save(mapping({ turnStarted: PROGRESS, handedBack: REVIEW }));
    assert.throws(
      () => notIn.save(mapping({ turnStarted: DONE })),
      notIn.refusal("readiness", "turnStarted"),
    );
  } finally {
    notIn.db.close();
  }
  const any = setup({
    mode: "all",
    conditions: [{ kind: "label", operator: "has", name: "cab-ready" }],
  });
  try {
    assert.equal(any.save(mapping({ turnStarted: DONE })).version, 2);
  } finally {
    any.db.close();
  }
  // `any` mode: one holding condition is enough.
  const either = setup({
    mode: "any",
    conditions: [
      { kind: "status", operator: "in", statusIds: [PROGRESS] },
      { kind: "label", operator: "has", name: "other" },
    ],
  });
  try {
    assert.throws(
      () => either.save(mapping({ handedBack: REVIEW })),
      either.refusal("readiness", "handedBack"),
    );
  } finally {
    either.db.close();
  }
});

test("a Jira mapping binds to the Jira source: a GitHub mapping on a Jira project is refused, and availability follows the source", () => {
  const f = setup();
  try {
    assert.equal(f.status.availability(f.projectId), "available");
    assert.throws(
      () =>
        f.save({
          selectionId: "project",
          projectNodeId: "P_1",
          fieldNodeId: "F_1",
          events: {
            turnStarted: null,
            handedBack: null,
            held: null,
            done: null,
          },
        }),
      f.refusal("no-selection", null),
    );
    f.save(mapping());
    assert.equal(f.status.availability(f.projectId), "available");
    // The source stops being Jira: the mapping has nothing to bind to.
    f.db.exec(
      "UPDATE project_task_sources SET provider = 'github', instance = 'github.com'",
    );
    assert.equal(f.status.availability(f.projectId), "unavailable");
  } finally {
    f.db.close();
  }
});

test("a Jira mapping on a GitHub project is refused", () => {
  const db = new DatabaseSync(":memory:");
  new Store(db).ensureHost("test");
  const domain = new DomainStore(db);
  domain.migrate();
  const projectId = randomUUID();
  try {
    domain.execute({
      type: "project.create",
      actor: "operator",
      key: randomUUID(),
      projectId,
      name: "A",
      leadProfileId: null,
    });
    domain.execute({
      type: "github.configure",
      actor: "operator",
      key: randomUUID(),
      projectId,
      expectedVersion: 1,
      credentialRef: "env:TEST_GITHUB",
      selections: [
        { id: "project", kind: "project", projectNodeId: "P_1", filter: "" },
      ],
      readiness: null,
    });
    assert.throws(
      () =>
        domain.execute({
          type: "status-mapping.configure",
          actor: "operator",
          key: randomUUID(),
          projectId,
          expectedVersion: 1,
          mapping: mapping(),
        }),
      (e: unknown) =>
        e instanceof StatusMappingRefusal && e.reason === "no-selection",
    );
  } finally {
    db.close();
  }
});

test("a stale expected version conflicts, and saving null clears the Jira mapping", () => {
  const f = setup();
  try {
    f.save(mapping());
    assert.throws(() => f.save(mapping(), 1), /Version conflict/);
    const cleared = f.save(null);
    assert.equal(cleared.mapping, null);
    assert.equal(cleared.version, 3);
  } finally {
    f.db.close();
  }
});

test("a stored GitHub mapping without a tracker still parses as the GitHub variant", () => {
  const f = setup();
  try {
    f.db.prepare("INSERT INTO status_mappings VALUES (?, 2, ?)").run(
      f.projectId,
      JSON.stringify({
        selectionId: "project",
        projectNodeId: "P_1",
        fieldNodeId: "F_1",
        events: { turnStarted: "O", handedBack: null, held: null, done: null },
      }),
    );
    assert.equal(
      f.status.current(f.projectId).mapping?.events.turnStarted,
      "O",
    );
    assert.equal(f.status.availability(f.projectId), "unavailable");
  } finally {
    f.db.close();
  }
});

test("grants: issue.status needs statusIds and nothing else takes them", () => {
  const f = setup();
  try {
    assert.throws(
      () =>
        f.configureGrants([
          { ...f.grant([TODO]), statusIds: undefined } as never,
        ]),
      /statusIds/,
    );
    assert.throws(
      () => f.configureGrants([{ ...f.grant([TODO]), statusIds: [] }]),
      /statusIds/,
    );
    assert.throws(
      () =>
        f.configureGrants([
          {
            action: "issue.comment",
            repositoryId: "10001",
            mode: "allow",
            statusIds: [TODO],
          } as never,
        ]),
      /statusIds/,
    );
  } finally {
    f.db.close();
  }
});

test("only the service may write an issue status, and only the mapped one for a Ready task", () => {
  const f = setup();
  try {
    f.save(mapping());
    const runtime = {
      projectId: f.projectId,
      taskId: f.taskId,
      taskVersion: 1,
      assignmentId: randomUUID(),
      assignmentVersion: 1,
      workId: "work",
      workRevision: 1,
      conversationRevision: 1,
    };
    assert.throws(
      () => f.delivery.authorize(f.write(PROGRESS), runtime, false),
      /issue status/,
    );
    // The operator's caller takes only a bound comment or edit, never a status.
    assert.equal(isOperatorAction(f.write(PROGRESS).action), false);
    const allowed = f.delivery.prepareAction(
      f.write(PROGRESS),
      f.caller("turnStarted"),
      false,
    );
    assert.equal(allowed.state, "prepared");
    f.delivery.recordObservation(allowed.operationId, {
      state: "confirmed-failure",
      reason: "test",
      receipt: null,
    });
    for (const [event, request] of [
      // A status the event is not mapped to.
      ["turnStarted", f.write(REVIEW)],
      // Another issue.
      ["turnStarted", f.write(PROGRESS, TODO, { number: 2 })],
      // Another kind of action.
      [
        "turnStarted",
        {
          operationId: randomUUID(),
          action: {
            kind: "issue.comment" as const,
            target: { repositoryId: "10001", number: 1, nodeId: "20001" },
            body: "Hello",
          },
        },
      ],
    ] as const)
      assert.equal(
        f.delivery.prepareAction(request, f.caller(event), false).state,
        "denied",
        JSON.stringify(request.action),
      );
    // A stale mapping version no longer authorizes.
    f.save(mapping());
    assert.equal(
      f.delivery.prepareAction(
        f.write(PROGRESS),
        {
          ...(f.caller("turnStarted") as { mappingVersion: number }),
          mappingVersion: 2,
        } as DeliveryCaller,
        false,
      ).state,
      "denied",
    );
  } finally {
    f.db.close();
  }
});

test("an issue in another Jira project is denied at write time", () => {
  const f = setup();
  try {
    f.save(mapping());
    f.configureGrants([
      { ...f.grant([TODO, PROGRESS, REVIEW, DONE]), repositoryId: "10002" },
    ]);
    const record = f.delivery.prepareAction(
      f.write(PROGRESS),
      f.caller("turnStarted"),
      false,
    );
    assert.equal(record.state, "denied");
    assert.equal(record.observation?.reason, "delivery-authority-denied");
  } finally {
    f.db.close();
  }
});

test("an in-flight write is checked against the readiness rule and the stored status at write time", () => {
  const f = setup();
  try {
    f.save(mapping());
    // The rule narrows after the save: only To Do is Ready now.
    f.domain.execute({
      type: "jira.configure",
      actor: "operator",
      key: randomUUID(),
      projectId: f.projectId,
      expectedVersion: Number(f.domain.jiraConfiguration(f.projectId)?.version),
      instance,
      selections: [{ id: "S-1", kind: "jql", jql: "project = KAN" }],
      readiness: {
        mode: "all",
        conditions: [{ kind: "status", operator: "in", statusIds: [TODO] }],
      },
    });
    f.read(issue(TODO));
    assert.equal(f.domain.task(f.taskId).ready, 1);
    assert.equal(
      f.delivery.prepareAction(
        f.write(PROGRESS),
        f.caller("turnStarted"),
        false,
      ).state,
      "denied",
    );
    // A terminal event may still remove readiness, for a task the mapping has watched.
    f.status.watch(f.taskId);
    assert.equal(
      f.delivery.prepareAction(f.write(DONE), f.caller("done"), false).state,
      "prepared",
    );
  } finally {
    f.db.close();
  }
});

test("a task that is not Ready is written only for Done on a closed issue, against the status last observed", () => {
  const f = setup();
  try {
    f.save(mapping());
    f.read(issue(DONE, { state: "closed" }));
    assert.equal(f.domain.task(f.taskId).ready, 0);
    const attempt = (
      event: "turnStarted" | "done",
      id: string,
      expected: string | null,
    ) => {
      const record = f.delivery.prepareAction(
        f.write(id, expected),
        f.caller(event),
        false,
      );
      if (record.state === "prepared")
        f.delivery.recordObservation(record.operationId, {
          state: "confirmed-failure",
          reason: "test",
          receipt: null,
        });
      return record.state;
    };
    assert.equal(attempt("done", DONE, PROGRESS), "denied");
    f.domain.execute({
      type: "task.configure",
      actor: "operator",
      key: randomUUID(),
      projectId: f.projectId,
      taskId: f.taskId,
      expectedVersion: Number(f.domain.task(f.taskId).version),
      state: "done",
    });
    // First seen that way: not worked on under the mapping.
    assert.equal(attempt("done", DONE, PROGRESS), "denied");
    f.status.watch(f.taskId);
    // Nothing observed yet, or a status other than the one cab last saw.
    assert.equal(attempt("done", DONE, PROGRESS), "denied");
    f.status.observed(f.taskId, PROGRESS);
    assert.equal(attempt("done", DONE, TODO), "denied");
    assert.equal(attempt("done", DONE, null), "denied");
    assert.equal(attempt("done", DONE, PROGRESS), "prepared");
    assert.equal(attempt("turnStarted", PROGRESS, PROGRESS), "denied");
    // A status the readiness rule accepts would make the task Ready: never written.
    f.save(mapping({ done: REVIEW }));
    assert.equal(attempt("done", REVIEW, PROGRESS), "denied");
  } finally {
    f.db.close();
  }
});
