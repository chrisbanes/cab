import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { CommandResultValidationError } from "../../src/core/command-results.js";
import {
  type DomainCommand,
  DomainCommands,
  DomainConflictError,
  DomainPolicyError,
  DomainStaleDispositionError,
  DomainStore,
} from "../../src/core/domain.js";
import { materialDigest } from "../../src/core/delivery.js";
import { Store } from "../../src/core/store.js";
import { ExecutionState } from "../../src/standalone/state.js";

const p = "10000000-0000-4000-8000-000000000001";
const q = "10000000-0000-4000-8000-000000000002";
const profile = "20000000-0000-4000-8000-000000000001";
const a = "30000000-0000-4000-8000-000000000001";
const b = "30000000-0000-4000-8000-000000000002";
const c = "30000000-0000-4000-8000-000000000003";
const assignment = "40000000-0000-4000-8000-000000000001";
const nested = "40000000-0000-4000-8000-000000000002";
const allocated = "40000000-0000-4000-8000-000000000003";
let serial = 0;
const key = () =>
  `50000000-0000-4000-8000-${String(++serial).padStart(12, "0")}`;

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "cab-domain-"));
  const filename = join(directory, "db.sqlite");
  let db = new DatabaseSync(filename);
  db.exec("PRAGMA foreign_keys = ON");
  new Store(db).ensureHost("test");
  let domain = new DomainStore(db);
  domain.migrate();
  return {
    get db() {
      return db;
    },
    get domain() {
      return domain;
    },
    reopen() {
      db.close();
      db = new DatabaseSync(filename);
      db.exec("PRAGMA foreign_keys = ON");
      new Store(db).ensureHost("test");
      domain = new DomainStore(db);
      domain.migrate();
    },
    close() {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

function assertStale(
  fn: () => unknown,
  message: RegExp,
  reason: "external-admission" | "stale",
  label = "stale disposition",
) {
  assert.throws(
    fn,
    (error) => {
      assert.ok(error instanceof DomainStaleDispositionError, label);
      assert.match(error.message, message, label);
      assert.equal(error.reason, reason, label);
      return true;
    },
    label,
  );
}

type WithoutKey<T> = T extends unknown ? Omit<T, "key"> : never;

function run(store: DomainStore, command: WithoutKey<DomainCommand>) {
  return store.execute({ ...command, key: key() } as DomainCommand);
}

test("nested assignments stay on the requester's task", () => {
  const f = fixture();
  try {
    run(f.domain, {
      type: "profile.create",
      actor: "operator",
      profileId: profile,
      name: "Lead",
      instructions: "Coordinate",
      capabilities: "assign",
    });
    run(f.domain, {
      type: "project.create",
      actor: "operator",
      projectId: p,
      name: "Project",
      leadProfileId: profile,
    });
    for (const taskId of [a, b])
      run(f.domain, {
        type: "task.create",
        actor: "operator",
        projectId: p,
        taskId,
        title: "Task",
        outcome: "Ship",
        ready: true,
      });
    run(f.domain, {
      type: "assignment.create",
      actor: "agent",
      projectId: p,
      taskId: a,
      assignmentId: assignment,
      profileId: profile,
      brief: "Own A",
      resultDestination: "lead:A",
      requesterAssignmentId: null,
    });
    const nestedCommand = {
      type: "assignment.create" as const,
      actor: "agent" as const,
      projectId: p,
      taskId: b,
      assignmentId: nested,
      profileId: profile,
      brief: "Delegate",
      resultDestination: "requester:A",
      requesterAssignmentId: assignment,
    };
    assert.throws(() => run(f.domain, nestedCommand), /Requester.*task/);
    assert.equal(f.domain.assignments(b).length, 0);
    const sameTask = run(f.domain, { ...nestedCommand, taskId: a }) as {
      taskId: string;
      requesterAssignmentId: string;
    };
    assert.equal(sameTask.taskId, a);
    assert.equal(sameTask.requesterAssignmentId, assignment);
    const explicit = run(f.domain, {
      ...nestedCommand,
      taskId: b,
      assignmentId: allocated,
      requesterAssignmentId: null,
    }) as { taskId: string };
    assert.equal(explicit.taskId, b);
  } finally {
    f.close();
  }
});

test("versioned commands retain revisions and replay matching stale retries", async () => {
  const f = fixture();
  try {
    run(f.domain, {
      type: "profile.create",
      actor: "operator",
      profileId: profile,
      name: "Builder",
      instructions: "original",
      capabilities: "code",
    });
    const project = run(f.domain, {
      type: "project.create",
      actor: "operator",
      projectId: p,
      name: "Alpha",
      leadProfileId: profile,
    }) as { paused: number; version: number };
    assert.equal(project.paused, 1);
    const task = run(f.domain, {
      type: "task.create",
      actor: "operator",
      projectId: p,
      taskId: a,
      title: "Task",
      outcome: "Ship",
      ready: false,
    }) as { ready: number };
    assert.equal(task.ready, 0);
    const command: DomainCommand = {
      type: "project.configure",
      key: key(),
      actor: "operator",
      projectId: p,
      expectedVersion: 1,
      instructions: "new",
    };
    const first = f.domain.execute(command);
    assert.equal(
      (first as { instructionsRevision: number }).instructionsRevision,
      2,
    );
    assert.deepEqual(f.domain.execute(command), first);
    assert.throws(
      () => f.domain.execute({ ...command, instructions: "changed" }),
      /different payload/,
    );
    assert.throws(
      () =>
        run(f.domain, {
          type: "project.configure",
          actor: "operator",
          projectId: p,
          expectedVersion: 1,
          instructions: "stale",
        }),
      /Version conflict/,
    );
    run(f.domain, {
      type: "profile.configure",
      actor: "operator",
      profileId: profile,
      expectedVersion: 1,
      instructions: "updated",
    });
    const created = run(f.domain, {
      type: "assignment.create",
      actor: "agent",
      projectId: p,
      taskId: a,
      assignmentId: assignment,
      profileId: profile,
      brief: "Work",
      resultDestination: "lead:task",
      requesterAssignmentId: null,
    }) as { profileRevision: number; instructionsRevision: number };
    assert.equal(created.profileRevision, 2);
    assert.equal(created.instructionsRevision, 2);
    run(f.domain, {
      type: "profile.configure",
      actor: "operator",
      profileId: profile,
      expectedVersion: 2,
      instructions: "third",
    });
    assert.equal(f.domain.assignment(assignment).profileRevision, 2);
    run(f.domain, {
      type: "assignment.apply",
      actor: "operator",
      projectId: p,
      assignmentId: assignment,
      expectedVersion: 1,
    });
    assert.equal(f.domain.assignment(assignment).profileRevision, 3);
    run(f.domain, {
      type: "profile.configure",
      actor: "operator",
      profileId: profile,
      expectedVersion: 3,
      revoked: true,
    });
    assert.equal(f.domain.instructionRevision(p, 1), "");
    assert.equal(f.domain.instructionRevision(p, 2), "new");
    assert.equal(f.domain.profileRevision(profile, 1).instructions, "original");
    assert.equal(f.domain.profileRevision(profile, 3).instructions, "third");
    assert.ok(
      f.domain
        .assignmentAdmission(assignment)
        .reasons.includes("profile-revoked"),
    );
    assert.throws(
      () =>
        run(f.domain, {
          type: "assignment.apply",
          actor: "operator",
          projectId: p,
          assignmentId: assignment,
          expectedVersion: 2,
        }),
      /revoked/,
    );
    assert.equal(f.domain.assignment(assignment).profileRevision, 3);
    f.reopen();
    assert.equal(f.domain.project(p).instructionsRevision, 2);
    assert.equal(f.domain.assignment(assignment).profileRevision, 3);
    assert.equal(
      f.domain.execute(command) &&
        (f.domain.execute(command) as { version: number }).version,
      2,
    );
  } finally {
    f.close();
  }
});

test("profile summary is optional, edited in place and added to older databases", () => {
  const f = fixture();
  try {
    f.db.exec("ALTER TABLE profiles DROP COLUMN summary");
    f.db
      .prepare(
        "INSERT INTO profiles (id, version, name, instructions, capabilities, revoked) VALUES (?, 1, 'Eli', 'fix', 'repairs', 0)",
      )
      .run(profile);
    f.reopen();
    assert.equal(f.domain.profile(profile).summary, "");
    run(f.domain, {
      type: "profile.configure",
      actor: "operator",
      profileId: profile,
      expectedVersion: 1,
      summary: " Repairs ",
    });
    assert.equal(f.domain.profiles()[0]?.summary, "Repairs");
    run(f.domain, {
      type: "profile.configure",
      actor: "operator",
      profileId: profile,
      expectedVersion: 2,
      instructions: "fix again",
    });
    assert.equal(f.domain.profile(profile).summary, "Repairs");
  } finally {
    f.close();
  }
});

test("profiles and revisions written before skill plugins enable none", () => {
  const f = fixture();
  try {
    run(f.domain, {
      type: "profile.create",
      actor: "operator",
      profileId: profile,
      name: "Old",
      instructions: "Build",
      capabilities: "code",
    });
    for (const table of ["profiles", "profile_revisions"])
      f.db.exec(`ALTER TABLE ${table} DROP COLUMN skills`);
    f.reopen();
    assert.deepEqual(f.domain.profileSkills(profile), { plugins: [] });
    assert.deepEqual(f.domain.profileSkills(profile, 1), { plugins: [] });
  } finally {
    f.close();
  }
});

test("legacy profile receipts replay unchanged after summary migration", () => {
  const f = fixture();
  try {
    const command = {
      type: "profile.create" as const,
      actor: "operator" as const,
      key: key(),
      profileId: profile,
      name: "Legacy profile",
      instructions: "Keep the returned shape",
      capabilities: "review",
    };
    const current = f.domain.execute(command);
    const expected = { ...current };
    delete expected.summary;
    const stored = f.db
      .prepare(
        "SELECT payloadHash, result FROM command_receipts WHERE scope = ? AND key = ?",
      )
      .get(`profile:${profile}`, command.key) as {
      payloadHash: string;
      result: string;
    };
    f.db
      .prepare(
        "UPDATE command_receipts SET result = ? WHERE scope = ? AND key = ?",
      )
      .run(JSON.stringify(expected), `profile:${profile}`, command.key);
    f.db.exec("ALTER TABLE profiles DROP COLUMN summary");

    f.reopen();
    assert.equal(f.domain.profile(profile).summary, "");
    assert.deepEqual(f.domain.execute(command), expected);
    assert.deepEqual(f.domain.recordedCommand(command), expected);
    assert.deepEqual(
      f.domain.recordedResult(
        `profile:${profile}`,
        command.key,
        "profile.create",
      ),
      { type: "profile.create", result: expected },
    );
    const reopenedReceipt = f.db
      .prepare(
        "SELECT payloadHash, result FROM command_receipts WHERE scope = ? AND key = ?",
      )
      .get(`profile:${profile}`, command.key) as typeof stored;
    assert.equal(reopenedReceipt.payloadHash, stored.payloadHash);
    assert.equal(reopenedReceipt.result, JSON.stringify(expected));

    f.db
      .prepare(
        "UPDATE command_receipts SET result = ? WHERE scope = ? AND key = ?",
      )
      .run(
        JSON.stringify({ ...expected, summary: 1 }),
        `profile:${profile}`,
        command.key,
      );
    assert.throws(
      () =>
        f.domain.recordedResult(
          `profile:${profile}`,
          command.key,
          "profile.create",
        ),
      CommandResultValidationError,
    );
    assert.throws(
      () => f.domain.execute({ ...command, name: "Different payload" }),
      DomainConflictError,
    );
  } finally {
    f.close();
  }
});

test("legacy assignment receipts replay without migrated recipient fields", () => {
  const f = fixture();
  try {
    run(f.domain, {
      type: "profile.create",
      actor: "operator",
      profileId: profile,
      name: "Lead",
      instructions: "Coordinate",
      capabilities: "assign",
    });
    run(f.domain, {
      type: "project.create",
      actor: "operator",
      projectId: p,
      name: "Project",
      leadProfileId: profile,
    });
    run(f.domain, {
      type: "task.create",
      actor: "operator",
      projectId: p,
      taskId: a,
      title: "Task",
      outcome: "Ship",
      ready: true,
    });
    const create = {
      type: "assignment.create" as const,
      actor: "agent" as const,
      key: key(),
      projectId: p,
      taskId: a,
      assignmentId: assignment,
      profileId: profile,
      brief: "Coordinate the task",
      resultDestination: "lead",
      requesterAssignmentId: null,
    };
    const currentCreated = f.domain.execute(create);
    const expectedCreated = { ...currentCreated };
    delete expectedCreated.resultRecipientAssignmentId;
    delete expectedCreated.resultRecipientDisposition;
    const apply = {
      type: "assignment.apply" as const,
      actor: "operator" as const,
      key: key(),
      projectId: p,
      assignmentId: assignment,
      expectedVersion: 1,
    };
    const currentApplied = f.domain.execute(apply);
    const expectedApplied = { ...currentApplied };
    delete expectedApplied.resultRecipientAssignmentId;
    delete expectedApplied.resultRecipientDisposition;

    const stored = f.db
      .prepare(
        "SELECT payloadHash, result FROM command_receipts WHERE scope = ? AND key = ?",
      )
      .get(p, create.key) as { payloadHash: string; result: string };
    f.db
      .prepare(
        "UPDATE command_receipts SET result = ? WHERE scope = ? AND key = ?",
      )
      .run(JSON.stringify(expectedCreated), p, create.key);
    f.db
      .prepare(
        "UPDATE command_receipts SET result = ? WHERE scope = ? AND key = ?",
      )
      .run(JSON.stringify(expectedApplied), p, apply.key);
    f.db.exec(
      "ALTER TABLE domain_assignments DROP COLUMN resultRecipientDisposition; " +
        "ALTER TABLE domain_assignments DROP COLUMN resultRecipientAssignmentId;",
    );

    f.reopen();
    assert.equal(
      f.domain.assignment(assignment).resultRecipientDisposition,
      "unresolved",
    );
    assert.deepEqual(f.domain.execute(create), expectedCreated);
    assert.deepEqual(
      f.domain.recordedResult(p, create.key, "assignment.create"),
      { type: "assignment.create", result: expectedCreated },
    );
    assert.deepEqual(f.domain.execute(apply), expectedApplied);
    assert.deepEqual(
      f.domain.recordedResult(p, apply.key, "assignment.apply"),
      { type: "assignment.apply", result: expectedApplied },
    );
    const reopenedReceipt = f.db
      .prepare(
        "SELECT payloadHash, result FROM command_receipts WHERE scope = ? AND key = ?",
      )
      .get(p, create.key) as typeof stored;
    assert.equal(reopenedReceipt.payloadHash, stored.payloadHash);
    assert.equal(reopenedReceipt.result, JSON.stringify(expectedCreated));

    f.db
      .prepare(
        "UPDATE command_receipts SET result = ? WHERE scope = ? AND key = ?",
      )
      .run(
        JSON.stringify({
          ...expectedApplied,
          resultRecipientDisposition: "unknown",
        }),
        p,
        apply.key,
      );
    assert.throws(
      () => f.domain.recordedResult(p, apply.key, "assignment.apply"),
      CommandResultValidationError,
    );
    assert.throws(
      () => f.domain.execute({ ...apply, expectedVersion: 2 }),
      DomainConflictError,
    );
  } finally {
    f.close();
  }
});

test("fresh profile and assignment results require current migrated fields before receipt", () => {
  const f = fixture();
  try {
    run(f.domain, {
      type: "profile.create",
      actor: "operator",
      profileId: profile,
      name: "Lead",
      instructions: "Coordinate",
      capabilities: "assign",
    });
    const originalProfile = f.domain.profile.bind(f.domain);
    Object.defineProperty(f.domain, "profile", {
      value: (profileId: string) => {
        const { summary: _summary, ...legacy } = originalProfile(profileId);
        return legacy;
      },
      configurable: true,
    });
    const profileConfigure = {
      type: "profile.configure" as const,
      actor: "operator" as const,
      key: key(),
      profileId: profile,
      expectedVersion: 1,
      summary: "Fresh summary",
      instructions: "Must roll back",
    };
    assert.throws(
      () => f.domain.execute(profileConfigure),
      CommandResultValidationError,
    );
    assert.equal(
      f.db.prepare("SELECT version FROM profiles WHERE id = ?").get(profile)
        ?.version,
      1,
    );
    assert.equal(
      f.domain.recordedResult(`profile:${profile}`, profileConfigure.key),
      undefined,
    );
    Object.defineProperty(f.domain, "profile", {
      value: originalProfile,
      configurable: true,
    });

    run(f.domain, {
      type: "project.create",
      actor: "operator",
      projectId: p,
      name: "Project",
      leadProfileId: profile,
    });
    run(f.domain, {
      type: "task.create",
      actor: "operator",
      projectId: p,
      taskId: a,
      title: "Task",
      outcome: "Ship",
      ready: true,
    });
    run(f.domain, {
      type: "assignment.create",
      actor: "agent",
      projectId: p,
      taskId: a,
      assignmentId: assignment,
      profileId: profile,
      brief: "Coordinate",
      resultDestination: "lead",
      requesterAssignmentId: null,
    });
    const originalAssignment = f.domain.assignment.bind(f.domain);
    Object.defineProperty(f.domain, "assignment", {
      value: (assignmentId: string) => {
        const {
          resultRecipientAssignmentId: _recipient,
          resultRecipientDisposition: _disposition,
          ...legacy
        } = originalAssignment(assignmentId);
        return legacy;
      },
      configurable: true,
    });
    const assignmentApply = {
      type: "assignment.apply" as const,
      actor: "operator" as const,
      key: key(),
      projectId: p,
      assignmentId: assignment,
      expectedVersion: 1,
    };
    assert.throws(
      () => f.domain.execute(assignmentApply),
      CommandResultValidationError,
    );
    assert.equal(
      f.db
        .prepare("SELECT version FROM domain_assignments WHERE id = ?")
        .get(assignment)?.version,
      1,
    );
    assert.equal(f.domain.recordedResult(p, assignmentApply.key), undefined);
  } finally {
    f.close();
  }
});

test("in-flight command duplicates share one promise", async () => {
  const f = fixture();
  try {
    const commands = new DomainCommands(f.domain);
    const command: DomainCommand = {
      type: "project.create",
      key: key(),
      actor: "operator",
      projectId: p,
      name: "Alpha",
      leadProfileId: null,
    };
    const one = commands.execute(command);
    const two = commands.execute(command);
    assert.equal(one, two);
    await assert.rejects(
      commands.execute({ ...command, name: "Other" }),
      /different payload/,
    );
    assert.deepEqual(await one, await two);
  } finally {
    f.close();
  }
});

test("invalid fresh results roll back the domain mutation and receipt", () => {
  const f = fixture();
  try {
    f.domain.execute({
      type: "project.create",
      actor: "operator",
      key: key(),
      projectId: p,
      name: "Alpha",
      leadProfileId: null,
    });
    f.domain.execute({
      type: "task.create",
      actor: "operator",
      key: key(),
      projectId: p,
      taskId: a,
      title: "Task",
      outcome: "Before",
    });
    const originalTask = f.domain.task.bind(f.domain);
    f.domain.task = (taskId) => ({ ...originalTask(taskId), id: "invalid" });
    const command = {
      type: "task.configure" as const,
      actor: "operator" as const,
      key: key(),
      projectId: p,
      taskId: a,
      expectedVersion: 1,
      outcome: "After",
    };

    assert.throws(
      () => f.domain.execute(command),
      CommandResultValidationError,
    );
    f.domain.task = originalTask;
    assert.equal(f.domain.task(a).outcome, "Before");
    assert.equal(f.domain.task(a).version, 1);
    assert.equal(f.domain.recordedResult(p, command.key), undefined);
  } finally {
    f.close();
  }
});

test("corrupt stored results fail replay validation without reapplying", () => {
  const f = fixture();
  try {
    const command = {
      type: "project.create" as const,
      actor: "operator" as const,
      key: key(),
      projectId: p,
      name: "Alpha",
      leadProfileId: null,
    };
    const original = f.domain.execute(command);
    f.db
      .prepare(
        "UPDATE command_receipts SET result = ? WHERE scope = ? AND key = ?",
      )
      .run("{", p, command.key);
    assert.throws(
      () => f.domain.execute(command),
      CommandResultValidationError,
    );
    assert.equal(f.domain.project(p).version, 1);
    assert.throws(
      () => f.domain.recordedResult(p, command.key, "project.create"),
      CommandResultValidationError,
    );
    f.db
      .prepare(
        "UPDATE command_receipts SET result = ? WHERE scope = ? AND key = ?",
      )
      .run("{}", p, command.key);
    assert.throws(
      () => f.domain.execute(command),
      CommandResultValidationError,
    );
    assert.deepEqual(original, {
      id: p,
      name: "Alpha",
      version: 1,
      paused: 1,
      leadProfileId: null,
      instructionsRevision: 1,
      instructions: "",
    });
  } finally {
    f.close();
  }
});

test("routing settings, provenance and destinations persist without credential values in views", () => {
  const f = fixture();
  try {
    run(f.domain, {
      type: "profile.create",
      actor: "operator",
      profileId: profile,
      name: "Builder",
      instructions: "Do work",
      capabilities: "code",
    });
    run(f.domain, {
      type: "project.create",
      actor: "operator",
      projectId: p,
      name: "Alpha",
      leadProfileId: profile,
    });
    run(f.domain, {
      type: "task.create",
      actor: "operator",
      projectId: p,
      taskId: a,
      title: "Task",
      outcome: "Ship",
      ready: true,
    });
    assert.equal(f.domain.routing(p).enabled, 0);
    const routing = run(f.domain, {
      type: "routing.configure",
      actor: "operator",
      projectId: p,
      expectedVersion: 1,
      enabled: true,
      guidance: "Best fit",
      credentialRef: "env:TYPESAFE_KEY",
      candidateProfileIds: [profile],
    });
    assert.equal(
      (routing as { credentialAvailable: number }).credentialAvailable,
      1,
    );
    assert.doesNotMatch(JSON.stringify(routing), /TYPESAFE_KEY/);
    run(f.domain, {
      type: "project.configure",
      actor: "operator",
      projectId: p,
      expectedVersion: 1,
      paused: false,
    });
    assert.throws(
      () =>
        run(f.domain, {
          type: "routing.configure",
          actor: "operator",
          projectId: p,
          expectedVersion: 2,
          enabled: true,
          guidance: "Bad",
          credentialRef: "sk-secret",
          candidateProfileIds: [profile],
        }),
      /invalid_string|regex/i,
    );
    const input = {
      id: key(),
      projectId: p,
      taskId: a,
      taskVersion: 1,
      assignmentId: null,
      candidateRevisions: { [profile]: 1 },
      guidanceRevision: 2,
      model: "deterministic",
      question: "Who fits?",
      judgment: "Builder",
      disposition: "lead-fallback",
      resultDestination: "lead:task",
    };
    const operation = f.domain.recordRouting(input);
    assert.equal(operation.resultDestination, "lead:task");
    assert.deepEqual(f.domain.recordRouting(input), operation);
    assert.throws(
      () => f.domain.recordRouting({ ...input, disposition: "assigned" }),
      /conflict/,
    );
    assert.throws(
      () => f.domain.recordRouting({ ...input, id: key() }),
      /conflict/,
    );
    f.reopen();
    assert.equal(f.domain.routing(p).enabled, 1);
    assert.equal(
      f.domain.routingOperation(String(operation.id)).disposition,
      "lead-fallback",
    );
  } finally {
    f.close();
  }
});

test("routing assignment and operation commit together after revision and admission checks", () => {
  const f = fixture();
  try {
    run(f.domain, {
      type: "profile.create",
      actor: "operator",
      profileId: profile,
      name: "Builder",
      instructions: "Code",
      capabilities: "code",
    });
    run(f.domain, {
      type: "project.create",
      actor: "operator",
      projectId: p,
      name: "Alpha",
      leadProfileId: profile,
    });
    run(f.domain, {
      type: "task.create",
      actor: "operator",
      projectId: p,
      taskId: a,
      title: "Task",
      outcome: "Ship",
      ready: true,
    });
    run(f.domain, {
      type: "routing.configure",
      actor: "operator",
      projectId: p,
      expectedVersion: 1,
      enabled: true,
      guidance: "Fit",
      credentialRef: "env:TYPESAFE_KEY",
      candidateProfileIds: [profile],
    });
    const input = {
      id: key(),
      projectId: p,
      taskId: a,
      taskVersion: 1,
      assignmentId: assignment,
      candidateRevisions: { [profile]: 1 },
      guidanceRevision: 2,
      model: "deterministic",
      question: "Choose",
      judgment: "Builder",
      disposition: "assigned",
      resultDestination: "lead:task",
      assignment: {
        profileId: profile,
        brief: "Ship",
        requesterAssignmentId: null,
      },
    };
    assertStale(() => f.domain.recordRouting(input), /held/, "stale");
    assert.throws(() => f.domain.assignment(assignment), /Unknown/);
    run(f.domain, {
      type: "project.configure",
      actor: "operator",
      projectId: p,
      expectedVersion: 1,
      paused: false,
    });
    const operation = f.domain.recordRouting(input);
    assert.equal(operation.assignmentId, assignment);
    assert.equal(
      f.domain.assignment(assignment).resultDestination,
      "lead:task",
    );
    assert.deepEqual(f.domain.recordRouting(input), operation);
    f.reopen();
    assert.equal(f.domain.routingOperation(input.id).assignmentId, assignment);
  } finally {
    f.close();
  }
});

test("routing checks a committed standalone hold before writing any disposition", () => {
  const f = fixture();
  try {
    run(f.domain, {
      type: "profile.create",
      actor: "operator",
      profileId: profile,
      name: "Builder",
      instructions: "Code",
      capabilities: "code",
    });
    run(f.domain, {
      type: "project.create",
      actor: "operator",
      projectId: p,
      name: "Alpha",
      leadProfileId: profile,
    });
    run(f.domain, {
      type: "project.configure",
      actor: "operator",
      projectId: p,
      expectedVersion: 1,
      paused: false,
    });
    run(f.domain, {
      type: "task.create",
      actor: "operator",
      projectId: p,
      taskId: a,
      title: "Task",
      outcome: "Ship",
      ready: true,
    });
    run(f.domain, {
      type: "routing.configure",
      actor: "operator",
      projectId: p,
      expectedVersion: 1,
      enabled: true,
      guidance: "Fit",
      credentialRef: "env:TYPESAFE_KEY",
      candidateProfileIds: [profile],
    });
    const state = new ExecutionState(f.db);
    state.stopTask(a);
    const input = {
      id: key(),
      projectId: p,
      taskId: a,
      taskVersion: 1,
      assignmentId: key(),
      candidateRevisions: { [profile]: 1 },
      guidanceRevision: 2,
      model: "jev-1.13.0",
      question: "Choose",
      judgment: "Builder",
      disposition: "assigned",
      resultDestination: "lead:task",
      assignment: {
        profileId: profile,
        brief: "Ship",
        requesterAssignmentId: null,
      },
    };

    assertStale(
      () => f.domain.recordRouting(input, () => !state.taskHold(a)),
      /external admission/i,
      "external-admission",
    );
    assert.deepEqual(f.domain.routingOperations(a), []);
    assert.throws(() => f.domain.assignment(input.assignmentId), /Unknown/);
  } finally {
    f.close();
  }
});

test("delayed fallback cannot become actionable after routing or admission changes", () => {
  for (const change of [
    "task",
    "opt-out",
    "pause",
    "guidance",
    "candidates",
    "blocker",
    "profile",
  ] as const) {
    const f = fixture();
    try {
      run(f.domain, {
        type: "profile.create",
        actor: "operator",
        profileId: profile,
        name: "Lead",
        instructions: "Own",
        capabilities: "coordinate",
      });
      run(f.domain, {
        type: "project.create",
        actor: "operator",
        projectId: p,
        name: "Alpha",
        leadProfileId: profile,
      });
      run(f.domain, {
        type: "task.create",
        actor: "operator",
        projectId: p,
        taskId: a,
        title: "Task",
        outcome: "Ship",
        ready: true,
      });
      run(f.domain, {
        type: "project.configure",
        actor: "operator",
        projectId: p,
        expectedVersion: 1,
        paused: false,
      });
      run(f.domain, {
        type: "routing.configure",
        actor: "operator",
        projectId: p,
        expectedVersion: 1,
        enabled: true,
        guidance: "Fit",
        credentialRef: null,
        candidateProfileIds: [profile],
      });
      const input = {
        id: key(),
        projectId: p,
        taskId: a,
        taskVersion: 1,
        assignmentId: null,
        candidateRevisions: { [profile]: 1 },
        guidanceRevision: 2,
        model: "deterministic",
        question: "Who fits?",
        judgment: null,
        disposition: "lead-fallback",
        resultDestination: "lead:task",
      };
      switch (change) {
        case "task":
          run(f.domain, {
            type: "task.configure",
            actor: "operator",
            projectId: p,
            taskId: a,
            expectedVersion: 1,
            outcome: "Changed",
          });
          break;
        case "opt-out":
          run(f.domain, {
            type: "routing.configure",
            actor: "operator",
            projectId: p,
            expectedVersion: 2,
            enabled: false,
            guidance: "Fit",
            credentialRef: null,
            candidateProfileIds: [profile],
          });
          break;
        case "pause":
          run(f.domain, {
            type: "project.configure",
            actor: "operator",
            projectId: p,
            expectedVersion: 2,
            paused: true,
          });
          break;
        case "guidance":
          run(f.domain, {
            type: "routing.configure",
            actor: "operator",
            projectId: p,
            expectedVersion: 2,
            enabled: true,
            guidance: "New fit",
            credentialRef: null,
            candidateProfileIds: [profile],
          });
          break;
        case "candidates":
          run(f.domain, {
            type: "routing.configure",
            actor: "operator",
            projectId: p,
            expectedVersion: 2,
            enabled: true,
            guidance: "Fit",
            credentialRef: null,
            candidateProfileIds: [],
          });
          break;
        case "blocker":
          run(f.domain, {
            type: "imported-blockers.set",
            actor: "operator",
            projectId: p,
            taskId: a,
            expectedVersion: 1,
            state: "unknown",
          });
          break;
        case "profile":
          run(f.domain, {
            type: "profile.configure",
            actor: "operator",
            profileId: profile,
            expectedVersion: 1,
            capabilities: "new",
          });
          break;
      }
      assertStale(
        () => f.domain.recordRouting(input),
        /stale|changed|revision/,
        "stale",
        change,
      );
      assert.throws(() => f.domain.routingOperation(input.id), /Unknown/);
      if (change === "opt-out") {
        const explicit = run(f.domain, {
          type: "assignment.create",
          actor: "agent",
          projectId: p,
          taskId: a,
          assignmentId: assignment,
          profileId: profile,
          brief: "Lead allocates",
          resultDestination: "lead:task",
          requesterAssignmentId: null,
        }) as { state: string };
        assert.equal(explicit.state, "pending");
      }
    } finally {
      f.close();
    }
  }
});

function routedSetup(f: ReturnType<typeof fixture>) {
  run(f.domain, {
    type: "profile.create",
    actor: "operator",
    profileId: profile,
    name: "Builder",
    instructions: "Code",
    capabilities: "code",
  });
  run(f.domain, {
    type: "project.create",
    actor: "operator",
    projectId: p,
    name: "Alpha",
    leadProfileId: profile,
  });
  run(f.domain, {
    type: "project.configure",
    actor: "operator",
    projectId: p,
    expectedVersion: 1,
    paused: false,
  });
  run(f.domain, {
    type: "task.create",
    actor: "operator",
    projectId: p,
    taskId: a,
    title: "Task",
    outcome: "Ship",
    ready: true,
  });
  run(f.domain, {
    type: "routing.configure",
    actor: "operator",
    projectId: p,
    expectedVersion: 1,
    enabled: true,
    guidance: "Fit",
    credentialRef: "env:TYPESAFE_KEY",
    candidateProfileIds: [profile],
  });
  return {
    id: key(),
    projectId: p,
    taskId: a,
    taskVersion: 1,
    assignmentId: assignment,
    candidateRevisions: { [profile]: 1 },
    guidanceRevision: 2,
    model: "deterministic",
    question: "Choose",
    judgment: "Builder",
    disposition: "assigned",
    resultDestination: "lead:task",
    assignment: {
      profileId: profile,
      brief: "Ship",
      requesterAssignmentId: null,
    },
  };
}

test("routing rejects an already-assigned task with the typed stale error", () => {
  const f = fixture();
  try {
    const input = routedSetup(f);
    run(f.domain, {
      type: "assignment.create",
      actor: "agent",
      projectId: p,
      taskId: a,
      assignmentId: nested,
      profileId: profile,
      brief: "Explicit",
      resultDestination: "lead:task",
      requesterAssignmentId: null,
    });
    assertStale(
      () => f.domain.recordRouting(input),
      /task already assigned/,
      "stale",
    );
    assert.deepEqual(f.domain.routingOperations(a), []);
  } finally {
    f.close();
  }
});

test("routing failures other than stale dispositions are not typed stale", () => {
  const f = fixture();
  try {
    const input = routedSetup(f);
    run(f.domain, {
      type: "profile.create",
      actor: "operator",
      profileId: q,
      name: "Outsider",
      instructions: "Code",
      capabilities: "code",
    });
    const notStale = (error: unknown, message: RegExp) => {
      assert.ok(!(error instanceof DomainStaleDispositionError));
      assert.match((error as Error).message, message);
      return true;
    };
    assert.throws(
      () =>
        f.domain.recordRouting({
          ...input,
          assignment: { ...input.assignment, profileId: q },
        }),
      (error) => notStale(error, /not a candidate/),
    );
    assert.deepEqual(f.domain.routingOperations(a), []);
    assert.throws(() => f.domain.assignment(assignment), /Unknown/);

    const { assignment: _assignment, ...fallback } = input;
    const first = f.domain.recordRouting({
      ...fallback,
      id: key(),
      assignmentId: null,
      disposition: "lead-fallback",
    });
    assert.throws(
      () => f.domain.recordRouting({ ...input, id: String(first.id) }),
      (error) => notStale(error, /Routing operation conflict/),
    );
  } finally {
    f.close();
  }
});

test("routing without credentials fails without the typed stale error", () => {
  const f = fixture();
  try {
    const input = routedSetup(f);
    run(f.domain, {
      type: "routing.configure",
      actor: "operator",
      projectId: p,
      expectedVersion: 2,
      enabled: true,
      guidance: "No credentials",
      credentialRef: null,
      candidateProfileIds: [profile],
    });
    assert.throws(
      () => f.domain.recordRouting({ ...input, guidanceRevision: 3 }),
      (error) => {
        assert.ok(!(error instanceof DomainStaleDispositionError));
        assert.match((error as Error).message, /credentials unavailable/);
        return true;
      },
    );
  } finally {
    f.close();
  }
});

test("matching fallback retry replays after later state changes", () => {
  const f = fixture();
  try {
    run(f.domain, {
      type: "profile.create",
      actor: "operator",
      profileId: profile,
      name: "Lead",
      instructions: "Own",
      capabilities: "coordinate",
    });
    run(f.domain, {
      type: "project.create",
      actor: "operator",
      projectId: p,
      name: "Alpha",
      leadProfileId: profile,
    });
    run(f.domain, {
      type: "task.create",
      actor: "operator",
      projectId: p,
      taskId: a,
      title: "Task",
      outcome: "Ship",
      ready: true,
    });
    run(f.domain, {
      type: "project.configure",
      actor: "operator",
      projectId: p,
      expectedVersion: 1,
      paused: false,
    });
    run(f.domain, {
      type: "routing.configure",
      actor: "operator",
      projectId: p,
      expectedVersion: 1,
      enabled: true,
      guidance: "Fit",
      credentialRef: null,
      candidateProfileIds: [profile],
    });
    const input = {
      id: key(),
      projectId: p,
      taskId: a,
      taskVersion: 1,
      assignmentId: null,
      candidateRevisions: { [profile]: 1 },
      guidanceRevision: 2,
      model: "deterministic",
      question: "Who fits?",
      judgment: null,
      disposition: "lead-fallback",
      resultDestination: "lead:task",
    };
    const first = f.domain.recordRouting(input);
    run(f.domain, {
      type: "task.configure",
      actor: "operator",
      projectId: p,
      taskId: a,
      expectedVersion: 1,
      outcome: "Changed",
    });
    f.reopen();
    assert.deepEqual(f.domain.recordRouting(input), first);
  } finally {
    f.close();
  }
});

test("dependency authority, cycle and unknown imported-blocker holds survive restart", () => {
  const f = fixture();
  try {
    run(f.domain, {
      type: "project.create",
      actor: "operator",
      projectId: p,
      name: "Alpha",
      leadProfileId: null,
    });
    run(f.domain, {
      type: "project.create",
      actor: "operator",
      projectId: q,
      name: "Beta",
      leadProfileId: null,
    });
    for (const [projectId, taskId] of [
      [p, a],
      [p, b],
      [q, c],
    ] as const)
      run(f.domain, {
        type: "task.create",
        actor: "operator",
        projectId,
        taskId,
        title: taskId,
        outcome: "Work",
        ready: true,
      });
    assert.throws(
      () =>
        run(f.domain, {
          type: "dependency.add",
          actor: "agent",
          projectId: p,
          taskId: a,
          blockerTaskId: b,
          expectedVersion: 1,
        }),
      /Operator/,
    );
    assert.throws(
      () =>
        run(f.domain, {
          type: "dependency.add",
          actor: "operator",
          projectId: p,
          taskId: a,
          blockerTaskId: a,
          expectedVersion: 1,
        }),
      /itself/,
    );
    assert.throws(
      () =>
        run(f.domain, {
          type: "dependency.add",
          actor: "operator",
          projectId: p,
          taskId: a,
          blockerTaskId: c,
          expectedVersion: 1,
        }),
      /another project/,
    );
    run(f.domain, {
      type: "dependency.add",
      actor: "operator",
      projectId: p,
      taskId: a,
      blockerTaskId: b,
      expectedVersion: 1,
    });
    assert.throws(
      () =>
        run(f.domain, {
          type: "dependency.add",
          actor: "operator",
          projectId: p,
          taskId: b,
          blockerTaskId: a,
          expectedVersion: 1,
        }),
      /cycle/,
    );
    run(f.domain, {
      type: "imported-blockers.set",
      actor: "operator",
      projectId: p,
      taskId: a,
      expectedVersion: 2,
      state: "unknown",
    });
    f.reopen();
    assert.deepEqual(f.domain.dependencies(a), [b]);
    assert.deepEqual(f.domain.admission(a).reasons, [
      "project-paused",
      "project-lead-unconfigured",
      "imported-blockers-unknown",
      "local-dependency",
    ]);
  } finally {
    f.close();
  }
});

test("capacity limits default, configure sparsely, replay and persist", () => {
  const f = fixture();
  const otherProject = "10000000-0000-4000-8000-000000000003";
  const limits = (projectIds: string[] = []) =>
    (
      f.domain as unknown as {
        capacityLimits(ids: string[]): {
          globalLimit: number;
          defaultProjectLimit: number;
          projectOverrides: Record<string, number>;
          currentUsage: { global: number; projects: Record<string, number> };
          effectiveProjectLimits: Record<string, number>;
        };
      }
    ).capacityLimits(projectIds);
  try {
    run(f.domain, {
      type: "project.create",
      actor: "operator",
      projectId: p,
      name: "Project",
      leadProfileId: null,
    });
    run(f.domain, {
      type: "project.create",
      actor: "operator",
      projectId: q,
      name: "Other project",
      leadProfileId: null,
    });
    assert.equal(limits([p, q]).globalLimit, 4);
    assert.equal(limits([p, q]).defaultProjectLimit, 2);
    assert.deepEqual(limits([p, q]).effectiveProjectLimits, { [p]: 2, [q]: 2 });

    const initial = {
      type: "capacity.configure" as const,
      actor: "operator" as const,
      globalLimit: 6,
      projectOverrides: { [p]: 3, [q]: 1 },
      key: key(),
    };
    const first = f.domain.execute(initial as never);
    assert.deepEqual(f.domain.execute(initial as never), first);
    const configured = limits([p, q]);
    assert.equal(configured.globalLimit, 6);
    assert.deepEqual(configured.projectOverrides, { [p]: 3, [q]: 1 });
    assert.deepEqual(configured.effectiveProjectLimits, { [p]: 3, [q]: 1 });
    assert.deepEqual(configured.currentUsage, { global: 0, projects: {} });

    assert.throws(
      () =>
        f.domain.execute({
          ...initial,
          globalLimit: 5,
        } as never),
      /Command key already used with different payload/,
    );
    assert.throws(
      () =>
        run(f.domain, {
          type: "capacity.configure",
          actor: "agent",
          globalLimit: 5,
          projectOverrides: {},
        } as never),
      /Operator authority required/,
    );
    assert.throws(
      () =>
        run(f.domain, {
          type: "capacity.configure",
          actor: "operator",
          globalLimit: 0,
          projectOverrides: {},
        } as never),
      /expected number to be >0/,
    );
    assert.throws(
      () =>
        run(f.domain, {
          type: "capacity.configure",
          actor: "operator",
          globalLimit: 5,
          projectOverrides: { [otherProject]: 1 },
        } as never),
      /Unknown domain record/,
    );
    assert.equal(limits([p, q]).globalLimit, 6, "invalid changes roll back");

    run(f.domain, {
      type: "capacity.configure",
      actor: "operator",
      globalLimit: 5,
      projectOverrides: { [p]: null },
    } as never);
    assert.deepEqual(limits([p, q]).projectOverrides, { [q]: 1 });
    assert.deepEqual(limits([p, q]).effectiveProjectLimits, { [p]: 2, [q]: 1 });
    f.reopen();
    assert.equal(limits([p, q]).globalLimit, 5);
    assert.deepEqual(limits([p, q]).projectOverrides, { [q]: 1 });
    assert.deepEqual(limits([p, q]).effectiveProjectLimits, { [p]: 2, [q]: 1 });
  } finally {
    f.close();
  }
});

test("task.create atomically records dependencies and explicit assignment before readiness wakeup", () => {
  const f = fixture();
  try {
    run(f.domain, {
      type: "profile.create",
      actor: "operator",
      profileId: profile,
      name: "Lead",
      instructions: "Coordinate",
      capabilities: "assign",
    });
    run(f.domain, {
      type: "project.create",
      actor: "operator",
      projectId: p,
      name: "Project",
      leadProfileId: profile,
    });
    run(f.domain, {
      type: "task.create",
      actor: "operator",
      projectId: p,
      taskId: b,
      title: "Blocker",
      outcome: "Finish first",
      ready: false,
    });
    let observed = false;
    const d = new DomainStore(f.db, () => {
      observed = true;
      assert.equal(d.dependencies(a).length, 1);
      assert.equal(d.assignments(a).length, 1);
      assert.equal(d.task(a).version, 2);
      assert.equal(d.admission(a).eligible, false);
    });
    const command = {
      type: "task.create",
      key: key(),
      actor: "operator",
      projectId: p,
      taskId: a,
      title: "Rich task",
      outcome: "Ship",
      ready: true,
      blockerTaskIds: [b],
      initialAssignment: { assignmentId: assignment, profileId: profile },
    } as unknown as DomainCommand;
    const receipt = d.execute(command);
    assert.ok(observed);
    assert.equal(d.assignments(a)[0]?.brief, "Task: Rich task\nOutcome: Ship");
    assert.equal(d.assignments(a)[0]?.profileRevision, 1);
    assert.equal(
      d.leadBindings().find((x) => x.taskId === a)?.profileId,
      profile,
    );
    assert.deepEqual(d.execute(command), receipt);
    f.reopen();
    assert.deepEqual(f.domain.execute(command), receipt);
    assert.equal(f.domain.assignments(a).length, 1);
  } finally {
    f.close();
  }
});

test("rich task creation rolls back invalid setup and preserves legacy omitted-field receipts", () => {
  const f = fixture();
  try {
    run(f.domain, {
      type: "profile.create",
      actor: "operator",
      profileId: profile,
      name: "Lead",
      instructions: "private",
      capabilities: "assign",
    });
    for (const projectId of [p, q])
      run(f.domain, {
        type: "project.create",
        actor: "operator",
        projectId,
        name: projectId === p ? "Project" : "Other project",
        leadProfileId: profile,
      });
    run(f.domain, {
      type: "task.create",
      actor: "operator",
      projectId: q,
      taskId: b,
      title: "Foreign",
      outcome: "Work",
      ready: false,
    });
    const base = {
      type: "task.create" as const,
      actor: "operator" as const,
      projectId: p,
      taskId: a,
      title: "Task",
      outcome: "Ship",
      ready: true,
    };
    for (const invalid of [
      { blockerTaskIds: [b] },
      { blockerTaskIds: [a] },
      { blockerTaskIds: [b, b] },
      { blockerTaskIds: Array(129).fill(b) },
      {
        initialAssignment: {
          assignmentId: assignment,
          profileId: randomProfile,
        },
      },
      { actor: "agent" },
    ]) {
      assert.throws(() =>
        f.domain.execute({ ...base, ...invalid, key: key() } as DomainCommand),
      );
      assert.equal(f.domain.tasks(p).length, 0);
      assert.equal(f.domain.assignments(a).length, 0);
      assert.equal(f.domain.leadBindings().length, 0);
    }
    const legacy = { ...base, key: key() };
    const receipt = f.domain.execute(legacy);
    f.reopen();
    assert.deepEqual(f.domain.execute(legacy), receipt);
    assert.throws(
      () => f.domain.execute({ ...legacy, blockerTaskIds: [] }),
      /different payload/,
    );
  } finally {
    f.close();
  }
});
const randomProfile = "20000000-0000-4000-8000-000000000099";

test("committed rich creation replays its original receipt after wakeup failure and policy revocation", () => {
  const f = fixture();
  try {
    run(f.domain, {
      type: "profile.create",
      actor: "operator",
      profileId: profile,
      name: "Lead",
      instructions: "private",
      capabilities: "assign",
    });
    run(f.domain, {
      type: "project.create",
      actor: "operator",
      projectId: p,
      name: "Project",
      leadProfileId: profile,
    });
    const command = {
      type: "task.create" as const,
      actor: "operator" as const,
      key: key(),
      projectId: p,
      taskId: a,
      title: "Task",
      outcome: "Ship",
      ready: false,
      initialAssignment: { assignmentId: assignment, profileId: profile },
    };
    const d = new DomainStore(f.db, () => {
      throw new DomainPolicyError("forbidden", "Wakeup unavailable");
    });
    assert.throws(
      () => d.execute(command),
      (error) =>
        error instanceof Error && !(error instanceof DomainPolicyError),
      "committed callback policy class is not a definite precommit rejection",
    );
    assert.equal(f.domain.tasks(p).length, 1);
    run(f.domain, {
      type: "profile.configure",
      actor: "operator",
      profileId: profile,
      expectedVersion: 1,
      revoked: true,
    });
    run(f.domain, {
      type: "task.configure",
      actor: "operator",
      projectId: p,
      taskId: a,
      expectedVersion: 1,
      title: "Changed",
    });
    assert.equal((d.execute(command) as { title: string }).title, "Task");
    f.reopen();
    assert.equal(
      (f.domain.execute(command) as { title: string }).title,
      "Task",
    );
    assert.equal(f.domain.assignments(a).length, 1);
  } finally {
    f.close();
  }
});

test("profiles store validated skill plugins per revision and assignments keep theirs", () => {
  const f = fixture();
  try {
    run(f.domain, {
      type: "profile.create",
      actor: "operator",
      profileId: profile,
      name: "Skilled",
      instructions: "Build",
      capabilities: "code",
    });
    assert.deepEqual(f.domain.profileSkills(profile), { plugins: [] });
    const one = {
      plugins: [{ path: "/plugins/a", skills: ["review", "plan"] }],
    };
    run(f.domain, {
      type: "profile.configure",
      actor: "operator",
      profileId: profile,
      expectedVersion: 1,
      skills: one,
    });
    // Other edits keep the skills; a revision keeps what it was saved with.
    run(f.domain, {
      type: "profile.configure",
      actor: "operator",
      profileId: profile,
      expectedVersion: 2,
      name: "Renamed",
    });
    assert.deepEqual(f.domain.profileSkills(profile), one);
    assert.deepEqual(f.domain.profileSkills(profile, 1), { plugins: [] });
    assert.deepEqual(f.domain.profileSkills(profile, 2), one);
    run(f.domain, {
      type: "profile.configure",
      actor: "operator",
      profileId: profile,
      expectedVersion: 3,
      skills: { plugins: [] },
    });
    assert.deepEqual(f.domain.profileSkills(profile), { plugins: [] });
    assert.deepEqual(f.domain.profileSkills(profile, 3), one);

    for (const skills of [
      { plugins: [{ path: "relative/dir", skills: ["a"] }] },
      { plugins: [{ path: "/p/.", skills: ["a"] }] },
      { plugins: [{ path: "/p/../q", skills: ["a"] }] },
      { plugins: [{ path: "/p", skills: [] }] },
      { plugins: [{ path: "/p", skills: ["a", "a"] }] },
      { plugins: [{ path: "/p", skills: ["a/b"] }] },
      {
        plugins: [
          { path: "/p", skills: ["a"] },
          { path: "/p", skills: ["b"] },
        ],
      },
      { plugins: [{ path: "/p", skills: ["a"], hooks: true }] },
    ])
      assert.throws(() =>
        run(f.domain, {
          type: "profile.configure",
          actor: "operator",
          profileId: profile,
          expectedVersion: 4,
          skills,
        } as WithoutKey<DomainCommand>),
      );
    assert.equal(f.domain.profile(profile).version, 4);
  } finally {
    f.close();
  }
});

test("profiles store a validated execution runtime per revision", () => {
  const f = fixture();
  try {
    run(f.domain, {
      type: "profile.create",
      actor: "operator",
      profileId: profile,
      name: "Codex",
      instructions: "Build",
      capabilities: "code",
    });
    assert.deepEqual(f.domain.profileRuntime(profile), { harness: "codex" });
    const claude = {
      harness: "claude" as const,
      model: "opus",
      reasoningEffort: "high",
    };
    run(f.domain, {
      type: "profile.create",
      actor: "operator",
      profileId: q,
      name: "Claude",
      instructions: "Build",
      capabilities: "code",
      runtime: claude,
    });
    assert.deepEqual(f.domain.profileRuntime(q), claude);
    assert.deepEqual(f.domain.profileRuntime(q, 1), claude);

    for (const runtime of [
      { harness: "codex", temperature: 1 },
      { harness: "codex", model: "has space" },
      { harness: "claude", model: "has space", reasoningEffort: null },
      { harness: "other" },
    ])
      assert.throws(() =>
        run(f.domain, {
          type: "profile.configure",
          actor: "operator",
          profileId: profile,
          expectedVersion: 1,
          runtime,
        } as WithoutKey<DomainCommand>),
      );
    assert.equal(f.domain.profile(profile).version, 1);
    assert.deepEqual(f.domain.profileRuntime(profile), { harness: "codex" });

    run(f.domain, {
      type: "profile.configure",
      actor: "operator",
      profileId: profile,
      expectedVersion: 1,
      runtime: { harness: "claude", model: null, reasoningEffort: null },
    });
    assert.equal(f.domain.profile(profile).version, 2);
    assert.deepEqual(f.domain.profileRuntime(profile, 1), { harness: "codex" });
    assert.deepEqual(f.domain.profileRuntime(profile, 2), {
      harness: "claude",
      model: null,
      reasoningEffort: null,
    });
    // Other edits keep the runtime.
    run(f.domain, {
      type: "profile.configure",
      actor: "operator",
      profileId: profile,
      expectedVersion: 2,
      name: "Renamed",
    });
    assert.equal(f.domain.profileRuntime(profile, 3).harness, "claude");
    // Codex settings are stored per revision, and a bare Codex runtime stays bare.
    const codex = {
      harness: "codex" as const,
      model: "m-alt",
      reasoningEffort: "medium",
    };
    run(f.domain, {
      type: "profile.configure",
      actor: "operator",
      profileId: profile,
      expectedVersion: 3,
      runtime: codex,
    });
    run(f.domain, {
      type: "profile.configure",
      actor: "operator",
      profileId: profile,
      expectedVersion: 4,
      runtime: { harness: "codex" },
    });
    assert.deepEqual(f.domain.profileRuntime(profile, 4), codex);
    assert.deepEqual(f.domain.profileRuntime(profile, 5), {
      harness: "codex",
    });
  } finally {
    f.close();
  }
});

test("Claude token reference configures, clears and never returns the name", () => {
  const f = fixture();
  try {
    assert.equal(f.domain.claudeTokenReference(), null);
    const configure = (credentialRef: string | null, actor = "operator") =>
      f.domain.execute({
        type: "claude-token.configure",
        actor,
        key: key(),
        credentialRef,
      } as DomainCommand);
    const receipt = configure("env:CLAUDE_SUBSCRIPTION_TOKEN");
    assert.deepEqual(receipt, { configured: true });
    assert.doesNotMatch(JSON.stringify(receipt), /CLAUDE_SUBSCRIPTION/);
    f.reopen();
    assert.equal(
      f.domain.claudeTokenReference(),
      "env:CLAUDE_SUBSCRIPTION_TOKEN",
    );
    assert.deepEqual(configure(null), { configured: false });
    assert.equal(f.domain.claudeTokenReference(), null);
    assert.deepEqual(configure("file:/private/claude/token"), {
      configured: true,
    });
    assert.equal(f.domain.claudeTokenReference(), "file:/private/claude/token");
    assert.deepEqual(configure(null), { configured: false });
    for (const invalid of [
      "CLAUDE_TOKEN",
      "env:lower",
      "",
      "file:",
      "file:relative",
      "file:/a/../b",
      "file:/a/./b",
      "file:/a/",
      "file:/a//b",
      "file:/a\nb",
      `file:/${"a".repeat(1019)}`,
    ])
      assert.throws(() => configure(invalid));
    assert.throws(
      () => configure("env:CLAUDE_TOKEN", "agent"),
      /Operator authority required/,
    );
    assert.equal(f.domain.claudeTokenReference(), null);
  } finally {
    f.close();
  }
});

test("getting-started dismissal toggles per installation, replays its receipt and needs the operator", () => {
  const f = fixture();
  try {
    assert.equal(f.domain.gettingStartedDismissed(), false);
    const dismiss = {
      type: "getting-started.configure" as const,
      actor: "operator" as const,
      key: key(),
      dismissed: true,
    };
    assert.deepEqual(f.domain.execute(dismiss), { dismissed: true });
    f.reopen();
    assert.equal(f.domain.gettingStartedDismissed(), true);
    assert.deepEqual(
      f.domain.execute({ ...dismiss, key: key(), dismissed: false }),
      { dismissed: false },
    );
    assert.equal(f.domain.gettingStartedDismissed(), false);
    // An exact replay returns the recorded receipt and changes nothing.
    assert.deepEqual(f.domain.execute(dismiss), { dismissed: true });
    assert.equal(f.domain.gettingStartedDismissed(), false);
    assert.throws(
      () =>
        f.domain.execute({
          ...dismiss,
          key: key(),
          actor: "agent",
        } as DomainCommand),
      /Operator authority required/,
    );
    assert.equal(f.domain.gettingStartedDismissed(), false);
  } finally {
    f.close();
  }
});

test("configuration command hashes stay byte-identical", () => {
  const f = fixture();
  try {
    const k = (n: number) => `50000000-0000-4000-8000-00000000000${n}`;
    const base = { actor: "operator" as const };
    const commands: DomainCommand[] = [
      {
        ...base,
        key: k(1),
        type: "profile.create",
        profileId: profile,
        name: "Lead",
        instructions: "i",
        capabilities: "c",
      },
      {
        ...base,
        key: k(2),
        type: "project.create",
        projectId: p,
        name: "Alpha",
        leadProfileId: profile,
        instructions: "p",
      },
      {
        ...base,
        key: k(3),
        type: "project.configure",
        projectId: p,
        expectedVersion: 1,
        instructions: "p2",
      },
      {
        ...base,
        key: k(4),
        type: "profile.configure",
        profileId: profile,
        expectedVersion: 1,
        summary: "s",
      },
      {
        ...base,
        key: k(5),
        type: "routing.configure",
        projectId: p,
        expectedVersion: 1,
        enabled: false,
        candidateProfileIds: [profile],
      },
      {
        ...base,
        key: k(6),
        type: "capacity.configure",
        globalLimit: 4,
        projectOverrides: { [p]: 3 },
      },
    ];
    for (const command of commands) f.domain.execute(command);
    const rows = f.db
      .prepare(
        "SELECT scope, key, payloadHash FROM command_receipts ORDER BY key",
      )
      .all() as { scope: string; payloadHash: string }[];
    assert.deepEqual(
      rows.map((r) => r.scope),
      [`profile:${profile}`, p, p, `profile:${profile}`, p, "system:capacity"],
    );
    assert.deepEqual(
      rows.map((r) => r.payloadHash),
      [
        "14952a93fe4757a5956ebb9ef842083396ae4b460e292ec9c72b71465ad13b2e",
        "39f4b7e1c7691622fa2a10ba949264b6305d8466e1d8199de62958444e177f71",
        "5f3ea4462901b3bb3e0f06158bd9f94c3fae30fbce8faf170dd64b32eb600339",
        "d6fc29a1518156974b95dc694ff381d9667b3cbd09f2569d14f716c5f078a5a4",
        "ee35f40a45a5fbf94c74a9e6647ffb27226bbcf277bc7a8fc0c29bf962d3acff",
        "9a4def4ed9c1e0cdff521924954021e08fb823d0a8c4fb5e5b76bb50fb1503a5",
      ],
    );
  } finally {
    f.close();
  }
});

// Persisted receipts and routing operations carry the legacy domain digest: explicit
// `undefined` hashes as the bare text `undefined`, unlike the delivery contract's
// `canonicalMaterial` (which emits `null`). These constants pin that, so stored keys keep replaying.
const legacyHashes = {
  profileOmitted:
    "71d7fb0fcfdd1bf5c5290e08b67329be55518df14c0a4b6f9243c3e258a3d98d",
  profileUndefined:
    "2b2d87587cd80e63bb245c9f1880d7a8b04bd90944d0ca63b00527317848ebbf",
  projectNull:
    "5b532e57fca2ff17f1df1d8b38d89d8fcb54cd8cd268e2b7ad4948d21ee9fe1f",
  routingOmitted:
    "631977b5bef1de657f90920acad6516748660ea5c6eb39280745a0a6da5f5642",
  routingUndefined:
    "56fb21d3e7a16c060beef904cea0501b5bca948638fbfd7d2b48cff8878cf00e",
  routingAssigned:
    "cc20d9bfe10a4d1d5a3d0e7835e35c44e49c4487b35bfe0ac2ba1d02f74f1786",
};
const profileOmittedId = "20000000-0000-4000-8000-0000000000a1";
const profileUndefinedId = "20000000-0000-4000-8000-0000000000a2";
const pinnedKeys = {
  profileOmitted: "50000000-0000-4000-8000-0000000000a1",
  profileUndefined: "50000000-0000-4000-8000-0000000000a2",
  projectNull: "50000000-0000-4000-8000-0000000000a3",
  routingOmitted: "60000000-0000-4000-8000-0000000000a1",
  routingUndefined: "60000000-0000-4000-8000-0000000000a2",
  routingAssigned: "60000000-0000-4000-8000-0000000000a3",
};

test("command receipts pin legacy digests and replay after reopen", () => {
  const f = fixture();
  try {
    const profileBase = {
      type: "profile.create" as const,
      actor: "operator" as const,
      name: "Pinned",
      instructions: "Pin the digest",
      capabilities: "review",
    };
    const omitted: DomainCommand = {
      ...profileBase,
      key: pinnedKeys.profileOmitted,
      profileId: profileOmittedId,
    };
    const undefinedSummary: DomainCommand = {
      ...profileBase,
      key: pinnedKeys.profileUndefined,
      profileId: profileUndefinedId,
      name: "Pinned undefined",
      summary: undefined,
    };
    const nullable: DomainCommand = {
      type: "project.create",
      actor: "operator",
      key: pinnedKeys.projectNull,
      projectId: p,
      name: "Alpha",
      leadProfileId: null,
    };
    const commands = [omitted, undefinedSummary, nullable];
    const first = commands.map((command) => f.domain.execute(command));
    const receipts = () =>
      f.db
        .prepare("SELECT key, payloadHash FROM command_receipts ORDER BY key")
        .all() as { key: string; payloadHash: string }[];
    const expected = [
      legacyHashes.profileOmitted,
      legacyHashes.profileUndefined,
      legacyHashes.projectNull,
    ];
    assert.deepEqual(
      receipts().map((r) => r.payloadHash),
      expected,
    );
    assert.notEqual(
      legacyHashes.profileUndefined,
      materialDigest(undefinedSummary),
    );
    f.reopen();
    assert.deepEqual(
      commands.map((command) => f.domain.execute(command)),
      first,
    );
    assert.deepEqual(
      receipts().map((r) => r.payloadHash),
      expected,
    );
    const { summary: _summary, ...withoutSummary } = undefinedSummary as {
      summary?: undefined;
    } & DomainCommand;
    assert.throws(
      () => f.domain.execute(withoutSummary as DomainCommand),
      /different payload/,
    );
    assert.throws(
      () => f.domain.execute({ ...omitted, name: "Renamed" } as DomainCommand),
      /different payload/,
    );
  } finally {
    f.close();
  }
});

test("routing operations pin legacy digests and replay after reopen", () => {
  const f = fixture();
  try {
    const d = [a, b, c];
    run(f.domain, {
      type: "profile.create",
      actor: "operator",
      profileId: profile,
      name: "Builder",
      instructions: "Code",
      capabilities: "code",
    });
    run(f.domain, {
      type: "project.create",
      actor: "operator",
      projectId: p,
      name: "Alpha",
      leadProfileId: profile,
    });
    for (const taskId of d)
      run(f.domain, {
        type: "task.create",
        actor: "operator",
        projectId: p,
        taskId,
        title: "Task",
        outcome: "Ship",
        ready: true,
      });
    run(f.domain, {
      type: "routing.configure",
      actor: "operator",
      projectId: p,
      expectedVersion: 1,
      enabled: true,
      guidance: "Fit",
      credentialRef: "env:TYPESAFE_KEY",
      candidateProfileIds: [profile],
    });
    run(f.domain, {
      type: "project.configure",
      actor: "operator",
      projectId: p,
      expectedVersion: 1,
      paused: false,
    });
    const common = {
      projectId: p,
      taskVersion: 1,
      candidateRevisions: { [profile]: 1 },
      guidanceRevision: 2,
      model: "deterministic",
      question: "Choose",
      judgment: null,
      resultDestination: "lead:task",
    };
    const fallback = {
      ...common,
      disposition: "lead-fallback",
      assignmentId: null,
    };
    const omitted = { ...fallback, id: pinnedKeys.routingOmitted, taskId: a };
    const undefinedBrief = {
      ...fallback,
      id: pinnedKeys.routingUndefined,
      taskId: b,
      brief: undefined,
    };
    const assigned = {
      ...common,
      id: pinnedKeys.routingAssigned,
      taskId: c,
      disposition: "assigned",
      assignmentId: assignment,
      judgment: "Builder",
      assignment: {
        profileId: profile,
        brief: "Ship",
        requesterAssignmentId: null,
      },
    };
    const inputs = [omitted, undefinedBrief, assigned];
    const first = inputs.map((input) => f.domain.recordRouting(input));
    const hashes = () =>
      f.db
        .prepare("SELECT payloadHash FROM routing_operations ORDER BY id")
        .all()
        .map((row) => (row as { payloadHash: string }).payloadHash);
    const expected = [
      legacyHashes.routingOmitted,
      legacyHashes.routingUndefined,
      legacyHashes.routingAssigned,
    ];
    assert.deepEqual(hashes(), expected);
    assert.notEqual(
      legacyHashes.routingUndefined,
      materialDigest(undefinedBrief),
    );
    f.reopen();
    assert.deepEqual(
      inputs.map((input) => f.domain.recordRouting(input)),
      first,
    );
    assert.deepEqual(hashes(), expected);
    const { brief: _brief, ...withoutBrief } = undefinedBrief;
    assert.throws(
      () => f.domain.recordRouting(withoutBrief),
      /Routing operation conflict/,
    );
    assert.throws(
      () => f.domain.recordRouting({ ...assigned, question: "Changed" }),
      /Routing operation conflict/,
    );
  } finally {
    f.close();
  }
});

test("in-flight dedupe agrees with durable receipts on explicit undefined", async () => {
  const f = fixture();
  try {
    const commands = new DomainCommands(f.domain);
    const command: DomainCommand = {
      type: "profile.create",
      actor: "operator",
      key: pinnedKeys.profileUndefined,
      profileId: profileUndefinedId,
      name: "Pinned undefined",
      instructions: "Pin the digest",
      capabilities: "review",
      summary: undefined,
    };
    const one = commands.execute(command);
    const two = commands.execute({ ...command });
    const { summary: _summary, ...withoutSummary } = command as {
      summary?: undefined;
    } & DomainCommand;
    const conflict = commands.execute(withoutSummary as DomainCommand);
    assert.equal(one, two);
    await assert.rejects(conflict, /different payload/);
    assert.deepEqual(await one, await two);
  } finally {
    f.close();
  }
});

test("capacity expectedCurrent guards concurrent edits and replays", () => {
  const f = fixture();
  try {
    for (const projectId of [p, q])
      run(f.domain, {
        type: "project.create",
        actor: "operator",
        projectId,
        name: projectId === p ? "Project" : "Other project",
        leadProfileId: null,
      });
    const limits = () => f.domain.capacityLimits();
    const unused = key();
    assert.equal(f.domain.recordedResult("system:capacity", unused), undefined);
    const guarded = {
      type: "capacity.configure" as const,
      actor: "operator" as const,
      key: key(),
      globalLimit: 5,
      projectOverrides: { [p]: 3 },
      expectedCurrent: { globalLimit: 4, projectOverrides: { [p]: null } },
    };
    const applied = f.domain.execute(guarded);
    assert.deepEqual(limits().projectOverrides, { [p]: 3 });
    assert.deepEqual(
      f.domain.recordedResult("system:capacity", guarded.key),
      applied,
    );
    // Replay after the limits moved returns the recorded result before the guard.
    f.domain.execute({
      type: "capacity.configure",
      actor: "operator",
      key: key(),
      globalLimit: 7,
    });
    assert.deepEqual(f.domain.execute(guarded), applied);
    const receipts = () =>
      (
        f.db.prepare("SELECT COUNT(*) AS n FROM command_receipts").get() as {
          n: number;
        }
      ).n;
    const before = receipts();
    for (const expectedCurrent of [
      { globalLimit: 5, projectOverrides: {} },
      { globalLimit: 7, projectOverrides: { [p]: null } },
      { globalLimit: 7, projectOverrides: { [p]: 2 } },
    ])
      assert.throws(
        () =>
          f.domain.execute({
            type: "capacity.configure",
            actor: "operator",
            key: key(),
            globalLimit: 1,
            projectOverrides: { [p]: 1 },
            expectedCurrent,
          }),
        DomainConflictError,
      );
    assert.equal(receipts(), before);
    assert.equal(limits().globalLimit, 7);
    assert.deepEqual(limits().projectOverrides, { [p]: 3 });
    // An override for an unlisted project is not compared.
    f.domain.execute({
      type: "capacity.configure",
      actor: "operator",
      key: key(),
      globalLimit: 7,
      projectOverrides: { [q]: 1 },
      expectedCurrent: { globalLimit: 7, projectOverrides: { [q]: null } },
    });
    assert.throws(
      () =>
        f.domain.execute({
          ...guarded,
          expectedCurrent: { globalLimit: 5, projectOverrides: {} },
        }),
      DomainConflictError,
    );
  } finally {
    f.close();
  }
});

test("project diagnostic capture defaults to enhanced and is reversible", () => {
  const f = fixture();
  try {
    run(f.domain, {
      type: "project.create",
      actor: "operator",
      projectId: p,
      name: "Alpha",
      leadProfileId: null,
    });
    assert.equal(f.domain.diagnosticCaptureMode(p), "enhanced");
    const command = {
      type: "project.configure",
      actor: "operator",
      key: key(),
      projectId: p,
      expectedVersion: 1,
      diagnosticCapture: "baseline",
    } as const;
    const first = f.domain.execute(command);
    assert.equal(f.domain.diagnosticCaptureMode(p), "baseline");
    assert.equal(Number(f.domain.project(p).version), 2);
    assert.deepEqual(f.domain.execute(command), first);
    assert.equal(Number(f.domain.project(p).version), 2);
    assert.throws(
      () => f.domain.execute({ ...command, diagnosticCapture: "enhanced" }),
      /different payload/,
    );
    assert.throws(
      () =>
        run(f.domain, {
          type: "project.configure",
          actor: "operator",
          projectId: p,
          expectedVersion: 1,
          diagnosticCapture: "enhanced",
        }),
      /Version conflict/,
    );
    // An absent field leaves the mode unchanged.
    run(f.domain, {
      type: "project.configure",
      actor: "operator",
      projectId: p,
      expectedVersion: 2,
      name: "Renamed",
    });
    assert.equal(f.domain.diagnosticCaptureMode(p), "baseline");
    f.reopen();
    assert.equal(f.domain.diagnosticCaptureMode(p), "baseline");
    run(f.domain, {
      type: "project.configure",
      actor: "operator",
      projectId: p,
      expectedVersion: 3,
      diagnosticCapture: "enhanced",
    });
    assert.equal(f.domain.diagnosticCaptureMode(p), "enhanced");
    assert.throws(() =>
      run(f.domain, {
        type: "project.configure",
        actor: "operator",
        projectId: p,
        expectedVersion: 4,
        diagnosticCapture: "verbose" as "baseline",
      }),
    );
  } finally {
    f.close();
  }
});

test("project command network access defaults off, is versioned and is operator-only", () => {
  const f = fixture();
  try {
    run(f.domain, {
      type: "project.create",
      actor: "operator",
      projectId: p,
      name: "Alpha",
      leadProfileId: null,
    });
    assert.equal(f.domain.commandNetworkAccess(p), false);
    const command = {
      type: "project.configure",
      actor: "operator",
      key: key(),
      projectId: p,
      expectedVersion: 1,
      commandNetworkAccess: true,
    } as const;
    const first = f.domain.execute(command);
    assert.equal(f.domain.commandNetworkAccess(p), true);
    assert.equal(Number(f.domain.project(p).version), 2);
    assert.deepEqual(f.domain.execute(command), first);
    assert.throws(
      () => f.domain.execute({ ...command, commandNetworkAccess: false }),
      /different payload/,
    );
    assert.throws(
      () =>
        run(f.domain, {
          type: "project.configure",
          actor: "operator",
          projectId: p,
          expectedVersion: 1,
          commandNetworkAccess: false,
        }),
      /Version conflict/,
    );
    assert.throws(
      () =>
        run(f.domain, {
          type: "project.configure",
          actor: "agent",
          projectId: p,
          expectedVersion: 2,
          commandNetworkAccess: false,
        }),
      DomainPolicyError,
    );
    assert.equal(f.domain.commandNetworkAccess(p), true);
    // An absent field leaves it unchanged.
    run(f.domain, {
      type: "project.configure",
      actor: "operator",
      projectId: p,
      expectedVersion: 2,
      name: "Renamed",
    });
    f.reopen();
    assert.equal(f.domain.commandNetworkAccess(p), true);
    run(f.domain, {
      type: "project.configure",
      actor: "operator",
      projectId: p,
      expectedVersion: 3,
      commandNetworkAccess: false,
    });
    assert.equal(f.domain.commandNetworkAccess(p), false);
  } finally {
    f.close();
  }
});

test("runtime enablement persists per harness, replays its receipt and sets the profile default", () => {
  const f = fixture();
  try {
    assert.deepEqual(f.domain.enabledRuntimes(), ["codex", "claude"]);
    const configure = (
      harness: "codex" | "claude",
      enabled: boolean,
      k = key(),
    ) =>
      f.domain.execute({
        type: "runtime.configure",
        actor: "operator",
        key: k,
        harness,
        enabled,
      });
    const replayKey = key();
    assert.deepEqual(configure("claude", false, replayKey), {
      harness: "claude",
      enabled: false,
    });
    assert.deepEqual(configure("claude", false, replayKey), {
      harness: "claude",
      enabled: false,
    });
    assert.throws(
      () => configure("claude", true, replayKey),
      DomainConflictError,
    );
    f.reopen();
    assert.equal(f.domain.runtimeEnabled("claude"), false);
    assert.equal(f.domain.runtimeEnabled("codex"), true);

    const create = () => {
      const profileId = crypto.randomUUID();
      f.domain.execute({
        type: "profile.create",
        actor: "operator",
        key: key(),
        profileId,
        name: "Default",
        instructions: "build",
        capabilities: "code",
      });
      return f.domain.profileRuntime(profileId);
    };
    assert.deepEqual(create(), { harness: "codex" });
    configure("claude", true);
    configure("codex", false);
    assert.deepEqual(create(), {
      harness: "claude",
      model: null,
      reasoningEffort: null,
    });
    configure("claude", false);
    assert.deepEqual(f.domain.enabledRuntimes(), []);
    assert.deepEqual(create(), { harness: "codex" });
    assert.throws(
      () =>
        f.domain.execute({
          type: "runtime.configure",
          actor: "agent",
          key: key(),
          harness: "codex",
          enabled: true,
        } as DomainCommand),
      /Operator authority required/,
    );
  } finally {
    f.close();
  }
});
