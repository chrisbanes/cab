import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { OperatorApi } from "../../src/standalone/operator-api.js";
import { createOperatorFixture } from "../fixtures/operator-web.js";
import { wrapTaskExclusions } from "../fixtures/exclusions-hook.js";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { DeletedProjectRedactionStore } from "../../src/core/deleted-project-redaction.js";
import { RedactionLimitError } from "../../src/core/redaction-limits.js";
import { transaction } from "../../src/core/store.js";
import { sanitizeConversationText } from "../../src/standalone/conversation-history.js";
import { tmpdir } from "../fixtures/temp.js";

test("retiring instructions, paths and credential exclusions survive removal and restart", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "deleted-redaction-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "state.sqlite");
  let db = new DatabaseSync(path);
  t.after(() => {
    if (db.isOpen) db.close();
  });
  let store = new DeletedProjectRedactionStore(db);
  db.exec(`CREATE TABLE project_instruction_revisions (projectId TEXT, instructions TEXT);
    CREATE TABLE comments (body TEXT);
    CREATE TABLE profiles (instructions TEXT);
    INSERT INTO comments VALUES ('Earlier B comment mentions private-X and old-X');
    INSERT INTO profiles VALUES ('shared profile');
    INSERT INTO project_instruction_revisions VALUES ('A', 'old-X'), ('A', 'private-X');`);
  transaction(db, () => {
    store.captureProject(
      "A",
      ["shared profile"],
      ["/old/path", "env:OLD_KEY", "OLD_KEY", "resolved-value"],
    );
    db.prepare(
      "DELETE FROM project_instruction_revisions WHERE projectId = ?",
    ).run("A");
  });
  db.close();
  db = new DatabaseSync(path);
  store = new DeletedProjectRedactionStore(db);
  const comment = db.prepare("SELECT body FROM comments").get() as {
    body: string;
  };
  assert.equal(
    sanitizeConversationText(comment.body, store.exclusions([])),
    "Earlier B comment mentions [redacted] and [redacted]",
  );
  for (const value of [
    "old-X",
    "private-X",
    "/old/path",
    "env:OLD_KEY",
    "OLD_KEY",
    "resolved-value",
  ])
    assert.equal(
      sanitizeConversationText(value, store.exclusions([])),
      "[redacted]",
    );
  assert.deepEqual(
    db.prepare("SELECT instructions FROM profiles").get(),
    Object.assign(Object.create(null), { instructions: "shared profile" }),
  );
});

test("capture requires a transaction, deduplicates exactly and rolls back with deletion", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const store = new DeletedProjectRedactionStore(db);
    assert.throws(() => store.capture([], ["secret"]), /transaction/);
    assert.throws(
      () =>
        transaction(db, () => {
          store.capture([], ["secret"]);
          throw new Error("delete failed");
        }),
      /delete failed/,
    );
    assert.deepEqual(store.exclusions([]), []);
    db.exec(
      "CREATE TABLE owned (value TEXT); INSERT INTO owned VALUES ('still-owned')",
    );
    assert.throws(
      () =>
        transaction(db, () => {
          store.capture([], ["private-retiring"]);
          db.exec("DELETE FROM owned");
          throw new Error("later deletion phase failed");
        }),
      /later deletion phase failed/,
    );
    assert.equal(
      (db.prepare("SELECT value FROM owned").get() as { value: string }).value,
      "still-owned",
    );
    assert.deepEqual(store.exclusions([]), []);
    transaction(db, () =>
      store.capture([], ["", "secret", "secret", " secret"]),
    );
    assert.deepEqual(store.exclusions(["secret"]).sort(), [
      " secret",
      "secret",
    ]);
    assert.equal(store.fingerprint(["secret"]), store.fingerprint([]));
  } finally {
    db.close();
  }
});

test("complete live and retained union enforces count and UTF-8 bounds before writes", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const store = new DeletedProjectRedactionStore(db);
    const values = Array.from({ length: 4096 }, (_, i) => String(i));
    assert.equal(store.exclusions(values).length, 4096);
    assert.throws(
      () => transaction(db, () => store.capture(values, ["extra"])),
      RedactionLimitError,
    );
    assert.deepEqual(store.exclusions([]), []);
    transaction(db, () => store.capture([], values));
    assert.equal(store.exclusions([values[0]!]).length, 4096);
    assert.throws(
      () => transaction(db, () => store.capture([], ["retiring-overflow"])),
      RedactionLimitError,
    );
    assert.equal(
      store.exclusions([]).length,
      4096,
      "failed retiring capture preserves existing ledger",
    );
    assert.throws(
      () => store.exclusions(["live-overflow"]),
      RedactionLimitError,
    );
    db.exec("DELETE FROM deleted_project_redaction_values");
    const boundary = Array.from(
      { length: 256 },
      (_, i) => `${String(i).padStart(3, "0")}${"x".repeat(65533)}`,
    );
    transaction(db, () => store.capture([], boundary.slice(0, 255)));
    assert.equal(store.exclusions([boundary[255]!]).length, 256);
    assert.throws(
      () => store.exclusions([boundary[255]!, "x"]),
      RedactionLimitError,
    );
    db.exec("DELETE FROM deleted_project_redaction_values");
    assert.equal(store.exclusions(boundary).length, 256);
    assert.throws(
      () => store.exclusions([...boundary, "x"]),
      RedactionLimitError,
    );
    assert.equal(store.exclusions(["é".repeat(32768)]).length, 1);
    assert.throws(
      () => store.exclusions(["é".repeat(32769)]),
      RedactionLimitError,
    );
    assert.throws(
      () => store.exclusions([null as unknown as string]),
      /unavailable/,
    );
    db.prepare("INSERT INTO deleted_project_redaction_values VALUES (?)").run(
      new Uint8Array([1, 2]),
    );
    assert.throws(
      () => store.exclusions([]),
      /unavailable/,
      "malformed persisted value fails closed",
    );
    db.exec("DROP TABLE deleted_project_redaction_values");
    assert.throws(() => store.exclusions([]));
  } finally {
    db.close();
  }
});

test("an operator read crossing private capture rebuilds and never returns the old text", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const d = f.service.domain(),
    profileId = randomUUID(),
    projectId = randomUUID(),
    taskId = randomUUID();
  d.execute({
    type: "profile.create",
    actor: "operator",
    key: randomUUID(),
    profileId,
    name: "Lead",
    instructions: "Shared profile",
    capabilities: "coordination",
  });
  d.execute({
    type: "project.create",
    actor: "operator",
    key: randomUUID(),
    projectId,
    name: "Survivor",
    leadProfileId: profileId,
  });
  d.execute({
    type: "task.create",
    actor: "operator",
    key: randomUUID(),
    projectId,
    taskId,
    title: "Earlier text contains private-X",
    outcome: "Outcome",
    ready: false,
  });
  const api = new OperatorApi(f.service, [f.directory]);
  let captured = false;
  let attempts = 0;
  const restore = wrapTaskExclusions(api, async (_id, run) => {
    attempts++;
    if (!captured) {
      captured = true;
      f.seedPersistedState((db) => {
        const store = new DeletedProjectRedactionStore(db);
        transaction(db, () => store.capture([], ["private-X"]));
      });
    }
    return run();
  });
  t.after(restore);
  const response = JSON.stringify(await api.readProject(projectId));
  assert.ok(captured);
  assert.equal(attempts, 2, "projection rebuilt exactly once");
  assert.equal(response.includes("private-X"), false);
  assert.ok(response.includes("[redacted]"));
  assert.equal(
    f.runtime.prompts.some((prompt) => prompt.includes("private-X")),
    false,
  );
});

test("ledger overflow and unavailable storage fail closed on operator reads", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const api = new OperatorApi(f.service, [f.directory]);
  f.seedPersistedState((db) => {
    db.prepare("INSERT INTO deleted_project_redaction_values VALUES (?)").run(
      "x".repeat(65537),
    );
  });
  await assert.rejects(api.readTaskListPage(), {
    status: 503,
    code: "redaction-limit",
  });
  f.seedPersistedState((db) =>
    db.exec("DROP TABLE deleted_project_redaction_values"),
  );
  await assert.rejects(api.readTaskListPage(), {
    status: 503,
    code: "unavailable",
  });
});

test("private ledger has no public projection or model-context consumers", () => {
  const root = join(process.cwd(), "src");
  const consumers = readdirSync(root, { recursive: true })
    .filter(
      (file): file is string =>
        typeof file === "string" && file.endsWith(".ts"),
    )
    .filter((file) => file !== "core/deleted-project-redaction.ts")
    .filter((file) =>
      readFileSync(join(root, file), "utf8").includes(
        "deleted-project-redaction.js",
      ),
    );
  assert.deepEqual(consumers, ["standalone/service.ts"]);
});

test("surviving task comment stays redacted after retiring another project's instruction rows and restarting the service", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const d = f.service.domain(),
    profileId = randomUUID(),
    survivor = randomUUID(),
    retiring = randomUUID(),
    taskId = randomUUID();
  d.execute({
    type: "profile.create",
    actor: "operator",
    key: randomUUID(),
    profileId,
    name: "Shared lead",
    instructions: "shared instructions",
    capabilities: "coordination",
  });
  for (const [projectId, name] of [
    [survivor, "Survivor"],
    [retiring, "Retiring"],
  ] as const)
    d.execute({
      type: "project.create",
      actor: "operator",
      key: randomUUID(),
      projectId,
      name,
      leadProfileId: profileId,
    });
  d.execute({
    type: "task.create",
    actor: "operator",
    key: randomUUID(),
    projectId: survivor,
    taskId,
    title: "Surviving task",
    outcome: "Outcome",
    ready: false,
  });
  const canary = "private-later-instruction";
  f.seedPersistedState((db) =>
    db
      .prepare(
        "INSERT INTO coordination_task_comments (commentId, taskId, author, body) VALUES (?, ?, 'operator', ?)",
      )
      .run(randomUUID(), taskId, `Earlier comment: ${canary}`),
  );
  let api = new OperatorApi(f.service, [f.directory]);
  const timeline = () => api.readTaskTimeline(taskId, new URLSearchParams());
  assert.ok(
    JSON.stringify(await timeline()).includes(canary),
    "comment predates any private exclusion",
  );
  for (const instructions of [canary, "newer-private-revision"])
    d.execute({
      type: "project.configure",
      actor: "operator",
      key: randomUUID(),
      projectId: retiring,
      expectedVersion: Number(d.project(retiring).version),
      instructions,
    });
  assert.equal(
    JSON.stringify(await timeline()).includes(canary),
    false,
    "old live revision already excludes comment text",
  );
  const sharedBefore = d.profile(profileId);
  f.seedPersistedState((db) => {
    const store = new DeletedProjectRedactionStore(db);
    transaction(db, () => {
      store.captureProject(
        retiring,
        [],
        [
          "/removed/private-path",
          "env:REMOVED_TOKEN",
          "REMOVED_TOKEN",
          "removed-token-value",
        ],
      );
      // T1 exercises removal of the exclusion source, without implementing T3's ownership deletion.
      db.prepare(
        "DELETE FROM project_instruction_revisions WHERE projectId = ?",
      ).run(retiring);
    });
  });
  const assertPrivate = async () => {
    const response = JSON.stringify(await timeline());
    assert.equal(response.includes(canary), false);
    assert.ok(response.includes("[redacted]"));
    assert.equal(
      JSON.stringify(await api.readTaskListPage()).includes(canary),
      false,
    );
    assert.equal(
      JSON.stringify(await api.readComposerOptions(survivor)).includes(canary),
      false,
    );
    assert.equal(JSON.stringify(await api.readInbox()).includes(canary), false);
    assert.deepEqual(f.service.domain().profile(profileId), sharedBefore);
    const failure = f.service.failureExclusions();
    assert.ok(failure);
    assert.equal(
      sanitizeConversationText(`Failure ${canary}`, failure),
      "Failure [redacted]",
    );
    assert.equal(
      JSON.stringify(
        await api.readProfileInstructions(profileId, new URLSearchParams()),
      ).includes("shared instructions"),
      true,
      "shared live instruction disclosure remains available",
    );
  };
  await assertPrivate();
  await f.reopen();
  api = new OperatorApi(f.service, [f.directory]);
  await assertPrivate();
  const exclusions = f.service.redactionExclusions;
  try {
    // Calibrate the counterexample: omitting the retained union reveals the historical comment.
    f.service.redactionExclusions = (live) => [...live];
    assert.ok(JSON.stringify(await timeline()).includes(canary));
  } finally {
    f.service.redactionExclusions = exclusions;
  }
  await assertPrivate();
});

test("another exclusion change during the rebuilt read refuses the response", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const d = f.service.domain(),
    profileId = randomUUID(),
    projectId = randomUUID(),
    taskId = randomUUID();
  d.execute({
    type: "profile.create",
    actor: "operator",
    key: randomUUID(),
    profileId,
    name: "Lead",
    instructions: "Instructions",
    capabilities: "coordination",
  });
  d.execute({
    type: "project.create",
    actor: "operator",
    key: randomUUID(),
    projectId,
    name: "Project",
    leadProfileId: profileId,
  });
  d.execute({
    type: "task.create",
    actor: "operator",
    key: randomUUID(),
    projectId,
    taskId,
    title: "Task",
    outcome: "Outcome",
    ready: false,
  });
  const api = new OperatorApi(f.service, [f.directory]);
  let attempts = 0;
  const restore = wrapTaskExclusions(api, async (_id, run) => {
    const response = await run();
    attempts++;
    f.seedPersistedState((db) =>
      transaction(db, () =>
        new DeletedProjectRedactionStore(db).capture(
          [],
          [`new-private-value-${attempts}`],
        ),
      ),
    );
    return response;
  });
  t.after(restore);
  await assert.rejects(api.readProject(projectId), {
    status: 503,
    code: "unavailable",
  });
  assert.equal(attempts, 2);
});

test("retained private values enter neither a real scheduled prompt nor its result receipt", async (t) => {
  const { completedLead } = await import("../fixtures/completed-lead.js");
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const canary = "retired-private-instruction-opaque-71924";
  f.seedPersistedState((db) =>
    transaction(db, () =>
      new DeletedProjectRedactionStore(db).capture([], [canary]),
    ),
  );
  const { task, api } = await completedLead(f, "Private retention prompt");
  assert.ok(f.runtime.prompts.length > 0);
  assert.equal(JSON.stringify(f.runtime.prompts).includes(canary), false);
  assert.equal(
    JSON.stringify(await api.readTask(task.taskId)).includes(canary),
    false,
  );
  assert.equal(
    JSON.stringify(
      await api.readTaskTimeline(task.taskId, new URLSearchParams()),
    ).includes(canary),
    false,
  );
});
