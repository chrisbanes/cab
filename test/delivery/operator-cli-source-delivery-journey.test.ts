import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { test } from "node:test";
import { databaseDigest } from "../fixtures/database-digest.js";
import { deliveryWorld } from "../fixtures/operator-cli.js";
import { seedImportedConflict } from "../fixtures/operator-settings.js";

process.env.SYNTHETIC_SOURCE = "test-only-source-token";

// biome-ignore lint/suspicious/noExplicitAny: parsed CLI envelopes are asserted structurally
type Json = Record<string, any>;

test("sources and delivery journey through the CLI, read back as the operator UI renders it", async (t) => {
  const w = await deliveryWorld(t, "approval");
  const d = () => w.f.service.domain();
  const projectId = w.f.projectId,
    taskId = w.f.taskId;
  const session = async (path: string) =>
    ((await (await w.s.sessionGet(path)).json()) as Json).data;
  const configuration = () =>
    session(`/api/operator/projects/${projectId}/configuration`);

  // Delivery: inspect, refresh, then review, confirm and send one comment.
  await w.f.register();
  const inspected = await w.ok("ro", ["delivery", "get", taskId]);
  assert.deepEqual(
    inspected.data.delivery,
    (await session(`/api/operator/tasks/${taskId}`)).delivery,
  );
  const refreshed = await w.ok("rw", ["delivery", "refresh", taskId]);
  assert.equal(refreshed.data.outcome, "complete");
  const version = String((await w.task()).task.version);
  const body = w.file("comment.txt", "Delivered in the release PR.");
  const review = (
    await w.ok("rw", [
      "delivery",
      "review-comment",
      taskId,
      "--body-file",
      body,
      "--expected-task-version",
      version,
    ])
  ).data.receipt;
  await w.ok("rw", [
    "delivery",
    "confirm-comment",
    taskId,
    "--review-id",
    review.reviewId,
    "--expected-revision",
    String(review.revision),
    "--material-hash",
    review.materialHash,
    "--decision",
    "approved",
  ]);
  const sent = await w.ok("rw", [
    "delivery",
    "send-comment",
    taskId,
    "--body-file",
    body,
    "--expected-task-version",
    version,
    "--review-id",
    review.reviewId,
  ]);
  assert.equal(sent.data.receipt.state, "confirmed-success");
  assert.equal(w.scripted.commentWrites, 1);
  assert.equal(
    (await session(`/api/operator/tasks/${taskId}`)).delivery.actions.find(
      (a: Json) => a.operationId === review.reviewId,
    ).state,
    "confirmed-success",
  );

  // One UUID as the key of a review, a project and a task never selects another's receipt.
  const shared = randomUUID();
  const byReview = await w.ok("rw", [
    "delivery",
    "review-comment",
    taskId,
    "--body-file",
    w.file("shared.txt", "Shared key"),
    "--expected-task-version",
    String((await w.task()).task.version),
    "--request-id",
    shared,
  ]);
  // Configure: review the diff, apply, and see every selection inactive until previewed.
  const document = join(w.h.dir, "source.json");
  const prepared = await w.ok("ro", [
    "project",
    "prepare-source",
    projectId,
    "--out",
    document,
    "--edit-file",
    w.file(
      "edit.json",
      JSON.stringify({ addSelections: [{ kind: "search", query: "is:open" }] }),
    ),
  ]);
  assert.deepEqual(prepared.data.document.preview.diff.lines, [
    "+ S-1 · Search (query private) · added inactive",
  ]);
  const applied = await w.ok("rw", ["project", "apply", "--file", document]);
  const saved = await configuration();
  assert.equal(saved.source.version, applied.data.receipt.result.version);
  assert.deepEqual(
    saved.source.selections.map((s: Json) => [s.id, s.active]),
    [
      ["repo", false],
      ["S-1", false],
    ],
  );
  const activated = await w.ok("rw", [
    "project",
    "preview-source",
    projectId,
    "--selection",
    "repo",
    "--expected-version",
    String(saved.source.version),
  ]);
  assert.equal(activated.data.current.active, true);
  const activatedConfiguration = await configuration();
  assert.equal(activatedConfiguration.source.selections[0].active, true);
  const clearCredential = await w.s.sessionPost("/api/operator/commands", {
    type: "github.configure",
    key: randomUUID(),
    projectId,
    expectedVersion: activatedConfiguration.source.version,
    credentialRef: null,
    selections: activatedConfiguration.source.selections.map(
      (selection: Json) => ({
        id: selection.id,
        keep: true,
      }),
    ),
    // The read's view, back as the command value that keeps it.
    readiness:
      saved.source.readiness.kind === "rule"
        ? {
            mode: saved.source.readiness.mode,
            conditions: saved.source.readiness.conditions,
          }
        : null,
    repositories: saved.source.repositories,
  });
  assert.equal(clearCredential.status, 200);
  const cleared = await configuration();
  const blocked = await w.cli("rw", [
    "project",
    "preview-source",
    projectId,
    "--selection",
    "repo",
    "--expected-version",
    String(cleared.source.version),
  ]);
  assert.equal(blocked.code, 4, blocked.out);
  assert.match(
    blocked.json().error.message,
    /GitHub source credential required.*GitHub source settings/,
  );
  assert.equal((await configuration()).source.selections[0].active, false);
  const observations = await session("/api/operator/source-observations");
  const sources = await w.ok("ro", ["project", "sources", projectId]);
  assert.deepEqual(
    sources.data.observations,
    observations.projects.find((p: Json) => p.projectId === projectId)
      .selections,
  );

  // Place a conflicting task.
  const other = randomUUID(),
    conflicting = randomUUID();
  d().execute({
    type: "project.create",
    actor: "operator",
    key: randomUUID(),
    projectId: other,
    name: "Other",
    leadProfileId: null,
  });
  seedImportedConflict(w.s.f, conflicting, [projectId, other], "I_JOURNEY", 42);
  const placement = (await w.ok("ro", ["project", "sources", projectId])).data
    .placements[0];
  assert.equal(placement.taskId, conflicting);
  await w.ok("rw", [
    "project",
    "place-task",
    conflicting,
    "--to",
    other,
    "--expected-version",
    String(placement.version),
  ]);
  assert.equal(
    (await session(`/api/operator/tasks/${conflicting}`)).task.projectId,
    other,
  );

  const sharedDoc = join(w.h.dir, "shared.json");
  await w.ok("ro", [
    "project",
    "prepare-source",
    projectId,
    "--out",
    sharedDoc,
    "--edit-file",
    w.file("shared-edit.json", JSON.stringify({ removeSelections: ["S-1"] })),
  ]);
  const byProject = await w.ok("rw", [
    "project",
    "apply",
    "--file",
    sharedDoc,
    "--request-id",
    shared,
  ]);
  const byTask = await w.ok("rw", [
    "delivery",
    "refresh",
    taskId,
    "--request-id",
    shared,
  ]);
  assert.deepEqual(
    [byProject, byTask, byReview].map((r) => r.data.receipt.kind),
    ["configuration", "review", "comment-review"],
  );
  // The same key with other content is a conflict, not a replay.
  const otherDoc = join(w.h.dir, "other.json");
  await w.ok("ro", [
    "project",
    "prepare-source",
    projectId,
    "--out",
    otherDoc,
    "--edit-file",
    w.file(
      "other-edit.json",
      JSON.stringify({ addSelections: [{ kind: "search", query: "x" }] }),
    ),
  ]);
  const reused = await w.cli("rw", [
    "project",
    "apply",
    "--file",
    otherDoc,
    "--request-id",
    shared,
  ]);
  assert.equal(reused.code, 4, reused.out);
});

test("every source and delivery write is denied to a read-only credential, by the CLI and by the service", async (t) => {
  const w = await deliveryWorld(t, "allow");
  const read = await w.s.issue("read", "journey-ro");
  const projectId = w.f.projectId,
    taskId = w.f.taskId;
  const document = join(w.h.dir, "denied.json");
  await w.ok("ro", [
    "project",
    "prepare-source",
    projectId,
    "--out",
    document,
    "--edit-file",
    w.file(
      "denied-edit.json",
      JSON.stringify({ addSelections: [{ kind: "search", query: "q" }] }),
    ),
  ]);
  const body = w.file("denied.txt", "Denied");
  const other = randomUUID(),
    placed = randomUUID();
  w.f.service.domain().execute({
    type: "project.create",
    actor: "operator",
    key: randomUUID(),
    projectId: other,
    name: "Other",
    leadProfileId: null,
  });
  seedImportedConflict(w.s.f, placed, [projectId, other], "I_DENIED", 43);
  const sourceVersion = String(
    w.f.service.domain().githubConfiguration(projectId).version,
  );
  const taskVersion = String((await w.task()).task.version);
  const placedVersion = String(w.f.service.domain().task(placed).version);
  const before = databaseDigest(w.s.f);
  const requests = w.scripted.requests.length;
  const uuid = randomUUID();
  for (const args of [
    ["project", "apply", "--file", document],
    [
      "project",
      "preview-source",
      projectId,
      "--selection",
      "repo",
      "--expected-version",
      sourceVersion,
    ],
    [
      "project",
      "place-task",
      placed,
      "--to",
      other,
      "--expected-version",
      placedVersion,
    ],
    ["delivery", "refresh", taskId],
    [
      "delivery",
      "review-comment",
      taskId,
      "--body-file",
      body,
      "--expected-task-version",
      taskVersion,
    ],
    [
      "delivery",
      "confirm-comment",
      taskId,
      "--review-id",
      uuid,
      "--expected-revision",
      "1",
      "--material-hash",
      "a".repeat(64),
      "--decision",
      "approved",
    ],
    [
      "delivery",
      "send-comment",
      taskId,
      "--body-file",
      body,
      "--expected-task-version",
      taskVersion,
    ],
  ]) {
    const r = await w.cli("ro", args);
    assert.equal(r.code, 3, `${args.slice(0, 2).join(" ")}: ${r.out}`);
  }
  for (const command of [
    {
      type: "github.preview",
      projectId,
      selectionId: "repo",
      expectedVersion: 1,
    },
    {
      type: "github.place",
      projectId,
      taskId,
      chosenProjectId: projectId,
      expectedVersion: 1,
    },
    { type: "delivery.refresh", taskId },
    {
      type: "comment.review",
      taskId,
      operationId: uuid,
      expectedTaskVersion: 1,
      body: "x",
    },
    { type: "comment.send", taskId, expectedTaskVersion: 1, body: "x" },
  ]) {
    const r = await w.s.bearer(read.token, "/api/operator/commands", {
      method: "POST",
      body: { key: randomUUID(), ...command },
    });
    assert.equal(r.status, 403, command.type);
    assert.equal(((await r.json()) as Json).error.code, "insufficient-scope");
  }
  assert.equal(databaseDigest(w.s.f), before);
  assert.equal(w.scripted.requests.length, requests);
});
