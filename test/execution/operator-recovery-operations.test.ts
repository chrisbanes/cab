import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { servedGeneration } from "../fixtures/recovery-generations.js";

type Json = Record<string, unknown>;

test("every recovery receipt reads back exactly, only under its own type and assignment", async (t) => {
  const { s, g } = await servedGeneration(t, "no-turn");
  const ro = (await s.issue("read", "operations-ro")).token;
  const rw = (await s.issue("read-write", "operations-rw")).token;
  const scope = `assignment:${g.assignmentId}`;
  const read = async (
    type: string,
    key: string,
    scopeValue = scope,
    session = false,
  ) => {
    const query = new URLSearchParams({ scope: scopeValue, type, key });
    const path = `/api/operator/operations?${query}`;
    const r = session ? await s.sessionGet(path) : await s.bearer(ro, path);
    return { status: r.status, body: (await r.json()) as Json };
  };
  const post = async (body: Json) => {
    const r = await s.bearer(rw, "/api/operator/commands", {
      method: "POST",
      body,
    });
    assert.equal(r.status, 200);
    return (await r.json()) as Json;
  };
  const adopt = {
    type: "recovery.no-turn.adopt",
    assignmentId: g.assignmentId,
    ...g.adoption(),
  };
  assert.deepEqual((await read(adopt.type, adopt.key)).body.data, {
    state: "not-recorded",
  });
  const receipts: Array<[string, string, Json]> = [];
  receipts.push([adopt.type, adopt.key, await post(adopt)]);
  const recover = {
    type: "recovery.no-turn.recover",
    assignmentId: g.assignmentId,
    ...g.recovery(),
  };
  receipts.push([recover.type, recover.key, await post(recover)]);
  const replace = {
    type: "recovery.conversation.replace",
    key: randomUUID(),
    assignmentId: g.assignmentId,
    expectedAssignmentVersion: 1,
    expectedConversationRevision: 1,
  };
  receipts.push([replace.type, replace.key, await post(replace)]);
  for (const [type, key, receipt] of receipts)
    for (const session of [false, true]) {
      const r = await read(type, key, scope, session);
      assert.equal(r.status, 200);
      assert.deepEqual(r.body.data, { state: "recorded", receipt }, type);
    }
  // Another recovery type, another assignment or another scope kind never selects it.
  for (const [type, key] of [
    ["recovery.pre-turn.adopt", adopt.key],
    ["recovery.no-turn.recover", adopt.key],
    ["recovery.conversation.replace", recover.key],
  ] as const)
    assert.deepEqual((await read(type, key)).body.data, {
      state: "not-recorded",
    });
  assert.deepEqual(
    (await read(adopt.type, adopt.key, `assignment:${randomUUID()}`)).body.data,
    { state: "not-recorded" },
  );
  for (const [type, scopeValue] of [
    [adopt.type, `project:${g.projectId}`],
    ["profile.create", scope],
    [adopt.type, "assignment:not-a-uuid"],
  ] as const)
    assert.equal((await read(type, adopt.key, scopeValue)).status, 400);
  const base = `/api/operator/operations?scope=${scope}&type=${adopt.type}&key=${adopt.key}`;
  for (const path of [`${base}&key=${adopt.key}`, `${base}&extra=1`])
    assert.equal((await s.bearer(ro, path)).status, 400);
  assert.equal((await fetch(`${s.origin}${base}`)).status, 401);
  // A stored row of another shape is a conflict, not a receipt.
  s.f.seedPersistedState((db) => {
    db.prepare(
      "UPDATE execution_pre_turn_commands SET result = ? WHERE commandKey = ?",
    ).run(
      JSON.stringify({ workId: g.workId, witnessId: "not-a-uuid" }),
      adopt.key,
    );
  });
  assert.equal((await read(adopt.type, adopt.key)).status, 409);
  // Invalid persisted rows are conflicts, never 500 or a hidden `not-recorded`.
  for (const [type, key, column, value] of [
    [replace.type, replace.key, "payloadMaterial", "null"],
    [replace.type, replace.key, "payloadMaterial", '{"assignmentId":1}'],
    [replace.type, replace.key, "result", "null"],
    [
      recover.type,
      recover.key,
      "result",
      JSON.stringify({ id: randomUUID(), workId: 5, state: "reconciled" }),
    ],
    [recover.type, recover.key, "result", "{"],
  ] as const) {
    let previous = "";
    s.f.seedPersistedState((db) => {
      previous = String(
        (
          db
            .prepare(
              `SELECT ${column} AS v FROM execution_pre_turn_commands WHERE commandKey = ?`,
            )
            .get(key) as { v: string }
        ).v,
      );
      db.prepare(
        `UPDATE execution_pre_turn_commands SET ${column} = ? WHERE commandKey = ?`,
      ).run(value, key);
    });
    assert.equal((await read(type, key)).status, 409, `${column} ${value}`);
    s.f.seedPersistedState((db) => {
      db.prepare(
        `UPDATE execution_pre_turn_commands SET ${column} = ? WHERE commandKey = ?`,
      ).run(previous, key);
    });
    assert.equal((await read(type, key)).status, 200, "restored");
  }
});
