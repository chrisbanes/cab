import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmodSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { databaseDigest } from "../fixtures/database-digest.js";
import { deliveryWorld } from "../fixtures/operator-cli.js";

// biome-ignore lint/suspicious/noExplicitAny: parsed CLI envelopes are asserted structurally
type Json = Record<string, any>;

async function comments(
  t: Parameters<typeof deliveryWorld>[0],
  mode: "allow" | "approval" | null,
  localTask = false,
) {
  const w = await deliveryWorld(t, mode, localTask);
  const version = async () => Number((await w.task()).task.version);
  const body = (text: string) => w.file(`${randomUUID()}.txt`, text);
  const review = async (text: string, extra: string[] = []) =>
    w.ok("rw", [
      "delivery",
      "review-comment",
      w.f.taskId,
      "--body-file",
      body(text),
      "--expected-task-version",
      String(await version()),
      ...extra,
    ]);
  const confirm = (r: Json) => [
    "delivery",
    "confirm-comment",
    w.f.taskId,
    "--review-id",
    r.reviewId,
    "--expected-revision",
    String(r.revision),
    "--material-hash",
    r.materialHash,
    "--decision",
    "approved",
  ];
  const send = async (text: string, extra: string[] = []) => [
    "delivery",
    "send-comment",
    w.f.taskId,
    "--body-file",
    body(text),
    "--expected-task-version",
    String(await version()),
    ...extra,
  ];
  const actions = async () => (await w.task()).delivery?.actions ?? [];
  const sessionCommand = async (command: Json) => {
    const r = await w.s.sessionPost("/api/operator/commands", {
      key: randomUUID(),
      taskId: w.f.taskId,
      ...command,
    });
    return { status: r.status, body: (await r.json()) as Json };
  };
  return {
    ...w,
    version,
    body,
    review,
    confirm,
    send,
    actions,
    sessionCommand,
  };
}

test("approval flow: review, confirm and send post exactly one bound comment", async (t) => {
  const w = await comments(t, "approval");
  const before = await w.actions();
  const reviewed = await w.review("Release notes are ready.");
  const r = reviewed.data.receipt;
  assert.equal(r.revision, 1);
  assert.equal(r.decision, "pending");
  assert.equal(r.reviewId, reviewed.request.key);
  assert.equal(r.operationId, r.reviewId);
  assert.equal(w.scripted.commentWrites, 0);
  assert.deepEqual(await w.actions(), before);
  const text = await w.h.run([
    "delivery",
    "review-comment",
    w.f.taskId,
    "--body-file",
    w.body("Release notes are ready."),
    "--expected-task-version",
    String(await w.version()),
    "--connection",
    "rw",
  ]);
  assert.match(text.out, /Nothing was posted/);
  assert.match(
    text.out,
    /cab delivery confirm-comment .* --decision approved\|denied/,
  );

  // A send before approval is refused by the CLI without burning the operation.
  const early = await w.cli(
    "rw",
    await w.send("Release notes are ready.", ["--review-id", r.reviewId]),
  );
  assert.equal(early.code, 4, early.out);
  assert.match(early.json().error.message, /pending, not approved/);
  assert.equal(w.scripted.commentWrites, 0);

  const approved = await w.ok("rw", w.confirm(r));
  assert.equal(approved.data.receipt.revision, 2);
  assert.equal(approved.data.receipt.decision, "approved");

  // A changed body is refused: the review replay conflicts before any send.
  const changed = await w.cli(
    "rw",
    await w.send("Changed text", ["--review-id", r.reviewId]),
  );
  assert.equal(changed.code, 4, changed.out);
  assert.match(
    changed.json().error.message,
    /a changed comment needs a new review/,
  );
  assert.equal(w.scripted.commentWrites, 0);

  const posted = await w.ok(
    "rw",
    await w.send("Release notes are ready.", ["--review-id", r.reviewId]),
  );
  assert.equal(posted.data.receipt.state, "confirmed-success");
  assert.equal(posted.data.receipt.operationId, r.reviewId);
  assert.equal(w.scripted.commentWrites, 1);
  assert.ok(
    w.scripted.comments[0]?.body.endsWith(
      `<!-- cab-operation:${r.reviewId} -->`,
    ),
  );
  const action = (await w.actions()).find(
    (a: Json) => a.operationId === r.reviewId,
  );
  assert.equal(action.state, "confirmed-success");
  const replay = await w.h.run([
    ...(await w.send("Release notes are ready.", ["--review-id", r.reviewId])),
    "--connection",
    "rw",
  ]);
  assert.equal(replay.code, 0, replay.err);
  assert.match(replay.out, /recorded outcome/);
  assert.equal(w.scripted.commentWrites, 1);
});

test("a service denial after approval exits 4 with its reason and posts nothing", async (t) => {
  const w = await comments(t, "approval");
  const r = (await w.review("Policy bound")).data.receipt;
  await w.ok("rw", w.confirm(r));
  w.grant("approval");
  const denied = await w.cli(
    "rw",
    await w.send("Policy bound", ["--review-id", r.reviewId]),
  );
  assert.equal(denied.code, 4, denied.out);
  assert.match(
    denied.json().error.message,
    /Denied: .*Create and confirm a new review/,
  );
  // Approval mode without --review-id is refused by the CLI with the steps to take.
  const noReview = await w.cli("rw", await w.send("No review"));
  assert.equal(noReview.code, 4);
  assert.match(noReview.json().error.message, /requires an approved review/);
  // No service test sends an approval-mode comment without a review.
  assert.equal(
    (
      await w.sessionCommand({
        type: "comment.send",
        expectedTaskVersion: await w.version(),
        body: "No review",
      })
    ).body.state,
    "denied",
  );
  assert.equal(w.scripted.commentWrites, 0);
});

test("no grant or no bound issue refuses before any request", async (t) => {
  for (const [mode, local] of [
    [null, false],
    ["allow", true],
  ] as const) {
    await t.test(`${mode} ${local ? "local" : "imported"}`, async (t) => {
      const w = await comments(t, mode, local);
      const requests = w.scripted.requests.length;
      const before = databaseDigest(w.s.f);
      for (const args of [
        [
          "delivery",
          "review-comment",
          w.f.taskId,
          "--body-file",
          w.body("x"),
          "--expected-task-version",
          String(await w.version()),
        ],
        await w.send("x"),
      ]) {
        const r = await w.cli("rw", args);
        assert.equal(r.code, 4, r.out);
      }
      assert.equal(databaseDigest(w.s.f), before);
      assert.equal(w.scripted.requests.length, requests);
    });
  }
});

test("allow mode: lost replies, restarts and reruns post one comment per request", async (t) => {
  const w = await comments(t, "allow");
  const before = databaseDigest(w.s.f);
  const requests = w.scripted.requests.length;
  const review = [
    "delivery",
    "review-comment",
    w.f.taskId,
    "--body-file",
    w.body("x"),
    "--expected-task-version",
    String(await w.version()),
  ];
  for (const args of [
    review,
    w.confirm({
      reviewId: randomUUID(),
      revision: 1,
      materialHash: "a".repeat(64),
    }),
    await w.send("Read-only"),
  ]) {
    const r = await w.cli("ro", args);
    assert.equal(r.code, 3, r.out);
  }
  assert.equal(databaseDigest(w.s.f), before);
  assert.equal(w.scripted.requests.length, requests);
  assert.equal(
    (await w.cli("rw", [...(await w.send("x")), "--decision", "approved"]))
      .code,
    2,
  );

  const args = await w.send("Shipped in 1.2.");
  const lost = await w.cli("rw", args, { fetch: w.lostReply });
  assert.equal(lost.code, 6, lost.out);
  const { request } = lost.json().error;
  assert.equal(request.scope, `task:${w.f.taskId}`);
  assert.equal(request.type, "comment.send");
  assert.match(
    lost.json().error.message,
    new RegExp(`--request-id ${request.key}`),
  );
  assert.equal(w.scripted.commentWrites, 1);
  await w.f.terminal();
  await w.s.restart();
  const rerun = await w.ok("rw", args);
  assert.equal(rerun.request.key, request.key);
  assert.equal(rerun.data.receipt.state, "confirmed-success");
  const after = await w.ok("rw", args);
  assert.deepEqual(after.data.receipt, rerun.data.receipt);
  assert.equal(w.scripted.commentWrites, 1);
  const deliberate = await w.ok(
    "rw",
    await w.send("Shipped in 1.2.", ["--request-id", randomUUID()]),
  );
  assert.notEqual(deliberate.request.key, request.key);
  assert.equal(w.scripted.commentWrites, 2);

  // A receipt the service refuses after recording the operation is not "nothing posted".
  const fenced: typeof fetch = async (input, init) => {
    const response = await fetch(input, init);
    return String(input).endsWith("/api/operator/commands")
      ? Response.json(
          { error: { code: "conflict", message: "Conflict" } },
          { status: 409 },
        )
      : response;
  };
  const fenceArgs = await w.send("Fenced receipt");
  const refused = await w.cli("rw", fenceArgs, { fetch: fenced });
  assert.equal(refused.code, 6, refused.out);
  assert.match(
    refused.json().error.message,
    /recorded operation .* did not return its receipt/,
  );
  assert.equal(w.scripted.commentWrites, 3);
  const settled = await w.ok("rw", fenceArgs);
  assert.equal(settled.request.key, refused.json().error.request.key);
  assert.equal(w.scripted.commentWrites, 3);

  // One UUID used for a review and a send stays two identities.
  const shared = randomUUID();
  const reviewed = await w.review("Shared key", ["--request-id", shared]);
  const sent = await w.ok(
    "rw",
    await w.send("Shared key", ["--request-id", shared]),
  );
  assert.equal(reviewed.data.receipt.kind, "comment-review");
  assert.equal(sent.data.receipt.kind, "delivery");
  assert.equal(w.scripted.commentWrites, 4);
});

test("a refused send receipt is reconciled from the task read, never reposted", async (t) => {
  const w = await comments(t, "allow");
  const journal = join(w.h.configDir, "requests.jsonl");
  const states = (key: string) =>
    readFileSync(journal, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l))
      .filter((l) => l.key === key)
      .map((l) => l.state);
  /** Posts the command, then replaces the reply with the given 4xx. */
  const after =
    (status: number, code: string, before?: () => void): typeof fetch =>
    async (input, init) => {
      const response = await fetch(input, init);
      if (!String(input).endsWith("/api/operator/commands")) return response;
      before?.();
      return Response.json({ error: { code, message: code } }, { status });
    };
  // A key refused before reaching the service, then used for other material.
  const key = randomUUID();
  const refused = await w.cli(
    "rw",
    await w.send("First", ["--request-id", key]),
    {
      fetch: async (input, init) =>
        String(input).endsWith("/api/operator/commands")
          ? Response.json(
              { error: { code: "conflict", message: "conflict" } },
              { status: 409 },
            )
          : fetch(input, init),
    },
  );
  assert.equal(refused.code, 4, refused.out);
  assert.equal(w.scripted.commentWrites, 0);
  const fenced = await w.cli(
    "rw",
    await w.send("Second", ["--request-id", key]),
    { fetch: after(409, "conflict") },
  );
  assert.equal(fenced.code, 6, fenced.out);
  assert.equal(states(key).at(-1), "unknown");
  assert.equal(w.scripted.commentWrites, 1);
  // Any 4xx after a post is reconciled the same way.
  for (const [status, code] of [
    [400, "invalid-input"],
    [404, "not-found"],
  ] as const) {
    const r = await w.cli("rw", await w.send(`After ${status}`), {
      fetch: after(status, code),
    });
    assert.equal(r.code, 6, r.out);
    assert.equal(states(r.json().error.request.key).at(-1), "unknown");
  }
  assert.equal(w.scripted.commentWrites, 3);
  // A journal that cannot record the unknown outcome says so, with the key.
  const locked = await w.cli("rw", await w.send("Locked journal"), {
    fetch: after(409, "conflict", () => chmodSync(journal, 0o400)),
  });
  chmodSync(journal, 0o600);
  assert.equal(locked.code, 5, locked.out);
  assert.equal(locked.json().error.code, "journal-unavailable");
  assert.match(locked.json().error.message, /--request-id/);
  assert.ok(locked.json().error.request.key);
  assert.equal(w.scripted.commentWrites, 4);
});
