import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { completedLead, until } from "../fixtures/completed-lead.js";
import { startCliOperator } from "../fixtures/operator-cli.js";

const run = promisify(execFile);
const root = join(import.meta.dirname, "../../..");
const harness = join(
  root,
  "test/operator/cli-journey-qualification/live-journey.mjs",
);

test("the journey runs through the installed binary with exactly two admitted turns", async () => {
  const { stdout } = await run(process.execPath, [harness, "--fixture"], {
    cwd: root,
    maxBuffer: 16 * 1024 * 1024,
    timeout: 240_000,
  });
  const e = JSON.parse(stdout);
  assert.equal(e.failure, null);
  assert.equal(e.install.outsideCheckout, true);
  assert.equal(e.install.testsShipped, false);
  // H1: nothing after the result, nothing under Stop, one turn after adoption, a third refused.
  assert.deepEqual(e.turns.h1, {
    afterResultNoAdmission: true,
    stoppedNoAdmission: true,
    exactlyTwo: true,
    thirdRefusedBeforeRuntime: true,
  });
  assert.equal(e.turns.startTurnCalls, 2);
  assert.ok(e.turns.rejectedStartTurns >= 1);
  const o = e.observations;
  assert.equal(o.searchFoundFailure, true);
  assert.equal(o.turn1ExpectedFail, true);
  assert.equal(o.turn2ExpectedPass, true);
  assert.equal(o.execution1.submittedDigestMatches, true);
  assert.equal(o.execution2.submittedDigestMatches, true);
  assert.equal(o.execution2.phrasePresent, true);
  assert.deepEqual(
    o.execution2.segments.find(
      (s: { name: string }) => s.name === "profile-instructions",
    ).revision,
    2,
  );
  assert.ok(o.execution1.runtimeItems.includes("commandExecution/completed"));
  assert.deepEqual(o.execution1.toolItems, ["cab_report_result"]);
  assert.match(o.prepared.diff.lines.at(-1), /^\+ CLI8_REQUIRED_PHRASE: /);
  assert.equal(o.prepared.diff.lines.length, 2);
  assert.equal(o.prepared.mode, "600");
  assert.equal(o.readOnlyDigestUnchanged, true);
  assert.equal(o.conflictDigestUnchanged, true);
  assert.deepEqual(o.profileApply, {
    version: 2,
    replayedSameReceipt: true,
    replayReused: true,
  });
  assert.deepEqual(
    {
      state: o.lostResponse.operationState,
      sameKey: o.lostResponse.rerunSameKey,
      bumps: o.lostResponse.versionBumps,
    },
    { state: "recorded", sameKey: true, bumps: 1 },
  );
  assert.deepEqual(o.beforeAdoption, { boundIsCurrent: false });
  assert.deepEqual(o.afterAdoption, { boundIsCurrent: true });
  assert.deepEqual(o.logout, {
    serverCredentialAfterLocalLogout: 200,
    afterRevoke: 401,
  });
  const exits = Object.fromEntries(
    e.steps
      .filter((s: { step: string }) =>
        [
          "readonly-denial-cli",
          "readonly-denial-direct",
          "concurrent-conflict",
          "logs-follow-revoke",
        ].includes(s.step),
      )
      .map((s: { step: string; exit: number }) => [s.step, s.exit]),
  );
  assert.deepEqual(exits, {
    "readonly-denial-cli": 3,
    "readonly-denial-direct": 403,
    "concurrent-conflict": 4,
    "logs-follow-revoke": 3,
  });
  assert.ok(
    e.steps.some(
      (s: { step: string; exit: number }) =>
        s.step === "project-apply-lost-response" && s.exit === 6,
    ),
  );
  for (const s of e.steps)
    assert.equal(s.exit, s.expected, `${s.step}: ${s.command}`);
  assert.deepEqual(e.leaks, {
    cliOutputs: false,
    databaseBytes: false,
    evidenceJson: false,
  });
  assert.deepEqual(e.cleanup, {
    credentialsRevoked: true,
    serverCredentialsRevoked: true,
    serviceStopped: true,
    fixtureRemoved: true,
    retainedData: false,
  });
});

test("the harness refuses live or remote execution without explicit flags", async () => {
  for (const args of [
    [],
    ["--live"],
    ["--live", "--max-turns", "3"],
    ["--phase", "remote"],
    [
      "--phase",
      "remote",
      "--data",
      root,
      "--origin",
      "http://x",
      "--port",
      "1",
    ],
    ["--fixture", "--live"],
  ]) {
    const exit = await run(process.execPath, [harness, ...args], {
      cwd: root,
    }).then(
      () => 0,
      (error: { code: number }) => error.code,
    );
    assert.equal(exit, 2, args.join(" "));
  }
});

// #935: adopting corrected instructions on a completed lead keeps it resumable.
test("adopting current instructions on a completed lead keeps the follow-up", async (t) => {
  const o = await startCliOperator(t);
  const { task } = await completedLead(o.s.f, "CLI8 adoption");
  const lead = task.assignmentId;
  const profileId = String(o.d.assignment(lead).profileId);
  o.d.execute({
    type: "profile.configure",
    actor: "operator",
    key: randomUUID(),
    profileId,
    expectedVersion: Number(o.d.profile(profileId).version),
    summary: "Corrected",
  });
  const version = () => String(Number(o.d.assignment(lead).version));
  let r = await o.cli("rw", [
    "assignment",
    "apply-current",
    lead,
    "--expected-version",
    version(),
  ]);
  assert.equal(r.code, 0, r.out);
  assert.equal(
    Number(o.d.assignment(lead).profileRevision),
    Number(o.d.profile(profileId).version),
  );
  r = await o.cli("rw", [
    "task",
    "follow-up",
    task.taskId,
    "--expected-version",
    version(),
    "--message-file",
    o.file("follow-up.md", "Repeat the check."),
  ]);
  assert.equal(r.code, 0, r.out);
  await until(() => o.d.assignment(lead).state === "running", "resumed turn");
  r = await o.cli("ro", ["assignment", "instructions", lead]);
  assert.equal(
    r.json().data.execution.profileRevision,
    Number(o.d.profile(profileId).version),
  );
});
