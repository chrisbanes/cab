import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { cliGeneration } from "../fixtures/recovery-generations.js";

type World = Awaited<ReturnType<typeof cliGeneration>>;

const journal = (w: World) => {
  const path = join(w.h.configDir, "requests.jsonl");
  return existsSync(path) ? readFileSync(path, "utf8") : "";
};
const posts = (w: World) =>
  w.h.fetches.filter((f) => f.endsWith("/api/operator/commands")).length;

const release = (w: World, ...extra: string[]) => [
  "recovery",
  "release",
  w.g.assignmentId,
  ...extra,
];

test("recovery release reads eligibility without --yes, then releases once and replays", async (t) => {
  const w = await cliGeneration(t, "pre-turn-defect");
  const postsBefore = posts(w),
    journalBefore = journal(w);
  let r = await w.cli("ro", release(w));
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(r.json().data, {
    ...r.json().data,
    workId: w.g.workId,
    eligible: true,
    blockedBy: [],
  });
  const read = await w.h.run([...release(w), "--connection", "ro"]);
  assert.match(read.out, /no thread or turn was saved/);
  assert.match(read.out, /Held reason \(evidence only\): .*invalid_value/s);
  assert.match(read.out, /Eligible\. Release with: .*--yes/);
  assert.match(read.out, /Nothing was written/);
  assert.equal(posts(w), postsBefore, "nothing sent without --yes");
  assert.equal(journal(w), journalBefore);
  assert.equal(
    w.s.f.service.startAgainAvailability(w.g.taskId).available,
    false,
  );
  // A read-only connection cannot release.
  assert.equal((await w.cli("ro", release(w, "--yes"))).code, 3);

  const key = randomUUID();
  r = await w.cli("rw", release(w, "--yes", "--request-id", key));
  assert.equal(r.code, 0, r.err + r.out);
  const envelope = r.json();
  assert.equal(envelope.request.type, "recovery.release");
  assert.equal(envelope.request.scope, `assignment:${w.g.assignmentId}`);
  assert.equal(envelope.data.effect, "completed");
  assert.equal(envelope.data.receipt.kind, "recovery-release");
  assert.equal(envelope.data.receipt.workId, w.g.workId);
  assert.deepEqual(w.s.f.service.startAgainAvailability(w.g.taskId), {
    available: true,
    assignmentId: w.g.assignmentId,
    workId: w.g.workId,
  });
  // The same request ID replays the recorded receipt.
  r = await w.cli("rw", release(w, "--yes", "--request-id", key));
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(r.json().data.receipt, envelope.data.receipt);
  // An identical rerun replays too; a new request finds it released.
  r = await w.cli("rw", release(w, "--yes"));
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(r.json().data.receipt, envelope.data.receipt);
  r = await w.cli("rw", release(w, "--yes", "--request-id", randomUUID()));
  assert.equal(r.code, 4);
  assert.match(r.json().error.message, /ownership-released/);
  r = await w.cli("ro", release(w));
  assert.equal(r.code, 0);
  assert.deepEqual(r.json().data.blockedBy, ["ownership-released"]);
  assert.equal(
    (await w.cli("ro", release(w, "--work", "assignment:other"))).code,
    2,
  );
});

test("recovery release settles a lost reply and refuses a generation changed after its read", async (t) => {
  const w = await cliGeneration(t, "no-turn");
  const key = randomUUID();
  let r = await w.cli("rw", release(w, "--yes", "--request-id", key), {
    fetch: w.lostReply,
  });
  assert.equal(r.code, 6, r.err + r.out);
  const lost = r.json().error;
  assert.equal(lost.outcome, "unknown");
  assert.equal(lost.request.type, "recovery.release");
  r = await w.cli("rw", release(w, "--yes", "--request-id", key));
  assert.equal(r.code, 0, r.err);
  assert.equal(r.json().data.receipt.kind, "recovery-release");

  // A Stop recorded between the read and the send is caught by the service's recheck.
  const stopped = await cliGeneration(t, "pre-turn-defect");
  const stopFirst: typeof fetch = async (input, init) => {
    if (String(input).endsWith("/api/operator/commands"))
      await stopped.s.f.service.controlTask({
        type: "task.stop",
        key: randomUUID(),
        taskId: stopped.g.taskId,
      });
    return fetch(input, init);
  };
  r = await stopped.cli("rw", release(stopped, "--yes"), { fetch: stopFirst });
  assert.equal(r.code, 4, r.err + r.out);
  assert.equal(r.json().error.outcome, "not-applied");
  assert.match(r.json().error.message, /independent-hold/);
  assert.equal(
    stopped.s.f.service.startAgainAvailability(stopped.g.taskId).available,
    false,
  );
});

const restart = (w: World, ...extra: string[]) => [
  "recovery",
  "restart",
  w.g.assignmentId,
  ...extra,
];

test("recovery restart previews without --yes, then sends Start again once and replays", async (t) => {
  const w = await cliGeneration(t, "pre-turn-defect");
  // Not released yet: refused with the reason, nothing sent.
  let r = await w.cli("rw", restart(w, "--yes"));
  assert.equal(r.code, 4, r.err + r.out);
  assert.match(r.json().error.message, /submission-interrupted/);
  w.s.f.service.releaseUnboundHold({
    key: randomUUID(),
    assignmentId: w.g.assignmentId,
    workId: w.g.workId,
    workRevision: w.g.workRevision,
    requestSequence: w.g.requestSequence,
  });
  const postsBefore = posts(w),
    journalBefore = journal(w);
  const preview = await w.h.run([...restart(w), "--connection", "ro"]);
  assert.equal(preview.code, 0, preview.err);
  assert.match(preview.out, /Confirm with: cab recovery restart .* --yes/);
  assert.match(preview.out, /Nothing was sent/);
  assert.equal(posts(w), postsBefore, "nothing sent without --yes");
  assert.equal(journal(w), journalBefore);
  // A read-only connection cannot start again.
  assert.equal((await w.cli("ro", restart(w, "--yes"))).code, 3);

  const key = randomUUID();
  r = await w.cli("rw", restart(w, "--yes", "--request-id", key));
  assert.equal(r.code, 0, r.err + r.out);
  const envelope = r.json();
  assert.equal(envelope.request.type, "task.start-again");
  assert.equal(envelope.data.effect, "queued");
  assert.equal(envelope.data.receipt.kind, "start-again");
  assert.equal(envelope.data.receipt.refusedWorkId, w.g.workId);
  // The same request ID and work replay the recorded receipt.
  r = await w.cli(
    "rw",
    restart(w, "--yes", "--work", w.g.workId, "--request-id", key),
  );
  assert.equal(r.code, 0, r.err + r.out);
  assert.deepEqual(r.json().data.receipt, envelope.data.receipt);
});
