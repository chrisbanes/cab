import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { databaseDigest } from "../fixtures/database-digest.js";
import {
  deliveryWorld,
  loginCli,
  publicationWorld,
  startCliService,
} from "../fixtures/operator-cli.js";
import { labelAndFieldReady } from "../fixtures/task-publication.js";

// biome-ignore lint/suspicious/noExplicitAny: parsed CLI envelopes are asserted structurally
type Json = Record<string, any>;

test("delivery get shows the PR, actions and comment policy without provider access", async (t) => {
  const w = await deliveryWorld(t);
  await w.f.register();
  w.f.seedPersistedState((db) =>
    db
      .prepare("INSERT INTO delivery_task_branches VALUES (?,?,?,?,?,1)")
      .run(
        w.f.taskId,
        "R1",
        "cab/12345678-fix-it",
        "a".repeat(40),
        "b".repeat(40),
      ),
  );
  const requests = w.scripted.requests.length;
  const before = databaseDigest(w.s.f);
  const json = await w.ok("ro", ["delivery", "get", w.f.taskId]);
  const read = await w.task();
  assert.deepEqual(json.data.delivery, read.delivery);
  assert.deepEqual(json.data.commentPolicy, {
    available: true,
    mode: "allow",
    reason: null,
  });
  assert.equal(json.data.issue.number, 1);
  assert.equal(json.data.delivery.binding.number, 7);
  assert.deepEqual(json.coverage.gaps, []);
  const human = await w.h.run([
    "delivery",
    "get",
    w.f.taskId,
    "--connection",
    "ro",
  ]);
  assert.match(human.out, /Pull request: +org\/repo#7 OPEN/);
  assert.match(human.out, /Comments: +available \(allow\)/);
  assert.match(
    human.out,
    /Branch: +org\/repo cab\/12345678-fix-it pushed a{12}, outside push b{12}/,
  );
  assert.equal(json.data.delivery.branches.length, 1);
  assert.match(human.out, /build +success/);
  assert.equal(databaseDigest(w.s.f), before);
  assert.equal(w.scripted.requests.length, requests);
});

test("delivery get shows what holds the merge, including no required checks", async (t) => {
  const w = await deliveryWorld(t);
  const delivery = w.f.service.delivery();
  w.f.service.domain().execute({
    type: "delivery.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: w.f.projectId,
    expectedVersion: delivery.configuration(w.f.projectId).version,
    mode: "through-merge",
    credentialRef: null,
    grants: delivery.configuration(w.f.projectId).grants,
    requiredChecks: [],
    repositories: [
      { repositoryId: "R1", mergeMethod: "squash", requiredChecks: [] },
    ],
  });
  await w.f.register();
  const json = await w.ok("ro", ["delivery", "get", w.f.taskId]);
  assert.deepEqual(json.data.delivery.binding.mergeBlockers, [
    "no-required-checks",
  ]);
  const human = await w.h.run([
    "delivery",
    "get",
    w.f.taskId,
    "--connection",
    "ro",
  ]);
  assert.match(human.out, /Merge blockers:\n {2}no-required-checks\n/);
});

test("delivery refresh is a receipted write that reports partial outcomes", async (t) => {
  const w = await deliveryWorld(t);
  await w.f.register();
  const before = databaseDigest(w.s.f);
  const requests = w.scripted.requests.length;
  const denied = await w.cli("ro", ["delivery", "refresh", w.f.taskId]);
  assert.equal(denied.code, 3, denied.out);
  assert.equal(databaseDigest(w.s.f), before);
  assert.equal(w.scripted.requests.length, requests);

  const observed = (await w.task()).delivery.binding.observedAt;
  await new Promise((r) => setTimeout(r, 5));
  const refreshed = await w.ok("rw", ["delivery", "refresh", w.f.taskId]);
  assert.deepEqual(refreshed.data.receipt, {
    kind: "review",
    key: refreshed.request.key,
    recorded: true,
    taskId: w.f.taskId,
    operation: "delivery.refresh",
  });
  assert.equal(refreshed.data.outcome, "complete");
  assert.ok(refreshed.data.observedAt.after > observed);
  assert.equal(refreshed.coverage.complete, true);

  // A provider read failure is partial, keeps the old observation and is not "refreshed".
  w.scripted.outage = true;
  const partial = await w.ok("rw", ["delivery", "refresh", w.f.taskId]);
  assert.equal(partial.data.outcome, "partial");
  assert.equal(partial.data.readError, "provider-read-unavailable");
  assert.equal(partial.data.observedAt.after, refreshed.data.observedAt.after);
  assert.ok(partial.coverage.gaps.includes("evidence-gap"));
  const text = await w.h.run([
    "delivery",
    "refresh",
    w.f.taskId,
    "--connection",
    "rw",
  ]);
  assert.equal(text.code, 0);
  assert.match(text.out, /PARTIAL/);
  assert.match(text.out, /installation-wide/);
  w.scripted.outage = false;

  // An uncertain comment is read back once, without a second comment.
  w.scripted.lostComment = true;
  const sent = await w.cli("rw", [
    "delivery",
    "send-comment",
    w.f.taskId,
    "--body-file",
    w.file("lost.txt", "Lost reply comment"),
    "--expected-task-version",
    String((await w.task()).task.version),
  ]);
  assert.equal(sent.code, 6, sent.out);
  assert.match(
    sent.json().error.message,
    /Do not resend with a new --request-id/,
  );
  w.scripted.lostComment = false;

  // A lost reply is unknown; the identical rerun refreshes again.
  const lost = await w.cli("rw", ["delivery", "refresh", w.f.taskId], {
    fetch: w.lostReply,
  });
  assert.equal(lost.code, 6, lost.out);
  assert.doesNotMatch(lost.json().error.message, /operation get/);
  const rerun = await w.ok("rw", ["delivery", "refresh", w.f.taskId]);
  assert.equal(rerun.request.key, lost.json().error.request.key);
});

test("delivery get lists thread reply and resolve actions with their outcomes", async (t) => {
  const w = await deliveryWorld(t);
  w.scripted.thread = {
    resolved: false,
    resolvedBy: null,
    comments: [
      { id: "C1", body: "Please fix", state: "SUBMITTED", author: "U_REV" },
    ],
  };
  w.f.grant(
    { action: "pr.thread.reply", mode: "allow" },
    { action: "pr.thread.resolve", mode: "allow" },
  );
  await w.f.register();
  assert.equal(
    (await w.f.threadAction({ kind: "pr.thread.reply", body: "Fixed" }))
      .success,
    true,
  );
  assert.equal(
    (
      await w.f.threadAction({
        kind: "pr.thread.resolve",
        expectedLatestCommentNodeId: "C1",
      })
    ).success,
    false,
  );
  const json = await w.ok("ro", ["delivery", "get", w.f.taskId]);
  assert.deepEqual(
    json.data.delivery.actions.map((a: Json) => [a.kind, a.state, a.reason]),
    [
      ["pr.thread.reply", "confirmed-success", null],
      ["pr.thread.resolve", "confirmed-failure", "provider-preflight-held"],
    ],
  );
  const human = await w.h.run([
    "delivery",
    "get",
    w.f.taskId,
    "--connection",
    "ro",
  ]);
  assert.match(human.out, /Reply to review threads +confirmed-success/);
  assert.match(
    human.out,
    /Resolve review threads +confirmed-failure +provider-preflight-held/,
  );
});

test("delivery publish reviews, confirms and sends a local task as an issue, and a replay creates nothing more", async (t) => {
  const w = await publicationWorld(t);
  const taskId = w.f.task(true, "Ship it", "Do the work");
  const target = w.f.target(taskId, "repo").id;
  const version = w.f.version(taskId);
  const denied = await w.cli("ro", [
    "delivery",
    "publish-review",
    taskId,
    "--target",
    target,
    "--expected-task-version",
    String(version),
  ]);
  assert.notEqual(denied.code, 0);
  assert.equal(w.f.gh.posts, 0);

  const review = await w.ok("rw", [
    "delivery",
    "publish-review",
    taskId,
    "--target",
    target,
    "--expected-task-version",
    String(version),
  ]);
  const r = review.data.receipt as Json;
  assert.equal(r.kind, "publication-review");
  assert.equal(r.repository, "org/repo");
  assert.equal(r.decision, "pending");
  assert.equal(w.f.gh.posts, 0);
  const human = await w.h.run([
    "delivery",
    "publish-review",
    taskId,
    "--target",
    target,
    "--expected-task-version",
    String(version),
    "--connection",
    "rw",
  ]);
  assert.match(human.out, /Nothing was created on GitHub/);
  assert.match(human.out, /cannot delete or take back/);
  assert.match(human.out, /delivery publish-confirm/);

  const confirmArgs = [
    "delivery",
    "publish-confirm",
    taskId,
    "--review-id",
    r.reviewId,
    "--expected-revision",
    String(r.revision),
    "--material-hash",
    r.materialHash,
    "--decision",
    "approved",
  ];
  const confirmed = await w.ok("rw", confirmArgs);
  assert.equal(confirmed.data.receipt.decision, "approved");

  const sendArgs = [
    "delivery",
    "publish-send",
    taskId,
    "--review-id",
    r.reviewId,
    "--expected-task-version",
    String(version),
    "--request-id",
    "11111111-1111-4111-8111-111111111111",
  ];
  const sent = await w.ok("rw", sendArgs);
  assert.equal(sent.data.receipt.kind, "publication");
  assert.equal(sent.data.state, "converted");
  assert.equal(sent.data.issueNumber, 1);
  assert.equal(w.f.gh.posts, 1);
  // The same request replays the recorded outcome and posts nothing.
  const replay = await w.ok("rw", sendArgs);
  assert.equal(replay.data.state, "converted");
  assert.equal(w.f.gh.posts, 1);
  const read = await w.h.run(["task", "get", taskId, "--connection", "ro"]);
  assert.equal(read.code, 0, read.err);
});

test("delivery publish names the reason a task or target is unavailable and sends nothing", async (t) => {
  const w = await publicationWorld(t, {
    selections: ["repo", "search"],
    grants: ["create"],
  });
  const taskId = w.f.task(false);
  const search = w.f.target(taskId, "search").id;
  const base = [
    "delivery",
    "publish-review",
    taskId,
    "--expected-task-version",
  ];
  const version = String(w.f.version(taskId));
  const disabled = await w.h.run([
    ...base,
    version,
    "--target",
    search,
    "--connection",
    "rw",
  ]);
  assert.notEqual(disabled.code, 0);
  assert.match(disabled.err, /can't tell whether a new issue would match/);
  const missing = await w.h.run([...base, version, "--connection", "rw"]);
  assert.notEqual(missing.code, 0);
  assert.match(missing.err, /Name the target with --target ID/);
  assert.equal(w.f.gh.posts, 0);
});

test("delivery publish-link refuses an issue without the marker, and publish-abandon warns about a duplicate", async (t) => {
  const w = await publicationWorld(t);
  w.f.gh.createMode = "lost-unseen";
  const taskId = w.f.task(false);
  const { review } = await w.f.publish(taskId);
  const stranger = w.f.gh.add("x", "no marker");
  const link = await w.h.run([
    "delivery",
    "publish-link",
    taskId,
    "--publication-id",
    review.publicationId,
    "--issue",
    String(stranger.number),
    "--connection",
    "rw",
  ]);
  assert.notEqual(link.code, 0);
  assert.match(link.err, /does not carry this publication's marker/);
  const abandoned = await w.h.run([
    "delivery",
    "publish-abandon",
    taskId,
    "--publication-id",
    review.publicationId,
    "--connection",
    "rw",
  ]);
  assert.equal(abandoned.code, 0, abandoned.err);
  assert.match(abandoned.out, /may still have created the issue/);
  assert.match(abandoned.out, /State: +abandoned|abandoned/);
  assert.equal(w.f.gh.posts, 1);
});

test("delivery publish-send says a later step is waiting, not that the create is unknown, when only an item add waits for a retry", async (t) => {
  const w = await publicationWorld(t, {
    selections: ["project"],
    readiness: labelAndFieldReady,
  });
  w.f.gh.itemMode = "retry";
  const taskId = w.f.task(true);
  const review = w.f.service.reviewTaskPublication({
    key: randomUUID(),
    taskId,
    targetId: w.f.target(taskId, "project").id,
    expectedTaskVersion: w.f.version(taskId),
  });
  w.f.service.confirmTaskPublication({
    key: randomUUID(),
    taskId,
    reviewId: review.publicationId,
    expectedRevision: review.revision,
    materialHash: review.materialHash,
    decision: "approved",
  });
  const sent = await w.h.run([
    "delivery",
    "publish-send",
    taskId,
    "--review-id",
    review.publicationId,
    "--expected-task-version",
    String(w.f.version(taskId)),
    "--connection",
    "rw",
  ]);
  assert.equal(sent.code, 0, sent.err);
  assert.match(sent.out, /Issue #1 was created/);
  assert.match(sent.out, /Link and Abandon do not apply/);
  assert.doesNotMatch(sent.out, /outcome is not known/);
  assert.doesNotMatch(sent.out, /publish-link|publish-abandon/);
  assert.equal(w.f.gh.posts, 1);
});

type World = Awaited<ReturnType<typeof deliveryWorld>>;
type Pins = { v: number; r: number; p: number; h: string };

/** The four values `delivery settle` checks, as the task read shows them. */
async function pinsOf(w: World): Promise<Pins> {
  const read = await w.task();
  return {
    v: read.task.version,
    r: read.delivery.binding.revision,
    p: read.delivery.policyVersion,
    h: read.delivery.binding.headSha,
  };
}
const pinFlags = (p: Pins) => [
  "--expected-task-version",
  String(p.v),
  "--expected-delivery-revision",
  String(p.r),
  "--expected-policy-version",
  String(p.p),
  "--expected-head-sha",
  p.h,
];
const settleArgs = (w: World, ...rest: string[]) => [
  "delivery",
  "settle",
  w.f.taskId,
  ...rest,
];
const settlementRows = (w: World) => {
  let n = -1;
  w.f.seedPersistedState((db) => {
    n = (
      db
        .prepare("SELECT count(*) AS n FROM delivery_settlement_receipts")
        .get() as { n: number }
    ).n;
  });
  return n;
};
/** A fetch that counts command POSTs, and runs `beforePost` ahead of each. */
function countingFetch(beforePost: () => void = () => {}) {
  const counter = {
    posts: 0,
    fetch: (async (input, init) => {
      if (String(input).endsWith("/api/operator/commands")) {
        counter.posts++;
        beforePost();
      }
      return fetch(input, init);
    }) as typeof fetch,
  };
  return counter;
}

test("delivery settle records the decision once, replays it after the revision moves and refuses a changed request", async (t) => {
  const w = await deliveryWorld(t);
  await w.f.register();
  const before = await pinsOf(w);
  const awaiting = await w.h.run([
    "delivery",
    "get",
    w.f.taskId,
    "--connection",
    "ro",
  ]);
  assert.match(
    awaiting.out,
    new RegExp(
      `Handback: +awaiting settlement for head ${before.h.slice(0, 12)} \\(binding revision ${before.r}\\)`,
    ),
  );

  const first = await w.ok(
    "rw",
    settleArgs(w, "--decision", "accepted", "--request-id", randomUUID()),
  );
  const key = first.request.key as string;
  assert.deepEqual(first.data.receipt, {
    kind: "delivery-settlement",
    key,
    recorded: true,
    taskId: w.f.taskId,
    decision: "accepted",
    revision: before.r + 1,
  });
  assert.deepEqual(first.data.pins, {
    taskVersion: before.v,
    deliveryRevision: before.r,
    policyVersion: before.p,
    headSha: before.h,
  });
  const human = await w.h.run([
    ...settleArgs(w, "--decision", "accepted", ...pinFlags(before)),
    "--request-id",
    key,
    "--connection",
    "rw",
  ]);
  assert.equal(human.code, 0, human.err);
  assert.match(human.out, /does not merge, close or comment/);
  assert.match(human.out, /does not complete the task/);
  assert.match(human.out, /cannot be undone/);
  const accepted = await w.h.run([
    "delivery",
    "get",
    w.f.taskId,
    "--connection",
    "ro",
  ]);
  assert.match(
    accepted.out,
    new RegExp(
      `Handback: +accepted for head ${before.h.slice(0, 12)} \\(binding revision ${before.r + 1}\\)`,
    ),
  );

  // The binding revision has moved; the same request and pins replay the receipt.
  const digest = databaseDigest(w.s.f);
  const replay = await w.ok(
    "rw",
    settleArgs(
      w,
      "--decision",
      "accepted",
      ...pinFlags(before),
      "--request-id",
      key,
    ),
  );
  assert.deepEqual(replay.data.receipt, first.data.receipt);
  assert.equal(replay.data.reusedRequest, true);
  assert.equal(databaseDigest(w.s.f), digest);
  assert.equal(settlementRows(w), 1);
  // The journal also finds the key without --request-id when the pins are the same.
  const journaled = await w.ok(
    "rw",
    settleArgs(w, "--decision", "accepted", ...pinFlags(before)),
  );
  assert.equal(journaled.request.key, key);

  // A pin-less rerun reads the new revision, so it is a new request: refused, nothing sent.
  const wire = countingFetch();
  const again = await w.cli("rw", settleArgs(w, "--decision", "accepted"), {
    fetch: wire.fetch,
  });
  assert.equal(again.code, 4, again.out);
  assert.match(again.json().error.message, /already settled as accepted/);
  assert.equal(wire.posts, 0);
  assert.equal(settlementRows(w), 1);
});

// The service owns each pin's refusal (delivery-operator.test.ts); this shows one surfacing.
test("delivery settle names the current values for a stale pin and records nothing", async (t) => {
  const w = await deliveryWorld(t);
  await w.f.register();
  const now = await pinsOf(w);
  const stale = ["--expected-head-sha", "9".repeat(40)];
  const wire = countingFetch();
  const refused = await w.cli(
    "rw",
    settleArgs(w, "--decision", "accepted", ...stale),
    { fetch: wire.fetch },
  );
  assert.equal(refused.code, 4, refused.out);
  assert.equal(wire.posts, 1);
  const { error } = refused.json();
  assert.equal(error.code, "conflict");
  assert.ok(
    error.message.includes(
      `task version ${now.v}, binding revision ${now.r}, policy version ${now.p}, head ${now.h.slice(0, 12)}`,
    ),
    error.message,
  );
  const human = await w.h.run([
    ...settleArgs(w, "--decision", "accepted", ...stale),
    "--connection",
    "rw",
  ]);
  assert.equal(human.code, 4);
  assert.equal(human.err.match(/^Fix:/gm)?.length, 1, human.err);
  assert.equal(settlementRows(w), 0);
});

// These refusals come from the CLI's own pre-read, before anything is sent.
test("delivery settle refuses accepting a draft, closed or outside-changed PR, asks for a refresh after a failed read, and settling as closed stays possible", async (t) => {
  const w = await deliveryWorld(t);
  await w.f.register();
  const wire = countingFetch();
  const refusal = async (decision: string, change: () => void) => {
    change();
    await w.ok("rw", ["delivery", "refresh", w.f.taskId]);
    const refused = await w.cli("rw", settleArgs(w, "--decision", decision), {
      fetch: wire.fetch,
    });
    assert.equal(refused.code, 4, refused.out);
    return refused.json().error.message as string;
  };
  assert.match(
    await refusal("accepted", () => {
      w.scripted.draft = true;
    }),
    /draft/,
  );
  assert.match(
    await refusal("accepted", () => {
      w.scripted.draft = false;
      w.scripted.closed = true;
    }),
    /closed/,
  );
  assert.match(
    await refusal("accepted", () => {
      w.scripted.closed = false;
      w.f.seedPersistedState((db) =>
        db
          .prepare("INSERT INTO delivery_task_branches VALUES (?,?,?,?,?,1)")
          .run(
            w.f.taskId,
            "R1",
            "cab/12345678-fix-it",
            "a".repeat(40),
            "b".repeat(40),
          ),
      );
    }),
    /outside cab/,
  );
  assert.match(
    await refusal("closed", () => {
      w.scripted.outage = true;
    }),
    /last GitHub read failed/,
  );
  const readHuman = await w.h.run([
    ...settleArgs(w, "--decision", "closed"),
    "--connection",
    "rw",
  ]);
  assert.match(readHuman.err, /Fix: .*delivery refresh/);
  assert.equal(wire.posts, 0);
  assert.equal(settlementRows(w), 0);

  w.scripted.outage = false;
  await w.ok("rw", ["delivery", "refresh", w.f.taskId]);
  const closed = await w.ok("rw", settleArgs(w, "--decision", "closed"));
  assert.equal(closed.data.receipt.decision, "closed");
  assert.match(
    (await w.h.run(["delivery", "get", w.f.taskId, "--connection", "ro"])).out,
    /Handback: +settled as closed/,
  );
});

test("delivery settle keeps the request identity and pins when the reply is lost, and rejects a wrong receipt", async (t) => {
  const w = await deliveryWorld(t);
  await w.f.register();
  const now = await pinsOf(w);
  const lost = await w.cli("rw", settleArgs(w, "--decision", "accepted"), {
    fetch: w.lostReply,
  });
  assert.equal(lost.code, 6, lost.out);
  const message = lost.json().error.message as string;
  const key = lost.json().error.request.key as string;
  assert.ok(message.includes(`--request-id ${key} `), message);
  for (const flag of pinFlags(now)) assert.ok(message.includes(flag), flag);
  assert.doesNotMatch(message, /operation get/);
  // The applied send moved the revision; the printed identity and pins replay it.
  assert.equal(settlementRows(w), 1);
  const rerun = await w.ok(
    "rw",
    settleArgs(
      w,
      "--decision",
      "accepted",
      "--request-id",
      key,
      ...pinFlags(now),
    ),
  );
  assert.equal(rerun.request.key, key);
  assert.equal(rerun.data.receipt.kind, "delivery-settlement");
  assert.equal(settlementRows(w), 1);

  const other = await deliveryWorld(t);
  await other.f.register();
  const wrong: typeof fetch = async (input, init) => {
    const response = await fetch(input, init);
    if (!String(input).endsWith("/api/operator/commands")) return response;
    const body = JSON.parse(String(init?.body));
    return Response.json({
      kind: "review",
      key: body.key,
      recorded: true,
      taskId: other.f.taskId,
      operation: "delivery.refresh",
    });
  };
  const mismatched = await other.cli(
    "rw",
    settleArgs(other, "--decision", "accepted"),
    { fetch: wrong },
  );
  assert.equal(mismatched.code, 6, mismatched.out);
  assert.match(mismatched.json().error.message, /not the expected receipt/);
});

test("delivery settle sends nothing for a read-only credential, bad flags or a task without a reviewable PR", async (t) => {
  const w = await deliveryWorld(t);
  await w.f.register();
  const wire = countingFetch();
  const run = (connection: "ro" | "rw", ...args: string[]) =>
    w.cli(connection, settleArgs(w, ...args), { fetch: wire.fetch });
  assert.equal((await run("ro", "--decision", "accepted")).code, 3);
  assert.equal((await run("rw")).code, 2);
  assert.notEqual((await run("rw", "--decision", "maybe")).code, 0);
  assert.notEqual(
    (await run("rw", "--decision", "closed", "--expected-head-sha", "abc"))
      .code,
    0,
  );
  const local = await deliveryWorld(t, "allow", true);
  const view = await local.ok("ro", ["delivery", "get", local.f.taskId]);
  assert.equal(view.data.issue, null);
  const refused = await local.cli(
    "rw",
    settleArgs(local, "--decision", "closed"),
    { fetch: wire.fetch },
  );
  assert.equal(refused.code, 4, refused.out);
  assert.match(refused.json().error.message, /no reviewable pull request/);
  assert.equal(wire.posts, 0);
  assert.equal(settlementRows(w), 0);
});

/** A project linked to R1 and R2, served to the CLI with a read and a read-write connection. */
async function configureWorld(t: Parameters<typeof startCliService>[0]) {
  const s = await startCliService(t);
  s.f.seedPersistedState((db) =>
    db
      .prepare(
        "UPDATE project_repository_links SET version = 2, links = ? WHERE projectId = ?",
      )
      .run(
        JSON.stringify(
          ["R1", "R2"].map((repositoryId) => ({
            repositoryId,
            path: `/tmp/${repositoryId}`,
            ref: "main",
            gitCommonDirectory: `/tmp/${repositoryId}/.git`,
            codeHost: "github",
            host: "github.com",
          })),
        ),
        s.projectId,
      ),
  );
  const o = await loginCli(t, s);
  const delivery = () => s.f.service.delivery().configuration(s.projectId);
  const doc = () => join(o.h.dir, `${randomUUID()}.json`);
  const journal = () => {
    const path = join(o.h.configDir, "requests.jsonl");
    return existsSync(path)
      ? readFileSync(path, "utf8")
          .trim()
          .split("\n")
          .map((l) => JSON.parse(l) as Json)
      : [];
  };
  return { ...o, s, delivery, doc, journal, project: s.projectId };
}

test("delivery configure refuses bad flags before writing a document", async (t) => {
  const w = await configureWorld(t);
  const out = w.doc();
  const refused = async (code: number, ...args: string[]) => {
    const r = await w.cli("ro", [
      "delivery",
      "configure",
      w.project,
      "--out",
      out,
      ...args,
    ]);
    assert.equal(r.code, code, `${args.join(" ")}: ${r.err}${r.out}`);
    assert.equal(existsSync(out), false, args.join(" "));
  };
  await refused(2, "--repository", "R1", "--level", "everything");
  await refused(2, "--repository", "R1", "--merge-method", "fast-forward");
  // Per-repository flags need a repository, and a repository needs a flag.
  await refused(2, "--level", "open-prs");
  await refused(2, "--repository", "R1");
  await refused(
    2,
    "--repository",
    "R1",
    "--required-check",
    "ci",
    "--required-checks",
    "none",
  );
  await refused(2, "--credential-ref", "gh:example.com");
  await refused(2, "--credential-ref", "GH_TOKEN");
  await refused(2, "--branch-prefix", "x", "--branch-prefix-default");
  await refused(2, "--repository", "R9", "--level", "open-prs");
  await refused(
    2,
    "--repository",
    "R1",
    "--repository",
    "R1",
    "--level",
    "open-prs",
  );
  assert.equal(w.delivery().grants.length, 0);
  assert.deepEqual(w.journal(), []);
});

test("delivery configure prepares the exact delivery.configure, applies once and reads back", async (t) => {
  const w = await configureWorld(t);
  const doc = w.doc();
  const before = w.delivery();
  const prepared = await w.cli("ro", [
    "delivery",
    "configure",
    w.project,
    "--repository",
    "R1",
    "--level",
    "merge-when-ready",
    "--merge-method",
    "squash",
    "--required-check",
    "ci",
    "--credential-ref",
    "gh:github.com",
    "--branch-prefix",
    "cab/",
    "--out",
    doc,
  ]);
  assert.equal(prepared.code, 0, prepared.err + prepared.out);
  assert.deepEqual(w.journal(), [], "prepare sends nothing");
  assert.equal(w.delivery().version, before.version);
  const document = prepared.json().data.document;
  assert.equal(document.kind, "delivery.configure");
  assert.equal(document.expected.version, before.version);
  assert.deepEqual(
    document.preview.changes.map((c: Json) => c.field),
    [
      "level R1",
      "mode",
      "mergeMethod R1",
      "requiredChecks R1",
      "credentialRef",
      "branchPrefix",
    ],
  );
  const { command } = document;
  assert.equal(command.mode, "through-merge");
  assert.equal(command.credentialRef, "gh:github.com");
  assert.equal(command.branchPrefix, "cab/");
  assert.deepEqual(command.requiredChecks, []);
  assert.deepEqual(
    command.grants.map((g: Json) => `${g.repositoryId}:${g.action}:${g.mode}`),
    [
      "R1:branch.push:allow",
      "R1:branch.force-push:approval",
      "R1:pr.create:allow",
      "R1:pr.edit:allow",
      "R1:pr.ready:allow",
      "R1:pr.thread.reply:allow",
      "R1:pr.thread.resolve:allow",
      "R1:pr.merge:allow",
    ],
  );
  assert.deepEqual(command.repositories, [
    {
      repositoryId: "R1",
      mergeMethod: "squash",
      requiredChecks: [{ name: "ci" }],
    },
    { repositoryId: "R2", requiredChecks: [] },
  ]);
  assert.match(document.preview.notes.join(" "), /same OS user/);

  const human = await w.h.run([
    "delivery",
    "configure",
    w.project,
    "--repository",
    "R2",
    "--level",
    "open-prs",
    "--out",
    w.doc(),
    "--connection",
    "ro",
  ]);
  assert.match(human.out, /Prepared delivery\.configure for project:/);
  assert.match(human.out, /level R2: not-set-up -> open-prs/);

  const applied = await w.cli("rw", ["project", "apply", "--file", doc]);
  assert.equal(applied.code, 0, applied.err + applied.out);
  const receipt = applied.json().data.receipt;
  assert.equal(receipt.result.commandType, "delivery.configure");
  assert.equal(receipt.result.credentialConfigured, true);
  assert.equal(applied.json().request.scope, `project:${w.project}`);
  assert.deepEqual(
    w.journal().map((l) => l.state),
    ["sending", "recorded"],
  );
  const after = w.delivery();
  assert.equal(after.version, before.version + 1);
  assert.equal(after.mode, "through-merge");
  assert.equal(after.credentialRef, "gh:github.com");
  assert.equal(after.branchPrefix, "cab/");
  assert.equal(
    after.repositories?.find((r) => r.repositoryId === "R1")?.mergeMethod,
    "squash",
  );
  const read = await w.cli("ro", ["project", "get", w.project]);
  assert.equal(
    read.json().data.delivery.grants.length,
    8,
    "the read shows the level",
  );
  const recorded = await w.cli("ro", [
    "operation",
    "get",
    receipt.key,
    "--scope",
    `project:${w.project}`,
    "--type",
    "delivery.configure",
  ]);
  assert.deepEqual(recorded.json().data, { state: "recorded", receipt });

  // The same document replays its recorded receipt without another version.
  const again = await w.cli("rw", ["project", "apply", "--file", doc]);
  assert.equal(again.code, 0, again.err + again.out);
  assert.equal(w.delivery().version, after.version);
  assert.equal(again.json().data.replayed, true);
});

test("delivery configure keeps what it was not asked to change and reports no change and conflicts", async (t) => {
  const w = await configureWorld(t);
  const first = w.doc();
  let r = await w.cli("ro", [
    "delivery",
    "configure",
    w.project,
    "--repository",
    "R1",
    "--repository",
    "R2",
    "--level",
    "open-prs",
    "--required-check",
    "ci",
    "--branch-prefix",
    "cab/",
    "--out",
    first,
  ]);
  assert.equal(r.code, 0, r.err + r.out);
  r = await w.cli("rw", ["project", "apply", "--file", first]);
  assert.equal(r.code, 0, r.err + r.out);
  const saved = w.delivery();

  // Asking for what is already saved is no change, and writes no document.
  const noop = w.doc();
  r = await w.cli("ro", [
    "delivery",
    "configure",
    w.project,
    "--repository",
    "R1",
    "--level",
    "open-prs",
    "--out",
    noop,
  ]);
  assert.equal(r.code, 2, r.err + r.out);
  assert.match(r.json().error.message, /No change/);
  assert.equal(existsSync(noop), false);

  // An unrelated change keeps the level, checks and prefix.
  const keepDoc = w.doc();
  r = await w.cli("ro", [
    "delivery",
    "configure",
    w.project,
    "--repository",
    "R1",
    "--merge-method",
    "rebase",
    "--out",
    keepDoc,
  ]);
  assert.equal(r.code, 0, r.err + r.out);
  assert.equal(r.json().data.document.command.branchPrefix, "cab/");
  assert.deepEqual(
    r.json().data.document.preview.changes.map((c: Json) => c.field),
    ["mergeMethod R1"],
  );
  r = await w.cli("rw", ["project", "apply", "--file", keepDoc]);
  assert.equal(r.code, 0, r.err + r.out);
  const kept = w.delivery();
  assert.deepEqual(kept.grants, saved.grants);
  assert.equal(kept.branchPrefix, "cab/");
  assert.deepEqual(
    kept.repositories?.find((x) => x.repositoryId === "R1")?.requiredChecks,
    [{ name: "ci" }],
  );

  // Clearing the checks and the prefix.
  const clearDoc = w.doc();
  r = await w.cli("ro", [
    "delivery",
    "configure",
    w.project,
    "--repository",
    "R1",
    "--required-checks",
    "none",
    "--branch-prefix-default",
    "--credential-ref",
    "none",
    "--out",
    clearDoc,
  ]);
  assert.equal(r.code, 0, r.err + r.out);
  r = await w.cli("rw", ["project", "apply", "--file", clearDoc]);
  assert.equal(r.code, 0, r.err + r.out);
  const cleared = w.delivery();
  assert.equal(cleared.branchPrefix, undefined);
  assert.equal(cleared.credentialRef, null);
  assert.deepEqual(
    cleared.repositories?.find((x) => x.repositoryId === "R1")?.requiredChecks,
    [],
  );

  // A stale expected version conflicts; so does an apply after another change.
  r = await w.cli("ro", [
    "delivery",
    "configure",
    w.project,
    "--repository",
    "R1",
    "--merge-method",
    "merge",
    "--expected-version",
    "1",
    "--out",
    w.doc(),
  ]);
  assert.equal(r.code, 4, r.err + r.out);
  const stale = w.doc();
  r = await w.cli("ro", [
    "delivery",
    "configure",
    w.project,
    "--repository",
    "R2",
    "--merge-method",
    "merge",
    "--out",
    stale,
  ]);
  assert.equal(r.code, 0, r.err + r.out);
  const other = w.doc();
  r = await w.cli("ro", [
    "delivery",
    "configure",
    w.project,
    "--repository",
    "R2",
    "--merge-method",
    "squash",
    "--out",
    other,
  ]);
  r = await w.cli("rw", ["project", "apply", "--file", other]);
  assert.equal(r.code, 0, r.err + r.out);
  const version = w.delivery().version;
  r = await w.cli("rw", ["project", "apply", "--file", stale]);
  assert.equal(r.code, 4, r.err + r.out);
  assert.equal(w.delivery().version, version);
});
