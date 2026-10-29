import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import {
  DeliveryStore,
  type DeliveryCaller,
  materialDigest,
} from "../../src/core/delivery.js";
import { DomainStore } from "../../src/core/domain.js";
import { GitHubSourceStore } from "../../src/core/github-source.js";
import { StatusMappingRefusal } from "../../src/core/status-mapping.js";
import { StatusMappingStore } from "../../src/core/status-mapping.js";
import type { StatusMapping } from "../../src/core/status-mapping-contracts.js";
import { Store } from "../../src/core/store.js";

type ServiceCaller = Extract<DeliveryCaller, { actor: "service" }>;
import type { IssueSnapshot } from "../../src/standalone/github-source.js";

const P = "P_1",
  F = "F_STATUS",
  TODO = "O_TODO",
  PROGRESS = "O_PROGRESS",
  REVIEW = "O_REVIEW",
  DONE = "O_DONE";
const issue = (status: string): IssueSnapshot => ({
  providerInstance: "github.com",
  nodeId: "I_1",
  repositoryId: "R_1",
  repositoryName: "org/repo",
  number: 1,
  title: "Imported",
  body: "Ship this",
  state: "open",
  labels: [],
  projectFields: [{ projectNodeId: P, fieldNodeId: F, optionNodeId: status }],
  projectItemNodeId: "ITEM_1",
});
const mapping = (
  events: Partial<StatusMapping["events"]> = {},
): StatusMapping => ({
  selectionId: "project",
  projectNodeId: P,
  fieldNodeId: F,
  events: {
    turnStarted: PROGRESS,
    handedBack: REVIEW,
    held: TODO,
    done: DONE,
    ...events,
  },
});

/** A project whose `project` selection is Ready while Status is Todo, In progress or In review. */
function setup(
  options: { selection?: boolean; mode?: "allow" | "approval" } = {},
) {
  const db = new DatabaseSync(":memory:");
  new Store(db).ensureHost("test");
  const domain = new DomainStore(db);
  domain.migrate();
  const sources = new GitHubSourceStore(db);
  sources.migrate();
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
    type: "github.configure",
    actor: "operator",
    key: randomUUID(),
    projectId,
    expectedVersion: 1,
    credentialRef: "env:TEST_GITHUB",
    selections:
      options.selection === false
        ? [{ id: "repo", kind: "search", query: "repo:org/repo" }]
        : [{ id: "project", kind: "project", projectNodeId: P, filter: "" }],
    readiness: {
      mode: "any",
      conditions: [TODO, PROGRESS, REVIEW].map((optionNodeId) => ({
        kind: "project-field" as const,
        projectNodeId: P,
        fieldNodeId: F,
        operator: "in" as const,
        optionNodeIds: [optionNodeId],
      })),
    },
  });
  const selectionId = options.selection === false ? "repo" : "project";
  domain.execute({
    type: "github.activate",
    actor: "operator",
    key: randomUUID(),
    projectId,
    selectionId,
    expectedVersion: 2,
  });
  sources.reconcileSelection(projectId, selectionId, {
    complete: true,
    issues: [issue(TODO)],
    reason: null,
  });
  const taskId = String(sources.issue("I_1")?.taskId);
  const grant = (optionNodeIds: string[], mode = options.mode ?? "allow") => ({
    action: "project.field" as const,
    repositoryId: "R_1",
    mode,
    projectNodeId: P,
    fieldNodeId: F,
    optionNodeIds,
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
  const save = (input: StatusMapping | null, expectedVersion?: number) =>
    domain.execute({
      type: "status-mapping.configure",
      actor: "operator",
      key: randomUUID(),
      projectId,
      expectedVersion:
        expectedVersion ??
        new StatusMappingStore(db).current(projectId).version,
      mapping: input,
    });
  return {
    db,
    domain,
    sources,
    delivery,
    projectId,
    taskId,
    selectionId,
    grant,
    configureGrants,
    save,
    status: new StatusMappingStore(db),
    caller: (
      event: "turnStarted" | "handedBack" | "held" | "done",
    ): DeliveryCaller => ({
      actor: "service",
      purpose: "status-mapping",
      projectId,
      taskId,
      mappingVersion: new StatusMappingStore(db).current(projectId).version,
      event,
    }),
    write: (optionNodeId: string, extra: Record<string, unknown> = {}) => ({
      operationId: randomUUID(),
      action: {
        kind: "project.field" as const,
        target: { repositoryId: "R_1", number: 1, nodeId: "I_1" },
        projectNodeId: P,
        itemNodeId: "ITEM_1",
        fieldNodeId: F,
        optionNodeId,
        ...extra,
      },
    }),
  };
}

type Readiness = Extract<
  Parameters<DomainStore["execute"]>[0],
  { type: "github.configure" }
>["readiness"];
/** Re-saves the GitHub source (version 2 to 3) and reactivates its selection. */
function reconfigureReadiness(
  f: ReturnType<typeof setup>,
  readiness: Readiness,
) {
  f.domain.execute({
    type: "github.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: f.projectId,
    expectedVersion: 2,
    selections: [
      { id: "project", kind: "project", projectNodeId: P, filter: "" },
    ],
    readiness,
  });
  f.domain.execute({
    type: "github.activate",
    actor: "operator",
    key: randomUUID(),
    projectId: f.projectId,
    selectionId: "project",
    expectedVersion: 3,
  });
}

test("saving a mapping refuses an ungranted or approval-only option, naming the event and option", () => {
  const f = setup();
  try {
    f.configureGrants([f.grant([TODO, PROGRESS, REVIEW])]);
    assert.throws(
      () => f.save(mapping()),
      (error: unknown) =>
        error instanceof StatusMappingRefusal &&
        error.reason === "ungranted" &&
        error.event === "done" &&
        error.optionNodeId === DONE,
    );
    f.configureGrants([
      f.grant([TODO, PROGRESS, DONE]),
      f.grant([REVIEW], "approval"),
    ]);
    assert.throws(
      () => f.save(mapping()),
      (error: unknown) =>
        error instanceof StatusMappingRefusal &&
        error.reason === "approval-only" &&
        error.event === "handedBack" &&
        error.optionNodeId === REVIEW,
    );
    // Nothing was saved by the refusals.
    assert.equal(f.status.current(f.projectId).version, 1);
  } finally {
    f.db.close();
  }
});

test("an in-flight event may name only an option the readiness rule accepts; terminal events may remove readiness", () => {
  const f = setup();
  try {
    assert.throws(
      () => f.save(mapping({ turnStarted: DONE })),
      (error: unknown) =>
        error instanceof StatusMappingRefusal &&
        error.reason === "readiness" &&
        error.event === "turnStarted" &&
        error.optionNodeId === DONE,
    );
    assert.throws(
      () => f.save(mapping({ handedBack: DONE })),
      (error: unknown) =>
        error instanceof StatusMappingRefusal && error.event === "handedBack",
    );
    // `held` and `done` are terminal: Done is not in the readiness rule.
    const saved = f.save(mapping({ held: DONE, done: DONE }));
    assert.equal(saved.version, 2);
    assert.equal(saved.mapping?.events.done, DONE);
  } finally {
    f.db.close();
  }
});

test("a rule needing both a label and a Status accepts an in-flight option the Status condition names", () => {
  const f = setup();
  try {
    reconfigureReadiness(f, {
      mode: "all",
      conditions: [
        { kind: "label", operator: "has", name: "ready" },
        {
          kind: "project-field",
          projectNodeId: P,
          fieldNodeId: F,
          operator: "in",
          optionNodeIds: [TODO],
        },
      ],
    });
    assert.throws(
      () => f.save(mapping({ turnStarted: PROGRESS })),
      StatusMappingRefusal,
    );
    f.save(mapping({ turnStarted: TODO, handedBack: null }));
  } finally {
    f.db.close();
  }
});

const fieldRule = (operator: "in" | "not-in", optionNodeIds: string[]) => ({
  mode: "all" as const,
  conditions: [
    {
      kind: "project-field" as const,
      projectNodeId: P,
      fieldNodeId: F,
      operator,
      optionNodeIds,
    },
  ],
});

test("an in-flight option in the rule's in set is accepted at save and at write; one outside it is refused", () => {
  const f = setup();
  try {
    reconfigureReadiness(f, fieldRule("in", [TODO, PROGRESS]));
    f.save(mapping({ turnStarted: PROGRESS, handedBack: TODO }));
    assert.throws(
      () => f.save(mapping({ handedBack: REVIEW })),
      (error: unknown) =>
        error instanceof StatusMappingRefusal &&
        error.reason === "readiness" &&
        error.optionNodeId === REVIEW,
    );
    f.sources.reconcileSelection(f.projectId, f.selectionId, {
      complete: true,
      issues: [issue(TODO)],
      reason: null,
    });
    const write = (option: string, event: "turnStarted" | "handedBack") =>
      f.delivery.prepareAction(f.write(option), f.caller(event), false).state;
    assert.equal(write(PROGRESS, "turnStarted"), "prepared");
    assert.equal(write(REVIEW, "handedBack"), "denied");
  } finally {
    f.db.close();
  }
});

test("an in-flight option is accepted under not-in unless the set names it", () => {
  const f = setup();
  try {
    reconfigureReadiness(f, fieldRule("not-in", [DONE]));
    f.save(mapping({ turnStarted: PROGRESS, handedBack: REVIEW }));
    assert.throws(
      () => f.save(mapping({ handedBack: DONE })),
      StatusMappingRefusal,
    );
  } finally {
    f.db.close();
  }
});

test("a source without the mapping's Project selection reads unavailable and refuses a save", () => {
  const f = setup({ selection: false });
  try {
    assert.equal(f.status.availability(f.projectId), "unavailable");
    assert.throws(
      () => f.save(mapping()),
      (error: unknown) =>
        error instanceof StatusMappingRefusal &&
        error.reason === "no-selection",
    );
  } finally {
    f.db.close();
  }
});

test("a stale expected version conflicts, and saving null clears the mapping", () => {
  const f = setup();
  try {
    assert.equal(f.status.availability(f.projectId), "available");
    f.save(mapping());
    assert.throws(() => f.save(mapping(), 1), /Version conflict/);
    const cleared = f.save(null);
    assert.equal(cleared.mapping, null);
    assert.equal(cleared.version, 3);
    assert.deepEqual(f.domain.statusMapping(f.projectId).mapping, null);
  } finally {
    f.db.close();
  }
});

test("only an operator saves a mapping", () => {
  const f = setup();
  try {
    assert.throws(
      () =>
        f.domain.execute({
          type: "status-mapping.configure",
          actor: "agent",
          key: randomUUID(),
          projectId: f.projectId,
          expectedVersion: 1,
          mapping: mapping(),
        }),
      /operator/i,
    );
  } finally {
    f.db.close();
  }
});

test("the service caller writes a mapped option for a Ready task and nothing else", () => {
  const f = setup();
  try {
    f.save(mapping());
    const allowed = f.delivery.prepareAction(
      f.write(PROGRESS),
      f.caller("turnStarted"),
      false,
    );
    assert.equal(allowed.state, "prepared");
    for (const [event, request] of [
      // An option the event is not mapped to.
      ["turnStarted", f.write(REVIEW)],
      // Another kind of action.
      [
        "turnStarted",
        {
          operationId: randomUUID(),
          action: {
            kind: "issue.comment" as const,
            target: { repositoryId: "R_1", number: 1, nodeId: "I_1" },
            body: "Hello",
          },
        },
      ],
      // Another item.
      ["turnStarted", f.write(PROGRESS, { itemNodeId: "ITEM_2" })],
    ] as const) {
      f.delivery.recordObservation(allowed.operationId, {
        state: "confirmed-failure",
        reason: "test",
        receipt: null,
      });
      assert.equal(
        f.delivery.prepareAction(request, f.caller(event), false).state,
        "denied",
        JSON.stringify(request.action),
      );
    }
    // A stale mapping version no longer authorizes.
    f.save(mapping());
    assert.equal(
      f.delivery.prepareAction(
        f.write(PROGRESS),
        { ...(f.caller("turnStarted") as ServiceCaller), mappingVersion: 2 },
        false,
      ).state,
      "denied",
    );
  } finally {
    f.db.close();
  }
});

test("the service caller cannot write for a task that is not Ready, and cannot make one Ready", () => {
  const f = setup();
  try {
    f.save(mapping());
    // Status Done is outside the readiness rule, so the task is no longer Ready.
    f.sources.reconcileSelection(f.projectId, f.selectionId, {
      complete: true,
      issues: [issue(DONE)],
      reason: null,
    });
    assert.equal(f.domain.task(f.taskId).ready, 0);
    for (const [event, option] of [
      ["turnStarted", PROGRESS],
      ["done", DONE],
    ] as const)
      assert.equal(
        f.delivery.prepareAction(f.write(option), f.caller(event), false).state,
        "denied",
        event,
      );
  } finally {
    f.db.close();
  }
});

test("Done is written for a done task whose issue is closed, never for another not-Ready task, and never an option the rule accepts", () => {
  const f = setup();
  try {
    f.save(mapping());
    const closed = { ...issue(TODO), state: "closed" as const };
    f.sources.reconcileSelection(f.projectId, f.selectionId, {
      complete: true,
      issues: [closed],
      reason: null,
    });
    assert.equal(f.domain.task(f.taskId).ready, 0);
    const attempt = (
      event: "turnStarted" | "done",
      option: string,
      expected?: string | null,
    ) => {
      const record = f.delivery.prepareAction(
        f.write(
          option,
          expected === undefined
            ? {}
            : { expected: { optionNodeId: expected } },
        ),
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
    // Closed but not done: nothing.
    assert.equal(attempt("done", DONE), "denied");
    f.domain.execute({
      type: "task.configure",
      actor: "operator",
      key: randomUUID(),
      projectId: f.projectId,
      taskId: f.taskId,
      expectedVersion: Number(f.domain.task(f.taskId).version),
      state: "done",
    });
    // Done and closed, but first seen that way: not worked on under the mapping.
    assert.equal(attempt("done", DONE), "denied");
    f.status.watch(f.taskId);
    // Nothing observed yet, or a Status other than the one cab last wrote: a human moved it.
    assert.equal(attempt("done", DONE, PROGRESS), "denied");
    f.status.observed(f.taskId, PROGRESS);
    assert.equal(attempt("done", DONE), "denied");
    assert.equal(attempt("done", DONE, null), "denied");
    assert.equal(attempt("done", DONE, TODO), "denied");
    // Done and closed, against the Status cab last wrote: the mapped Done option is written.
    assert.equal(attempt("done", DONE, PROGRESS), "prepared");
    assert.equal(attempt("turnStarted", PROGRESS), "denied");
    // An option the readiness rule accepts is a Ready option: never written for a not-Ready task.
    f.save(mapping({ done: REVIEW }));
    assert.equal(attempt("done", REVIEW, PROGRESS), "denied");
    // Done, not Ready, but the issue is still open: nothing.
    f.save(mapping());
    f.sources.reconcileSelection(f.projectId, f.selectionId, {
      complete: true,
      issues: [issue(DONE)],
      reason: null,
    });
    assert.equal(f.domain.task(f.taskId).ready, 0);
    assert.equal(attempt("done", DONE, PROGRESS), "denied");
  } finally {
    f.db.close();
  }
});

test("an in-flight write is checked against the readiness rule at write time", () => {
  const f = setup();
  try {
    f.save(mapping());
    // The rule narrows after the save: only Todo is Ready now.
    reconfigureReadiness(f, {
      mode: "all",
      conditions: [
        {
          kind: "project-field",
          projectNodeId: P,
          fieldNodeId: F,
          operator: "in",
          optionNodeIds: [TODO],
        },
      ],
    });
    f.sources.reconcileSelection(f.projectId, f.selectionId, {
      complete: true,
      issues: [issue(TODO)],
      reason: null,
    });
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

test("a grant revoked after the save denies the write", () => {
  const f = setup();
  try {
    f.save(mapping());
    f.configureGrants([f.grant([TODO, REVIEW, DONE])]);
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

test("an approval-mode grant created after the save fails closed for the service", () => {
  const f = setup();
  try {
    f.save(mapping());
    f.configureGrants([f.grant([TODO, PROGRESS, REVIEW, DONE], "approval")]);
    assert.equal(
      f.delivery.prepareAction(
        f.write(PROGRESS),
        f.caller("turnStarted"),
        false,
      ).state,
      "denied",
    );
  } finally {
    f.db.close();
  }
});

test("agent and operator callers still cannot write a readiness field", () => {
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
      /readiness fields/,
    );
    assert.equal(
      f.delivery.prepareAction(f.write(PROGRESS), runtime, false).state,
      "denied",
    );
  } finally {
    f.db.close();
  }
});

test("a status write in flight defers the next one, an unproved one does not hold the task or the mapping", () => {
  const f = setup();
  try {
    f.save(mapping());
    const first = f.delivery.prepareAction(
      f.write(PROGRESS),
      f.caller("turnStarted"),
      false,
    );
    // Still prepared: the next status write waits for it.
    assert.deepEqual(f.delivery.serviceActionBlockers(f.taskId), [
      "external-action-prepared",
    ]);
    assert.equal(
      f.delivery.prepareAction(f.write(REVIEW), f.caller("handedBack"), false)
        .state,
      "denied",
    );
    f.delivery.beginAttempt(first.operationId, {});
    f.delivery.recordObservation(first.operationId, {
      state: "uncertain",
      reason: "provider-effect-unproved",
      receipt: null,
    });
    assert.deepEqual(f.delivery.actionBlockers(f.taskId), []);
    assert.deepEqual(f.delivery.completionBlockers(f.taskId), []);
    assert.deepEqual(
      f.domain
        .admission(f.taskId)
        .reasons.filter((reason) => reason.startsWith("external-action-")),
      [],
    );
    assert.deepEqual(f.delivery.serviceActionBlockers(f.taskId), []);
    // The next write's own re-read of the Status guards against a moved card.
    const second = f.delivery.prepareAction(
      f.write(REVIEW),
      f.caller("handedBack"),
      false,
    );
    assert.equal(second.state, "prepared");
    // Proof of the older write after the newer one exists does not become the observed Status.
    f.delivery.recordObservation(first.operationId, {
      state: "confirmed-success",
      reason: null,
      receipt: { nodeId: "I_1" },
    });
    assert.equal(f.status.taskState(f.taskId).observedOptionNodeId, null);
    f.delivery.beginAttempt(second.operationId, {});
    f.delivery.recordObservation(second.operationId, {
      state: "confirmed-success",
      reason: null,
      receipt: { nodeId: "I_1" },
    });
    assert.equal(f.status.taskState(f.taskId).observedOptionNodeId, REVIEW);
  } finally {
    f.db.close();
  }
});

test("a late proof of the last write that may have landed is observed even after a later record that sent nothing", () => {
  const f = setup();
  try {
    f.save(mapping());
    const first = f.delivery.prepareAction(
      f.write(PROGRESS),
      f.caller("turnStarted"),
      false,
    );
    f.delivery.beginAttempt(first.operationId, {});
    f.delivery.recordObservation(first.operationId, {
      state: "uncertain",
      reason: "provider-readback-unavailable",
      receipt: null,
    });
    // The next write was refused at its re-read before any attempt.
    const second = f.delivery.prepareAction(
      f.write(REVIEW),
      f.caller("handedBack"),
      false,
    );
    f.delivery.recordObservation(second.operationId, {
      state: "confirmed-failure",
      reason: "provider-project-field-changed",
      receipt: null,
    });
    f.delivery.recordObservation(first.operationId, {
      state: "confirmed-success",
      reason: null,
      receipt: { nodeId: "I_1" },
    });
    assert.equal(f.status.taskState(f.taskId).observedOptionNodeId, PROGRESS);
  } finally {
    f.db.close();
  }
});

test("the service uses an allow grant even when an approval grant for the option is listed first", () => {
  const f = setup();
  try {
    f.configureGrants([
      f.grant([TODO, PROGRESS, REVIEW, DONE], "approval"),
      f.grant([TODO, PROGRESS, REVIEW, DONE], "allow"),
    ]);
    f.save(mapping());
    assert.equal(
      f.delivery.prepareAction(
        f.write(PROGRESS),
        f.caller("turnStarted"),
        false,
      ).state,
      "prepared",
    );
  } finally {
    f.db.close();
  }
});

test("with an any rule that names the Status, an in-flight option must be one it names", () => {
  const f = setup();
  try {
    reconfigureReadiness(f, {
      mode: "any",
      conditions: [
        { kind: "label", operator: "has", name: "ready" },
        {
          kind: "project-field",
          projectNodeId: P,
          fieldNodeId: F,
          operator: "in",
          optionNodeIds: [TODO],
        },
      ],
    });
    assert.throws(
      () => f.save(mapping({ turnStarted: PROGRESS })),
      StatusMappingRefusal,
    );
    f.save(mapping({ turnStarted: TODO, handedBack: null }));
  } finally {
    f.db.close();
  }
});

test("the persisted shape and material hash of agent and operator records are unchanged", () => {
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
    const request = {
      operationId: randomUUID(),
      action: {
        kind: "issue.comment" as const,
        target: { repositoryId: "R_1", number: 1, nodeId: "I_1" },
        body: "Hello",
      },
    };
    const record = f.delivery.prepareAction(request, runtime, false);
    const stored = f.db
      .prepare("SELECT materialHash FROM delivery_actions WHERE operationId=?")
      .get(request.operationId) as { materialHash: string };
    // Parsing through the three-way caller union adds and drops nothing.
    assert.equal(
      stored.materialHash,
      materialDigest({ request, binding: runtime }),
    );
    assert.deepEqual(record.binding, runtime);
    assert.deepEqual(record.request, request);
  } finally {
    f.db.close();
  }
});
