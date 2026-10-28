import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { canonicalJson } from "../../src/cli/change-document.js";
import { cliGeneration } from "../fixtures/recovery-generations.js";

type Json = Record<string, unknown>;
type World = Awaited<ReturnType<typeof cliGeneration>>;

const journal = (w: World) => {
  const path = join(w.h.configDir, "requests.jsonl");
  return existsSync(path) ? readFileSync(path, "utf8") : "";
};
const posts = (w: World) =>
  w.h.fetches.filter((f) => f.endsWith("/api/operator/commands")).length;
const out = (w: World) => join(w.h.dir, `${randomUUID()}.json`);

async function prepare(
  w: World,
  path: string,
  extra: string[],
  connection: "ro" | "rw" = "ro",
) {
  const file = out(w);
  const r = await w.cli(connection, [
    "recovery",
    "prepare",
    path,
    w.g.assignmentId,
    "--out",
    file,
    ...extra,
  ]);
  return { r, file };
}
const adoptEvidence = (w: World) => w.evidenceFile(w.g.adoptionEvidence());
const work = (w: World) => ["--work", w.g.workId];

/** Rewrites a document with a fresh digest, as a careless editor would. */
function rewrite(file: string, change: (document: Json) => void) {
  const document = JSON.parse(readFileSync(file, "utf8")) as Json;
  change(document);
  const { digest: _d, ...rest } = document;
  const digest = createHash("sha256").update(canonicalJson(rest)).digest("hex");
  writeFileSync(file, JSON.stringify({ ...rest, digest }), { mode: 0o600 });
}

test("prepare writes an exact, owner-only, version-bound document and sends nothing", async (t) => {
  const w = await cliGeneration(t, "no-turn");
  const before = posts(w);
  const { r, file } = await prepare(w, "no-turn-adopt", [
    ...work(w),
    "--evidence-file",
    adoptEvidence(w),
  ]);
  assert.equal(r.code, 0, r.err);
  assert.equal(posts(w), before, "prepare sends no command");
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const document = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(document.schema, "cab.cli.recovery/v1");
  assert.equal(document.path, "no-turn-adopt");
  assert.deepEqual(document.target, {
    scope: `assignment:${w.g.assignmentId}`,
    assignmentId: w.g.assignmentId,
    taskId: w.g.taskId,
    projectId: w.g.projectId,
    workId: w.g.workId,
  });
  assert.equal(document.bound.workRevision, w.g.workRevision);
  assert.equal(document.bound.requestSequence, w.g.requestSequence);
  const { key, ...expected } = w.g.adoption();
  assert.ok(key);
  assert.deepEqual(document.command, {
    type: "recovery.no-turn.adopt",
    assignmentId: w.g.assignmentId,
    ...expected,
  });
  assert.equal(r.json().data.document.digest, document.digest);
  const human = await prepare(w, "no-turn-adopt", [
    ...work(w),
    "--evidence-file",
    adoptEvidence(w),
  ]);
  assert.equal(human.r.code, 0);
  assert.match(
    human.r.out,
    /You assert: completeSynchronousWriteAheadLedger, noStartTurnInvocation, independentlyReviewed, idleThreadMayExist/,
  );
  assert.match(human.r.out, /cannot be undone/);
});

test("missing, false, extra or malformed evidence and confirmation flags never produce a request", async (t) => {
  const w = await cliGeneration(t, "no-turn");
  const evidence = w.g.adoptionEvidence() as {
    evidence: Json;
    attestation: Json;
  };
  const files: Array<[string, string]> = [];
  const add = (name: string, body: Json) =>
    files.push([name, w.evidenceFile(body)]);
  for (const field of Object.keys(evidence.evidence)) {
    const { [field]: _gone, ...rest } = evidence.evidence;
    add(`evidence.${field} absent`, { ...evidence, evidence: rest });
    add(`evidence.${field} malformed`, {
      ...evidence,
      evidence: { ...evidence.evidence, [field]: "x" },
    });
  }
  for (const field of Object.keys(evidence.attestation)) {
    const { [field]: _gone, ...rest } = evidence.attestation;
    add(`attestation.${field} absent`, { ...evidence, attestation: rest });
    add(`attestation.${field} false`, {
      ...evidence,
      attestation: { ...evidence.attestation, [field]: false },
    });
  }
  add("extra key", { ...evidence, note: "trust me" });
  add("rpcError on no-turn", {
    ...evidence,
    rpcError: { code: -32600, message: "x" },
  });
  files.push([
    "wrong schema",
    w.file("wrong.json", JSON.stringify({ schema: "other", ...evidence })),
  ]);
  files.push(["non-JSON", w.file("bad.json", "{")]);
  files.push([
    "oversized",
    w.file(
      "big.json",
      JSON.stringify({ ...evidence, pad: "x".repeat(70 * 1024) }),
    ),
  ]);
  const journalBefore = journal(w),
    postsBefore = posts(w),
    fetchesBefore = w.h.fetches.length;
  for (const [name, file] of files) {
    const { r, file: output } = await prepare(w, "no-turn-adopt", [
      ...work(w),
      "--evidence-file",
      file,
    ]);
    assert.equal(r.code, 2, `${name}: ${r.out}`);
    assert.match(r.json().error.message, /--evidence-file/, name);
    assert.equal(existsSync(output), false, name);
  }
  assert.equal(
    w.h.fetches.length,
    fetchesBefore,
    "rejected before any request",
  );
  // Recovery assertions.
  for (const [name, receipt] of [
    ["termination absent", { effects: "settled", workspace: "preserved" }],
    [
      "effects absent",
      { termination: { kind: "process-exit" }, workspace: "preserved" },
    ],
    [
      "effects unknown",
      {
        termination: { kind: "process-exit" },
        effects: "unknown",
        workspace: "preserved",
      },
    ],
    [
      "workspace absent",
      { termination: { kind: "process-exit" }, effects: "settled" },
    ],
    [
      "workspace discarded",
      {
        termination: { kind: "process-exit" },
        effects: "settled",
        workspace: "discarded",
      },
    ],
  ] as const) {
    const { r, file } = await prepare(w, "no-turn-recover", [
      ...work(w),
      "--evidence-file",
      w.evidenceFile({ receipt }),
    ]);
    assert.equal(r.code, 2, name);
    assert.equal(existsSync(file), false);
  }
  // Pre-turn adoption needs the persisted rpcError.
  const preTurn = await prepare(w, "pre-turn-adopt", [
    ...work(w),
    "--evidence-file",
    w.evidenceFile({ evidence: evidence.evidence, attestation: {} }),
  ]);
  assert.equal(preTurn.r.code, 2);
  for (const flag of ["--yes", "--confirm", "--force", "--attest"]) {
    const { r } = await prepare(w, "no-turn-adopt", [
      ...work(w),
      "--evidence-file",
      adoptEvidence(w),
      flag,
    ]);
    assert.equal(r.code, 2, flag);
  }
  for (const missing of [["--evidence-file", adoptEvidence(w)], work(w)]) {
    const { r } = await prepare(w, "no-turn-adopt", missing);
    assert.equal(r.code, 2);
  }
  const noOut = await w.cli("ro", [
    "recovery",
    "prepare",
    "no-turn-adopt",
    w.g.assignmentId,
    ...work(w),
    "--evidence-file",
    adoptEvidence(w),
  ]);
  assert.equal(noOut.code, 2);
  let replace = await prepare(w, "conversation-replace", [
    "--evidence-file",
    adoptEvidence(w),
    "--expected-version",
    "1",
    "--expected-conversation-revision",
    "1",
  ]);
  assert.equal(replace.r.code, 2);
  replace = await prepare(w, "conversation-replace", [
    "--expected-version",
    "1",
  ]);
  assert.equal(replace.r.code, 2);
  assert.equal(journal(w), journalBefore);
  assert.equal(posts(w), postsBefore);

  // Ineligible paths and unlisted work are refused without a document.
  const ineligible = await prepare(w, "no-turn-recover", [
    ...work(w),
    "--evidence-file",
    w.evidenceFile(w.receiptEvidence),
  ]);
  assert.equal(ineligible.r.code, 4);
  assert.match(ineligible.r.json().error.message, /witness-missing/);
  assert.equal(existsSync(ineligible.file), false);
  const unlisted = await prepare(w, "no-turn-adopt", [
    "--work",
    "assignment:other",
    "--evidence-file",
    adoptEvidence(w),
  ]);
  assert.equal(unlisted.r.code, 2);
  replace = await prepare(w, "conversation-replace", [
    "--expected-version",
    "1",
    "--expected-conversation-revision",
    "1",
  ]);
  assert.equal(replace.r.code, 4);
  assert.match(replace.r.json().error.message, /unresolved-execution/);
});

test("submit sends a document once, replays it exactly and reports what did not happen", async (t) => {
  const w = await cliGeneration(t, "no-turn");
  const adopt = await prepare(w, "no-turn-adopt", [
    ...work(w),
    "--evidence-file",
    adoptEvidence(w),
  ]);
  assert.equal(adopt.r.code, 0, adopt.r.err);
  const refused = await w.cli("ro", [
    "recovery",
    "submit",
    "--file",
    adopt.file,
  ]);
  assert.equal(refused.code, 3);
  let r = await w.cli("rw", ["recovery", "submit", "--file", adopt.file]);
  assert.equal(r.code, 0, r.err);
  let envelope = r.json();
  assert.equal(envelope.data.effect, "saved");
  assert.equal(envelope.data.receipt.kind, "recovery-adoption");
  assert.equal(envelope.data.receipt.witnessId, w.g.witnessId());
  assert.deepEqual(Object.keys(envelope.request).sort(), [
    "key",
    "scope",
    "service",
    "type",
  ]);
  assert.equal(envelope.request.scope, `assignment:${w.g.assignmentId}`);
  assert.equal(envelope.request.type, "recovery.no-turn.adopt");
  const again = await w.cli("rw", ["recovery", "submit", "--file", adopt.file]);
  assert.equal(again.code, 0);
  assert.deepEqual(again.json().data.receipt, envelope.data.receipt);
  assert.equal(again.json().request.key, envelope.request.key);

  // A lost reply is uncertain with full identity; a rerun replays; operation get settles.
  const recover = await prepare(w, "no-turn-recover", [
    ...work(w),
    "--evidence-file",
    w.evidenceFile(w.receiptEvidence),
  ]);
  assert.equal(recover.r.code, 0, recover.r.err);
  r = await w.cli("rw", ["recovery", "submit", "--file", recover.file], {
    fetch: w.lostReply,
  });
  assert.equal(r.code, 6);
  const lost = r.json().error;
  assert.equal(lost.outcome, "unknown");
  assert.equal(lost.request.type, "recovery.no-turn.recover");
  assert.match(lost.message, /cab operation get .* --scope assignment:/);
  const get = await w.cli("ro", [
    "operation",
    "get",
    lost.request.key,
    "--scope",
    lost.request.scope,
    "--type",
    lost.request.type,
  ]);
  assert.equal(get.code, 0, get.err);
  assert.equal(get.json().data.state, "recorded");
  r = await w.cli("rw", ["recovery", "submit", "--file", recover.file]);
  assert.equal(r.code, 0, r.err);
  envelope = r.json();
  assert.equal(envelope.request.key, lost.request.key);
  assert.equal(envelope.data.effect, "completed");
  assert.equal(envelope.data.receipt.state, "reconciled");
  const human = await w.h.run([
    "recovery",
    "submit",
    "--file",
    recover.file,
    "--connection",
    "rw",
  ]);
  assert.match(human.out, /Not resumed; nothing was dispatched/);
  assert.match(human.out, /needs conversation replacement/);
  assert.match(human.out, /cannot be undone/);
  const adoptHuman = await w.h.run([
    "recovery",
    "submit",
    "--file",
    adopt.file,
    "--connection",
    "rw",
  ]);
  assert.match(adoptHuman.out, /Next: recover the generation/);
  assert.doesNotMatch(adoptHuman.out, /needs conversation replacement/);
  assert.equal(
    w.s.f.service.turnRequests().find((x) => x.workId === w.g.workId)?.state,
    "held",
  );

  const replace = await prepare(w, "conversation-replace", [
    "--expected-version",
    "1",
    "--expected-conversation-revision",
    "1",
  ]);
  assert.equal(replace.r.code, 0, replace.r.err);
  r = await w.cli("rw", ["recovery", "submit", "--file", replace.file]);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.json().data.receipt.revision, 2);
  assert.equal(r.json().data.effect, "saved");
  const replaced = await w.h.run([
    "recovery",
    "submit",
    "--file",
    replace.file,
    "--connection",
    "rw",
  ]);
  assert.match(replaced.out, /do not replace it again/);
  assert.match(replaced.out, /new 'cab task message'/);
  assert.doesNotMatch(replaced.out, /needs conversation replacement/);
});

test("refused submissions exit with a conflict and the current blockers; nothing is reused", async (t) => {
  const w = await cliGeneration(t, "no-turn");
  w.s.f.service.adoptHistoricalNoTurnSubmission(w.g.adoption() as never);
  const recover = await prepare(w, "no-turn-recover", [
    ...work(w),
    "--evidence-file",
    w.evidenceFile(w.receiptEvidence),
  ]);
  assert.equal(recover.r.code, 0, recover.r.err);
  w.verifier.set("unknown");
  let r = await w.cli("rw", ["recovery", "submit", "--file", recover.file]);
  assert.equal(r.code, 4);
  const first = r.json().error;
  assert.equal(first.outcome, "not-applied");
  assert.match(first.message, /termination-unknown/);
  assert.match(
    first.message,
    /not a successful recovery; the task is not resumed/,
  );
  w.verifier.set("verified");
  r = await w.cli("rw", ["recovery", "submit", "--file", recover.file]);
  assert.equal(r.code, 0, r.err);
  assert.notEqual(
    r.json().request.key,
    first.request.key,
    "a refused key is not reused",
  );

  // A replacement prepared before another entry point acted is stale.
  const replace = await prepare(w, "conversation-replace", [
    "--expected-version",
    "1",
    "--expected-conversation-revision",
    "1",
  ]);
  assert.equal(replace.r.code, 0, replace.r.err);
  w.s.f.service.replaceConversationCommand({
    key: randomUUID(),
    assignmentId: w.g.assignmentId,
    expectedAssignmentVersion: 1,
    expectedConversationRevision: 1,
  });
  r = await w.cli("rw", ["recovery", "submit", "--file", replace.file]);
  assert.equal(r.code, 4);
});

test("submit refuses altered, unsafe or foreign documents before sending", async (t) => {
  const w = await cliGeneration(t, "no-turn");
  const base = await prepare(w, "no-turn-adopt", [
    ...work(w),
    "--evidence-file",
    adoptEvidence(w),
  ]);
  assert.equal(base.r.code, 0);
  const text = readFileSync(base.file, "utf8");
  const copy = (name: string, body = text, mode = 0o600) => {
    const path = join(w.h.dir, name);
    writeFileSync(path, body, { mode });
    chmodSync(path, mode);
    return path;
  };
  const tampered = copy(
    "tampered.json",
    text.replace(/"workRevision": \d+/, '"workRevision": 99'),
  );
  const readable = copy("readable.json", text, 0o640);
  const big = copy("big.json", " ".repeat(513 * 1024));
  const link = join(w.h.dir, "link.json");
  symlinkSync(base.file, link);
  const foreign = copy("foreign.json");
  rewrite(foreign, (d) => {
    (d.service as Json).installationId = randomUUID();
  });
  const disagree = copy("disagree.json");
  rewrite(disagree, (d) => {
    (d.command as Json).assignmentId = randomUUID();
  });
  const otherPath = copy("other-path.json");
  rewrite(otherPath, (d) => {
    d.path = "pre-turn-adopt";
  });
  const before = posts(w);
  for (const file of [
    tampered,
    readable,
    big,
    link,
    foreign,
    disagree,
    otherPath,
  ]) {
    const r = await w.cli("rw", ["recovery", "submit", "--file", file]);
    assert.equal(r.code, 2, `${file}: ${r.out}`);
  }
  assert.equal(posts(w), before, "nothing was sent");
});
