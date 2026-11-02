import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { DomainStore } from "../../src/core/domain.js";
import { LeadTextStore } from "../../src/core/lead-text.js";
import { Store } from "../../src/core/store.js";
import { TaskReviewStore } from "../../src/core/task-review.js";
import {
  issueDiffByteLimit,
  issueDiffLineLimit,
  issueDiffTruncated,
  issueTextDiff,
  leadTaskSection,
} from "../../src/standalone/lead-text-prompt.js";

/** One imported task with source history, in a migrated store. */
function world() {
  const db = new DatabaseSync(":memory:");
  new Store(db).ensureHost("test");
  const domain = new DomainStore(db);
  domain.migrate();
  const projectId = randomUUID(),
    taskId = randomUUID();
  domain.execute({
    type: "project.create",
    actor: "operator",
    key: randomUUID(),
    projectId,
    name: "Lead text",
    leadProfileId: null,
  });
  db.prepare("INSERT INTO tasks (id, projectId, title) VALUES (?, ?, 'A')").run(
    taskId,
    projectId,
  );
  db.prepare(
    "INSERT INTO domain_tasks (id, projectId, version, outcome, ready, state, importedBlockers) VALUES (?, ?, 1, 'Body A', 1, 'open', 'clear')",
  ).run(taskId, projectId);
  db.prepare(
    "INSERT INTO imported_tasks (taskId, provider, instance, externalId, containerId) VALUES (?, 'github', 'github.com', 'I_1', 'R_1')",
  ).run(taskId);
  const reviews = new TaskReviewStore(db);
  /** A synced edit: the task takes the text and history captures it. */
  const edit = (title: string, outcome: string) => {
    db.prepare("UPDATE tasks SET title = ? WHERE id = ?").run(title, taskId);
    db.prepare("UPDATE domain_tasks SET outcome = ? WHERE id = ?").run(
      outcome,
      taskId,
    );
    reviews.captureSource(taskId, "github", { title, body: outcome });
  };
  edit("A", "Body A");
  return { db, domain, store: new LeadTextStore(db), taskId, edit };
}

const submit = (
  w: ReturnType<typeof world>,
  workId: string,
  sequence: number,
  assignmentId = "lead",
) =>
  w.store.prepare({
    workId,
    taskId: w.taskId,
    assignmentId,
    requestSequence: sequence,
    threadId: "thread",
    text: w.store.current(w.taskId),
  });

test("only a confirmed submission defines the lead's last seen text", () => {
  const w = world();
  try {
    assert.equal(w.store.confirmed("lead"), undefined);
    submit(w, "w1", 1);
    assert.equal(w.store.confirmed("lead"), undefined);
    assert.equal(w.store.confirm("w1", "thread", "turn-1"), true);
    assert.deepEqual(w.store.confirmed("lead"), {
      title: "A",
      outcome: "Body A",
      sourceRevision: 1,
    });
    // A later submission whose response was lost stays unconfirmed: A remains seen.
    w.edit("B", "Body B");
    submit(w, "w2", 2);
    assert.equal(w.store.confirmed("lead")?.title, "A");
    // The candidate keeps the text it carried, whatever later syncs bring.
    w.edit("C", "Body C");
    assert.equal(w.store.confirm("w2", "thread", "turn-2"), true);
    assert.deepEqual(w.store.confirmed("lead"), {
      title: "B",
      outcome: "Body B",
      sourceRevision: 2,
    });
  } finally {
    w.db.close();
  }
});

test("a wrong thread, a different turn, a replay or an older confirmation cannot move the pointer", () => {
  const w = world();
  try {
    submit(w, "w1", 1);
    w.edit("B", "Body B");
    submit(w, "w2", 2);
    assert.equal(w.store.confirm("w2", "other-thread", "turn-2"), false);
    assert.equal(w.store.confirm("missing", "thread", "turn-2"), false);
    assert.equal(w.store.confirm("w2", "thread", "turn-2"), true);
    assert.equal(w.store.confirm("w2", "thread", "turn-other"), false);
    assert.equal(w.store.confirm("w2", "thread", "turn-2"), true);
    // The older work confirms late: it never regresses the newer text.
    assert.equal(w.store.confirm("w1", "thread", "turn-1"), false);
    assert.equal(w.store.confirmed("lead")?.title, "B");
    // Another assignment's work is its own.
    w.edit("C", "Body C");
    submit(w, "w3", 3, "other-lead");
    w.store.confirm("w3", "thread", "turn-3");
    assert.equal(w.store.confirmed("lead")?.title, "B");
    assert.equal(w.store.confirmed("other-lead")?.title, "C");
  } finally {
    w.db.close();
  }
});

test("the handback flag follows source revisions, including an edit that is reverted", () => {
  const w = world();
  try {
    assert.equal(w.store.changedSinceHandback(w.taskId), false);
    submit(w, "w1", 1);
    w.store.confirm("w1", "thread", "turn-1");
    // Edited while the turn ran: the handback anchors what the work carried.
    w.edit("B", "Body B");
    w.store.recordHandback(w.taskId, "handback", "w1");
    assert.equal(w.store.changedSinceHandback(w.taskId), true);
    // A later handback anchors its own work's text.
    submit(w, "w2", 2);
    w.store.recordHandback(w.taskId, "handback", "w2");
    assert.equal(w.store.changedSinceHandback(w.taskId), false);
    w.edit("C", "Body C");
    w.edit("B", "Body B");
    assert.equal(w.store.changedSinceHandback(w.taskId), true);
    // A Done transition without lead work anchors the text observed then.
    w.store.recordHandback(w.taskId, "done");
    assert.equal(w.store.changedSinceHandback(w.taskId), false);
    // A local task never flags.
    w.db.prepare("DELETE FROM imported_tasks").run();
    w.edit("D", "Body D");
    assert.equal(w.store.changedSinceHandback(w.taskId), false);
  } finally {
    w.db.close();
  }
});

test("an upgrade anchors finished imported work at the text observed then, without claiming earlier edits", () => {
  const w = world();
  try {
    w.db.exec(
      "DROP TABLE task_handback_text; DROP TABLE lead_text_confirmed; DROP TABLE lead_text_submissions",
    );
    w.db
      .prepare("UPDATE domain_tasks SET state = 'done' WHERE id = ?")
      .run(w.taskId);
    w.edit("B", "Body B");
    w.domain.migrate();
    assert.deepEqual(
      {
        ...w.db
          .prepare("SELECT sourceRevision, basis FROM task_handback_text")
          .get(),
      },
      { sourceRevision: 2, basis: "upgrade" },
    );
    assert.equal(w.store.changedSinceHandback(w.taskId), false);
    w.edit("C", "Body C");
    assert.equal(w.store.changedSinceHandback(w.taskId), true);
    // Migrating again keeps the anchor.
    w.domain.migrate();
    assert.equal(w.store.changedSinceHandback(w.taskId), true);
  } finally {
    w.db.close();
  }
});

test("the lead task section carries the full text and a diff only when it changed", () => {
  const a = { title: "Title", outcome: "One\nTwo\nThree" };
  assert.equal(
    leadTaskSection(a, undefined),
    "Task: Title\nOutcome: One\nTwo\nThree",
  );
  assert.equal(leadTaskSection(a, { ...a }), leadTaskSection(a, undefined));
  const b = { title: "Retitled", outcome: "One\nTwo, revised\nThree\n" };
  const section = leadTaskSection(b, a);
  assert.ok(
    section.startsWith("Task: Retitled\nOutcome: One\nTwo, revised\nThree\n"),
  );
  assert.deepEqual(issueTextDiff(a, b), [
    "Title:",
    "- Title",
    "+ Retitled",
    "Outcome:",
    "- Two",
    "+ Two, revised",
    "+ ",
  ]);
  assert.ok(section.endsWith(issueTextDiff(a, b).join("\n")));
  // Only the outcome changed: no title heading.
  assert.deepEqual(issueTextDiff(a, { ...a, outcome: "One\nThree" }), [
    "Outcome:",
    "- Two",
  ]);
  // Unicode and a moved line.
  assert.deepEqual(
    issueTextDiff(
      { title: "t", outcome: "α\nβ\nγ" },
      { title: "t", outcome: "β\nγ\nα 🚀" },
    ),
    ["Outcome:", "- α", "+ α 🚀"],
  );
});

test("the issue diff is capped by lines and bytes with a visible marker, and a huge middle stays bounded", () => {
  const many = Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n");
  const byLines = issueTextDiff(
    { title: "t", outcome: "" },
    { title: "t", outcome: many },
  );
  assert.equal(byLines.length, issueDiffLineLimit);
  assert.equal(byLines.at(-1), issueDiffTruncated);
  const wide = Array.from(
    { length: 40 },
    (_, i) => `${i} ${"é".repeat(200)}`,
  ).join("\n");
  const byBytes = issueTextDiff(
    { title: "t", outcome: "" },
    { title: "t", outcome: wide },
  );
  assert.equal(byBytes.at(-1), issueDiffTruncated);
  assert.ok(
    Buffer.byteLength(byBytes.join("\n"), "utf8") <= issueDiffByteLimit,
  );
  // A long single line is dropped whole, never cut.
  const long = issueTextDiff(
    { title: "t", outcome: "" },
    { title: "t", outcome: "x".repeat(20_000) },
  );
  assert.deepEqual(long, ["Outcome:", "- ", issueDiffTruncated]);
  // Thousands of distinct lines each side fall back to remove-then-add quickly.
  const before = Array.from({ length: 5000 }, (_, i) => `a${i}`).join("\n"),
    after = Array.from({ length: 5000 }, (_, i) => `b${i}`).join("\n");
  const started = performance.now();
  const bounded = issueTextDiff(
    { title: "t", outcome: before },
    { title: "t", outcome: after },
  );
  assert.ok(performance.now() - started < 1000);
  assert.deepEqual(bounded.slice(0, 3), ["Outcome:", "- a0", "- a1"]);
  assert.equal(bounded.at(-1), issueDiffTruncated);
});
