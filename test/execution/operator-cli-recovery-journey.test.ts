import { boundWorld } from "./bound-turn-recovery-fixture.js";
import { startedOf } from "../fixtures/service-internals.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { assignmentRecoverySchema } from "../../src/operator/contracts.js";
import {
  cliGeneration,
  type GenerationMode,
  NoTurnRuntime,
} from "../fixtures/recovery-generations.js";
import { until } from "../fixtures/until.js";
import { ManualRestartClock } from "../fixtures/restart-clock.js";

type World = Awaited<ReturnType<typeof cliGeneration>>;
const turns = (w: World) =>
  w.runtime instanceof NoTurnRuntime
    ? w.runtime.turnInvocations.length
    : w.runtime.turns;
const requestState = (w: World) =>
  w.s.f.service.turnRequests().find((r) => r.workId === w.g.workId)?.state;

const _sessionRecovery = async (w: World) =>
  assignmentRecoverySchema.parse(
    await (
      await w.s.sessionGet(
        `/api/operator/assignments/${w.g.assignmentId}/recovery`,
      )
    ).json(),
  ).data;

for (const [mode, witnessed] of [
  ["no-turn", false],
  ["pre-turn-defect", false],
  ["no-turn", true],
  ["pre-turn-historical", true],
] as const satisfies readonly (readonly [GenerationMode, boolean])[])
  test(`${mode}${witnessed ? " with an earlier witness" : ""}: inspect, release, then Start again admits work`, async (t) => {
    const w = await cliGeneration(t, mode);
    if (witnessed) w.g.adoptAsBefore();
    const start = turns(w);
    let r = await w.cli("ro", ["recovery", "get", w.g.assignmentId]);
    assert.equal(r.code, 0, r.err);
    const record = r
      .json()
      .data.records.find((x: { workId: string }) => x.workId === w.g.workId);
    assert.deepEqual(
      record.paths.find((p: { path: string }) => p.path === "release"),
      { path: "release", eligible: true, blockedBy: [] },
    );
    r = await w.cli("rw", ["recovery", "release", w.g.assignmentId, "--yes"]);
    assert.equal(r.code, 0, r.err);
    assert.equal(requestState(w), "held", "the refused request stays held");
    assert.equal(turns(w), start, "release dispatches nothing");
    if (w.runtime instanceof NoTurnRuntime) w.runtime.rejectStart = false;
    else {
      w.runtime.resumeError = undefined;
      w.runtime.rejectResume = false;
    }
    r = await w.cli("rw", [
      "task",
      "start-again",
      w.g.taskId,
      "--expected-version",
      String(w.s.f.service.domain().task(w.g.taskId).version),
    ]);
    assert.equal(r.code, 0, r.err + r.out);
    await until(() => turns(w) > start, "Start again admits work");
  });

test("concurrent releases of one generation apply once", async (t) => {
  // Two concurrent releases of one generation apply once.
  const other = await cliGeneration(t, "pre-turn-defect");
  const releases = await Promise.all(
    [0, 1].map(() =>
      other.cli("rw", ["recovery", "release", other.g.assignmentId, "--yes"]),
    ),
  );
  assert.deepEqual(releases.map((x) => x.code).sort(), [0, 4]);
});

for (const harness of ["codex", "claude"] as const)
  test(`${harness}: a released held turn continues its conversation through recovery restart`, async (t) => {
    const clock = new ManualRestartClock();
    const w = await boundWorld(t, harness, [], false, true, {
      mode: "unknown",
      heldTurnRelease: { clock, wallNow: clock.wallNow },
    });
    const c = await w.cli();
    let result = await c.cli("ro", ["recovery", "get", w.g.assignmentId]);
    assert.equal(result.code, 0, result.err);
    assert.equal(result.json().data.restart.eligible, false);
    assert.ok(result.json().data.restart.releasePending);
    const pending = await c.h.run([
      "recovery",
      "get",
      w.g.assignmentId,
      "--connection",
      "ro",
    ]);
    assert.match(pending.out, /Start again: +pending: the service interrupted/);
    result = await c.cli("rw", [
      "recovery",
      "restart",
      w.g.assignmentId,
      "--yes",
    ]);
    assert.equal(result.code, 4, result.err + result.out);
    assert.match(result.json().error.message, /release it by/);
    clock.advance(30 * 60_000);
    await until(
      () => startedOf(w.s.f.service).state.heldTurnReleased(w.g.workId),
      "quiet release",
    );
    const resumed = w.runtime.resumed.length;
    const start = w.runtime.turnInvocations.length;
    w.runtime.complete = true;
    result = await c.cli("rw", [
      "recovery",
      "restart",
      w.g.assignmentId,
      "--yes",
    ]);
    assert.equal(result.code, 0, result.err + result.out);
    assert.equal(result.json().data.receipt.refusedWorkId, w.g.workId);
    await until(
      () => w.runtime.turnInvocations.length > start,
      "Start again admits work",
    );
    assert.deepEqual(w.runtime.resumed.slice(resumed), [w.g.threadId]);
  });
