import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import {
  DraftingRunStore,
  draftingProposalTtlMs,
  issueDraftingRequest,
  issueEditProposalOf,
} from "../../src/standalone/drafting.js";
import { SchedulerStore } from "../../src/standalone/scheduler.js";

const legacyTurnRequests = `CREATE TABLE turn_requests (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  requestKey TEXT NOT NULL UNIQUE,
  workId TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK(kind IN ('direct','assignment')),
  taskId TEXT, projectId TEXT, assignmentId TEXT, taskVersion INTEGER,
  assignmentVersion INTEGER, instructionsRevision INTEGER, profileRevision INTEGER,
  prompt TEXT NOT NULL, workspace TEXT, previousWorkId TEXT,
  state TEXT NOT NULL CHECK(state IN ('queued','active','completed','held')),
  reason TEXT, nextEligibleAt INTEGER
)`;

function legacyDatabase() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(legacyTurnRequests);
  // A later state migration appended this column; the rebuild must keep it.
  db.exec(`ALTER TABLE turn_requests ADD COLUMN holdKind TEXT
    CHECK(holdKind IS NULL OR holdKind = 'operator-stop')`);
  db.exec(
    "CREATE TABLE successor (workId TEXT PRIMARY KEY REFERENCES turn_requests(workId))",
  );
  const insert = db.prepare(`INSERT INTO turn_requests
    (requestKey, workId, kind, prompt, state, holdKind) VALUES (?,?,?,?,?,?)`);
  insert.run("a", "work-a", "direct", "one", "completed", null);
  insert.run("b", "work-b", "assignment", "two", "held", "operator-stop");
  insert.run("c", "work-c", "assignment", "three", "queued", null);
  db.prepare("INSERT INTO successor VALUES ('work-b')").run();
  // Delete the newest row: AUTOINCREMENT must still never reuse sequence 3.
  db.prepare("DELETE FROM turn_requests WHERE workId = 'work-c'").run();
  return db;
}

test("turn request migration keeps rows, sequences and links and admits drafting", () => {
  const db = legacyDatabase();
  const before = db
    .prepare("SELECT * FROM turn_requests ORDER BY sequence")
    .all();
  new SchedulerStore(db);
  const after = db
    .prepare("SELECT * FROM turn_requests ORDER BY sequence")
    .all() as Array<{ draftTurn: number; draftTaskDigest: string | null }>;
  // Every migrated row is an ordinary turn.
  assert.deepEqual(
    after.map((row) => [row.draftTurn, row.draftTaskDigest]),
    [
      [0, null],
      [0, null],
    ],
  );
  assert.deepEqual(
    after.map(({ draftTurn: _, draftTaskDigest: __, ...row }) => row),
    before.map((row) => ({ ...row })),
  );
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  assert.equal(db.prepare("SELECT * FROM successor").all().length, 1);
  const indexes = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'turn_requests_%_sequence'",
    )
    .all();
  assert.equal(indexes.length, 3);

  const projectId = randomUUID();
  const drafting = new SchedulerStore(db).ensure({
    requestKey: `drafting:${randomUUID()}`,
    workId: "drafting:one",
    kind: "drafting",
    taskId: null,
    projectId,
    assignmentId: null,
    taskVersion: null,
    assignmentVersion: null,
    instructionsRevision: null,
    profileRevision: 1,
    prompt: "idea",
    workspace: null,
    previousWorkId: null,
  });
  assert.equal(drafting.kind, "drafting");
  assert.equal(drafting.sequence, 4, "high-water mark survives the rebuild");
  db.close();
});

test("the migration is not blocked by a foreign key violation elsewhere", () => {
  const db = legacyDatabase();
  // Another table's own, older violation is not the migration's to judge.
  db.exec("PRAGMA foreign_keys = OFF");
  db.exec(
    "CREATE TABLE unrelated (id TEXT, parent TEXT REFERENCES missing(id))",
  );
  db.exec("INSERT INTO unrelated VALUES ('a', 'absent')");
  db.exec("PRAGMA foreign_keys = ON");
  new SchedulerStore(db);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM turn_requests").get()?.n,
    2,
  );
  db.close();
});

test("turn request migration is idempotent", () => {
  const db = legacyDatabase();
  new SchedulerStore(db);
  const migrated = db
    .prepare("SELECT sql FROM sqlite_master WHERE name = 'turn_requests'")
    .get();
  new SchedulerStore(db);
  assert.deepEqual(
    db
      .prepare("SELECT sql FROM sqlite_master WHERE name = 'turn_requests'")
      .get(),
    migrated,
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM turn_requests").get()?.n,
    2,
  );
  db.close();
});

function draftingStore() {
  const clock = { now: 1_000 };
  const db = new DatabaseSync(":memory:");
  return {
    clock,
    store: new DraftingRunStore(db, () => clock.now),
    db,
  };
}

const proposal = { title: "A title", outcome: "An outcome" };

function newRun(store: DraftingRunStore) {
  return store.create({
    runId: randomUUID(),
    projectId: randomUUID(),
    idea: "rough idea",
    harness: "codex",
    profileId: randomUUID(),
    profileRevision: 1,
    instructionsRevision: 1,
  });
}

test("drafting runs follow the lifecycle and refuse illegal moves", () => {
  const { store } = draftingStore();
  const run = newRun(store);
  assert.equal(run.state, "queued");
  assert.throws(() => store.transition(run.runId, "proposed"), /cannot move/);
  store.transition(run.runId, "running");
  assert.throws(() => store.transition(run.runId, "proposed"), /no proposal/);
  store.recordProposal(run.runId, proposal);
  assert.equal(
    store.require(run.runId).proposal,
    null,
    "hidden until the turn ends",
  );
  store.transition(run.runId, "proposed");
  assert.deepEqual(store.require(run.runId).proposal, proposal);
  store.transition(run.runId, "accepted");
  assert.equal(store.require(run.runId).proposal, null, "claimed once");
  assert.throws(() => store.transition(run.runId, "running"), /cannot move/);
});

test("a stopped run settles only through stopping and may be discarded", () => {
  const { store } = draftingStore();
  const run = newRun(store);
  store.transition(run.runId, "running");
  store.transition(run.runId, "stopping");
  assert.throws(() => store.transition(run.runId, "proposed"), /cannot move/);
  store.transition(run.runId, "interrupted", "Stopped");
  assert.equal(store.require(run.runId).reason, "Stopped");
  store.transition(run.runId, "discarded");
});

test("an unclaimed proposal expires after 24 hours", () => {
  const { store, clock } = draftingStore();
  const run = newRun(store);
  store.transition(run.runId, "running");
  store.recordProposal(run.runId, proposal);
  store.transition(run.runId, "proposed");
  const proposedAt = clock.now;
  clock.now = proposedAt + draftingProposalTtlMs - 1;
  assert.equal(store.require(run.runId).state, "proposed");
  assert.equal(
    store.require(run.runId).expiresAt,
    proposedAt + draftingProposalTtlMs,
  );
  clock.now = proposedAt + draftingProposalTtlMs;
  assert.equal(store.require(run.runId).state, "expired");
  assert.equal(store.require(run.runId).proposal, null);
  assert.throws(() => store.transition(run.runId, "accepted"), /cannot move/);
});

test("startup sweep expires overdue proposals and lists unfinished runs", () => {
  const { store, clock } = draftingStore();
  const old = newRun(store);
  store.transition(old.runId, "running");
  store.recordProposal(old.runId, proposal);
  store.transition(old.runId, "proposed");
  const live = newRun(store);
  clock.now += draftingProposalTtlMs + 1;
  store.sweepExpired();
  assert.equal(store.require(old.runId).state, "expired");
  assert.deepEqual(
    store.unfinished().map(({ runId }) => runId),
    [live.runId],
  );
});

test("a reused run id with other content is refused", () => {
  const { store } = draftingStore();
  const run = newRun(store);
  assert.equal(store.create({ ...run, idea: run.idea }).runId, run.runId);
  assert.throws(
    () => store.create({ ...run, idea: "different" }),
    /other content/,
  );
});

const issue = {
  taskId: randomUUID(),
  sourceNodeId: "I_1",
  observedTitle: "Thin title",
  observedBody: "Thin body",
};

function newIssueRun(store: DraftingRunStore, idea = "") {
  return store.create({
    runId: randomUUID(),
    projectId: randomUUID(),
    idea,
    harness: "codex",
    profileId: randomUUID(),
    profileRevision: 1,
    instructionsRevision: 1,
    issue,
  });
}

test("a table written before issue runs gains the columns and its rows read as briefs", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE drafting_runs (
    runId TEXT PRIMARY KEY, projectId TEXT NOT NULL, idea TEXT NOT NULL,
    harness TEXT NOT NULL, profileId TEXT NOT NULL, profileRevision INTEGER NOT NULL,
    instructionsRevision INTEGER NOT NULL, state TEXT NOT NULL, reason TEXT,
    title TEXT, outcome TEXT, createdAt INTEGER NOT NULL, proposedAt INTEGER)`);
  const runId = randomUUID();
  // A run mid-flight across the upgrade.
  db.prepare(
    `INSERT INTO drafting_runs
    (runId, projectId, idea, harness, profileId, profileRevision, instructionsRevision, state, createdAt)
    VALUES (?, ?, 'old idea', 'codex', ?, 1, 1, 'running', 1)`,
  ).run(runId, randomUUID(), randomUUID());
  const store = new DraftingRunStore(db);
  new DraftingRunStore(db); // idempotent
  const run = store.require(runId);
  assert.equal(run.kind, "brief");
  assert.equal(run.taskId, null);
  store.recordProposal(runId, proposal);
  store.transition(runId, "proposed");
  assert.deepEqual(store.require(runId).proposal, proposal);
  assert.equal(issueEditProposalOf(store.require(runId)), null);
});

test("an issue run records its source and returns a title and body beyond the brief limit", () => {
  const { store } = draftingStore();
  const run = newIssueRun(store, "mention the API");
  assert.equal(run.kind, "issue");
  assert.equal(run.observedBody, "Thin body");
  store.transition(run.runId, "running");
  const body = "x".repeat(40_000);
  store.recordProposal(run.runId, { title: "  Better  ", body });
  assert.equal(
    store.require(run.runId).proposal,
    null,
    "hidden until proposed",
  );
  store.transition(run.runId, "proposed");
  assert.deepEqual(issueEditProposalOf(store.require(run.runId)), {
    title: "Better",
    body,
  });
  store.transition(run.runId, "accepted");
  assert.equal(issueEditProposalOf(store.require(run.runId)), null);
});

test("an issue run refuses blank or oversize proposals and keeps the earlier one", () => {
  const { store } = draftingStore();
  const run = newIssueRun(store);
  store.transition(run.runId, "running");
  store.recordProposal(run.runId, { title: "Kept", body: "Kept body" });
  for (const bad of [
    { title: "  ", body: "b" },
    { title: "t", body: "   " },
    { title: "t".repeat(513), body: "b" },
    { title: "t", body: "b".repeat(64_001) },
    { title: "t", outcome: "o" },
  ])
    assert.throws(() => store.recordProposal(run.runId, bad as never));
  store.transition(run.runId, "proposed");
  assert.deepEqual(issueEditProposalOf(store.require(run.runId)), {
    title: "Kept",
    body: "Kept body",
  });
});

test("an issue run cannot take a brief proposal and a brief run cannot take a body", () => {
  const { store } = draftingStore();
  const issueRun = newIssueRun(store);
  store.transition(issueRun.runId, "running");
  assert.throws(() => store.recordProposal(issueRun.runId, proposal));
  const brief = newRun(store);
  store.transition(brief.runId, "running");
  assert.throws(() =>
    store.recordProposal(brief.runId, { title: "t", body: "b" } as never),
  );
});

test("a reused issue run id with another task is refused and an empty note is allowed", () => {
  const { store } = draftingStore();
  const run = newIssueRun(store);
  assert.equal(run.idea, "");
  assert.throws(
    () =>
      store.create({
        ...run,
        issue: { ...issue, taskId: randomUUID() },
      }),
    /other content/,
  );
  assert.equal(store.create({ ...run, issue }).runId, run.runId);
});

test("the issue request shows the observed text and the operator note", () => {
  const { store } = draftingStore();
  const text = issueDraftingRequest(newIssueRun(store, "mention the API"));
  assert.match(text, /Thin title/);
  assert.match(text, /Thin body/);
  assert.match(text, /mention the API/);
});
