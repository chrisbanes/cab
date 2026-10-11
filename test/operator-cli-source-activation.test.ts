import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { databaseDigest } from "./fixtures/database-digest.js";
import { startCliOperator } from "./fixtures/operator-cli.js";
import {
  seedImportedConflict,
  seedSettingsWorld,
} from "./fixtures/operator-settings.js";

// biome-ignore lint/suspicious/noExplicitAny: parsed CLI envelopes are asserted structurally
type Json = Record<string, any>;

async function world(t: Parameters<typeof startCliOperator>[0]) {
  const reader = {
    mode: "complete" as "complete" | "incomplete" | "throw",
    reads: 0,
  };
  const o = await startCliOperator(t, {
    previewReader: () => ({
      async readSelection() {
        reader.reads++;
        if (reader.mode === "throw") throw new Error("provider unavailable");
        return reader.mode === "complete"
          ? { complete: true, issues: [], reason: null }
          : { complete: false, issues: [], reason: "rate-limited" };
      },
    }),
  });
  const ids = await seedSettingsWorld(o.s.f);
  const config = async (projectId = ids.atlas) =>
    (
      (await (
        await o.s.sessionGet(
          `/api/operator/projects/${projectId}/configuration`,
        )
      ).json()) as Json
    ).data;
  const ok = async (connection: "ro" | "rw", args: string[], extra = {}) => {
    const r = await o.cli(connection, args, extra);
    assert.equal(r.code, 0, `${args.join(" ")}: ${r.err}${r.out}`);
    return r.json() as Json;
  };
  return { ...o, ids, config, ok, reader };
}

test("preview-source activates after a complete read and reports the live state", async (t) => {
  const w = await world(t);
  const atlas = w.ids.atlas;
  const version = (await w.config()).source.version as number;
  const preview = (selection: string, v = version) => [
    "project",
    "preview-source",
    atlas,
    "--selection",
    selection,
    "--expected-version",
    String(v),
  ];
  const before = databaseDigest(w.s.f);
  const denied = await w.cli("ro", preview("S-1"));
  assert.equal(denied.code, 3, denied.out);
  assert.equal(databaseDigest(w.s.f), before);
  assert.equal(w.reader.reads, 0);

  const first = await w.ok("rw", preview("S-1"));
  assert.deepEqual(first.data.receipt.result, {
    commandType: "github.preview",
    resourceId: atlas,
    selectionId: "S-1",
    configVersion: version,
    active: true,
  });
  assert.equal(first.data.current.active, true);
  assert.equal(first.data.current.observation.state, "never");
  const human = await w.h.run([...preview("S-1"), "--connection", "rw"]);
  assert.match(human.out, /imports no tasks and does not prove a sync/);
  assert.match(human.out, /observation never/);
  assert.deepEqual(
    (await w.config()).source.selections.map((s: Json) => s.active),
    [true, false, false],
  );
  assert.equal(w.reader.reads, 1, "an identical rerun replays the receipt");

  // Advisory gates send nothing.
  for (const [code, args] of [
    [4, preview("S-2", version + 1)],
    [2, preview("S-9")],
  ] as const) {
    const r = await w.cli("rw", args);
    assert.equal(r.code, code, r.out);
  }
  const noCredential = w.ids.fieldnotes;
  const configured = await w.s.sessionPost("/api/operator/commands", {
    type: "github.configure",
    key: randomUUID(),
    projectId: noCredential,
    expectedVersion: (await w.config(noCredential)).source.version,
    selections: [{ id: "S-1", kind: "search", query: "q" }],
    readiness: { mode: "all", conditions: [{ kind: "label", name: "ready" }] },
    repositories: [],
  });
  assert.equal(configured.status, 200);
  const unconfigured = await w.cli("rw", [
    "project",
    "preview-source",
    noCredential,
    "--selection",
    "S-1",
    "--expected-version",
    String((await w.config(noCredential)).source.version),
  ]);
  assert.equal(unconfigured.code, 4, unconfigured.out);
  assert.equal(w.reader.reads, 1);

  // An incomplete read activates nothing; a failed read is an unknown outcome.
  w.reader.mode = "incomplete";
  const incomplete = await w.cli("rw", preview("S-2"));
  assert.equal(incomplete.code, 4, incomplete.out);
  assert.match(incomplete.json().error.message, /Not activated/);
  w.reader.mode = "throw";
  const failed = await w.cli("rw", preview("S-3"));
  assert.equal(failed.code, 6, failed.out);
  assert.equal(failed.json().error.request.type, "github.preview");
  assert.deepEqual(
    (await w.config()).source.selections.map((s: Json) => s.active),
    [true, false, false],
  );

  // A later save deactivates; rerunning the old preview replays it and says so.
  w.reader.mode = "complete";
  const reads = w.reader.reads;
  const saved = await w.s.sessionPost("/api/operator/commands", {
    type: "github.configure",
    key: randomUUID(),
    projectId: atlas,
    expectedVersion: version,
    selections: ["S-1", "S-2", "S-3"].map((id) => ({ id, keep: true })),
    readiness: (await w.config()).source.readiness,
    repositories: [{ repositoryId: "acme/atlas", ref: "main" }],
  });
  assert.equal(saved.status, 200);
  const replay = await w.ok("rw", preview("S-1"));
  assert.equal(replay.request.key, first.request.key);
  assert.deepEqual(replay.data.receipt, first.data.receipt);
  assert.equal(replay.data.current.active, false);
  assert.equal(replay.data.current.version, version + 1);
  const replayText = await w.h.run([...preview("S-1"), "--connection", "rw"]);
  assert.match(replayText.out, /S-1 is NOT active/);
  assert.match(replayText.out, new RegExp(`--expected-version ${version + 1}`));
  assert.equal(w.reader.reads, reads);

  // A lost reply survives a restart and the rerun records once.
  const lost = await w.cli("rw", preview("S-3", version + 1), {
    fetch: w.lostReply,
  });
  assert.equal(lost.code, 6, lost.out);
  assert.match(lost.json().error.message, /operation get/);
  await w.s.restart();
  const settled = await w.ok("rw", preview("S-3", version + 1));
  assert.equal(settled.request.key, lost.json().error.request.key);
  assert.equal(settled.data.current.active, true);
  assert.equal(w.reader.reads, reads + 1);
  const read = await w.ok("rw", [
    "operation",
    "get",
    settled.request.key,
    "--scope",
    `project:${atlas}`,
    "--type",
    "github.preview",
  ]);
  assert.deepEqual(read.data.receipt, settled.data.receipt);
});

test("place-task chooses a matching project once, with the domain's placement rules", async (t) => {
  const w = await world(t);
  const { atlas, relay, fieldnotes } = w.ids;
  const tasks = [randomUUID(), randomUUID(), randomUUID()];
  for (const [i, taskId] of tasks.entries())
    seedImportedConflict(w.s.f, taskId, [atlas, relay], `I_PLACE_${i}`, i + 1);
  const [otherTask = "", plainTask = "", assignedTask = ""] = tasks;
  w.d.execute({
    type: "assignment.create",
    actor: "operator",
    key: randomUUID(),
    projectId: atlas,
    taskId: assignedTask,
    assignmentId: randomUUID(),
    profileId: w.ids.profiles.Mira as string,
    brief: "Work",
    resultDestination: "operator",
    requesterAssignmentId: null,
  });
  const sources = await w.ok("ro", ["project", "sources", atlas]);
  const placement = sources.data.placements.find(
    (p: Json) => p.taskId === plainTask,
  );
  assert.deepEqual(
    placement.choices.map((c: Json) => c.id).sort(),
    [atlas, relay].sort(),
  );
  const version = (taskId: string) =>
    Number(w.s.f.service.domain().task(taskId).version);
  const place = (taskId: string, to: string, v = version(taskId)) => [
    "project",
    "place-task",
    taskId,
    "--to",
    to,
    "--expected-version",
    String(v),
  ];
  const before = databaseDigest(w.s.f);
  assert.equal((await w.cli("ro", place(plainTask, relay))).code, 3);
  for (const args of [
    place(plainTask, relay, version(plainTask) + 1),
    place(plainTask, fieldnotes),
    place(w.s.taskId, relay),
    place(assignedTask, relay),
  ]) {
    const r = await w.cli("rw", args);
    assert.equal(r.code, 4, `${args.join(" ")}: ${r.out}`);
  }
  assert.equal(databaseDigest(w.s.f), before);
  // The service refuses direct HTTP the same way.
  const direct = await w.s.sessionPost("/api/operator/commands", {
    type: "github.place",
    key: randomUUID(),
    projectId: atlas,
    taskId: plainTask,
    chosenProjectId: relay,
    expectedVersion: version(plainTask) + 1,
  });
  assert.equal(direct.status, 409);

  const placed = await w.ok("rw", place(plainTask, relay));
  assert.equal(placed.data.receipt.result.commandType, "github.place");
  assert.equal(placed.data.receipt.result.resourceId, plainTask);
  assert.equal(w.s.f.service.domain().task(plainTask).projectId, relay);
  const human = await w.h.run([
    ...place(otherTask, relay),
    "--connection",
    "rw",
    "--request-id",
    randomUUID(),
  ]);
  assert.match(human.out, /neither starts work nor grants repository access/);
  assert.ok(
    !(await w.ok("ro", ["project", "sources", atlas])).data.placements.some(
      (p: Json) => p.taskId === plainTask,
    ),
  );

  // A lost reply is reconciled by rerunning under the same key.
  const third = randomUUID();
  seedImportedConflict(w.s.f, third, [atlas, relay], "I_PLACE_LOST", 9);
  const v = version(third);
  const lost = await w.cli("rw", place(third, relay, v), {
    fetch: w.lostReply,
  });
  assert.equal(lost.code, 6, lost.out);
  assert.match(lost.json().error.message, /--request-id/);
  assert.doesNotMatch(lost.json().error.message, /operation get/);
  assert.equal(
    w.s.f.service.domain().task(third).projectId,
    relay,
    "the lost attempt applied",
  );
  await w.s.restart();
  const applied = version(third);
  const rerun = await w.ok("rw", place(third, relay, v));
  assert.equal(rerun.request.key, lost.json().error.request.key);
  assert.equal(rerun.data.receipt, null);
  assert.equal(rerun.data.current.projectId, relay);
  assert.equal(version(third), applied, "placed once");
});
