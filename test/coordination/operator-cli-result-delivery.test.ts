import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { type TestContext, test } from "node:test";
import { loginCli, serveCli } from "../fixtures/operator-cli.js";
import { createOperatorFixture } from "../fixtures/operator-web.js";
import { seedUnresolvedResult } from "../fixtures/unresolved-result.js";

// biome-ignore lint/suspicious/noExplicitAny: parsed CLI envelopes are asserted structurally
type Json = Record<string, any>;

async function resultWorld(t: TestContext) {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const s = await serveCli(t, f);
  const o = await loginCli(t, s);
  const seeded = await seedUnresolvedResult(f);
  const task = async () =>
    (
      (await (
        await s.sessionGet(`/api/operator/tasks/${seeded.taskId}`)
      ).json()) as { data: Json }
    ).data;
  const item = async () => {
    const [u] = (await task()).unresolvedResults;
    assert.ok(u, "an unresolved result");
    return u as Json;
  };
  const resultId = (await item()).resultId as string;
  const deliveries = async () =>
    (await task()).messages.filter((m: Json) => m.resultId === resultId).length;
  const deliverArgs = (...rest: string[]) => [
    "result",
    "deliver",
    seeded.taskId,
    resultId,
    ...rest,
  ];
  const wire = (before: () => void = () => {}) => {
    const w = {
      posts: 0,
      fetch: (async (input, init) => {
        if (String(input).endsWith("/api/operator/commands")) {
          w.posts++;
          before();
        }
        return fetch(input, init);
      }) as typeof fetch,
    };
    return w;
  };
  /** The requester that makes the permitted recipient unavailable, or none. */
  const requester = (id: string | null) =>
    f.seedPersistedState((db) =>
      db
        .prepare(
          "UPDATE domain_assignments SET requesterAssignmentId=? WHERE id=?",
        )
        .run(id, seeded.workerId),
    );
  return {
    ...o,
    s,
    f,
    seeded,
    taskId: seeded.taskId,
    resultId,
    task,
    item,
    deliveries,
    deliverArgs,
    wire,
    requester,
  };
}

test("result deliver sends the result to its permitted recipient once and replays after it leaves the unresolved list", async (t) => {
  const w = await resultWorld(t);
  const before = await w.item();
  const recipient = before.permittedRecipient.assignmentId as string;
  const command = `cab result deliver ${w.taskId} ${w.resultId}`;
  const shown = await w.h.run(["task", "get", w.taskId, "--connection", "rw"]);
  assert.ok(shown.out.includes(command), shown.out + shown.err);
  const result = await w.h.run([
    ...["result", "get", w.taskId, w.resultId],
    ...["--connection", "rw"],
  ]);
  assert.ok(result.out.includes(command), result.out + result.err);
  const inbox = await w.h.run(["inbox", "list", "--connection", "rw"]);
  assert.match(inbox.out, /names its 'cab result deliver' command/);
  const key = randomUUID();
  const first = await w.cli("rw", w.deliverArgs("--request-id", key));
  assert.equal(first.code, 0, first.out + first.err);
  const sent = first.json();
  assert.deepEqual(
    {
      kind: sent.data.receipt.kind,
      taskId: sent.data.receipt.taskId,
      recipientAssignmentId: sent.data.receipt.recipientAssignmentId,
    },
    {
      kind: "coordination",
      taskId: w.taskId,
      recipientAssignmentId: recipient,
    },
  );
  assert.equal(sent.request.key, key);
  assert.equal(sent.data.effect, "queued");
  const after = await w.task();
  assert.deepEqual(after.unresolvedResults, []);
  assert.equal(
    after.results.find((r: Json) => r.resultId === w.resultId)
      .recipientAssignmentId,
    recipient,
  );
  assert.equal(await w.deliveries(), 1);
  const human = await w.h.run([
    ...w.deliverArgs(
      "--request-id",
      key,
      "--expected-revision",
      String(before.revision),
    ),
    "--connection",
    "rw",
  ]);
  assert.equal(human.code, 0, human.err);
  assert.match(human.out, /next eligible turn/);
  assert.match(human.out, /cannot be redirected or undone/);
  assert.match(human.out, /does not complete the task/);

  // The item has left unresolvedResults; the printed identity and revision replay it.
  const replay = await w.cli(
    "rw",
    w.deliverArgs(
      "--request-id",
      key,
      "--expected-revision",
      String(before.revision),
    ),
  );
  assert.equal(replay.code, 0, replay.out + replay.err);
  assert.deepEqual(replay.json().data.receipt, sent.data.receipt);
  assert.equal(replay.json().data.reusedRequest, true);
  assert.equal(await w.deliveries(), 1);
  // The journal finds the key without --request-id when the revision is the same.
  const journaled = await w.cli(
    "rw",
    w.deliverArgs("--expected-revision", String(before.revision)),
  );
  assert.equal(journaled.json().request.key, key);

  // The session path replays the same body to the same receipt.
  const session = await w.s.sessionPost("/api/operator/commands", {
    type: "result.recipient",
    key,
    taskId: w.taskId,
    resultId: w.resultId,
    expectedRevision: before.revision,
    recipientAssignmentId: recipient,
  });
  assert.deepEqual(await session.json(), sent.data.receipt);

  // Other material under the same key conflicts and records nothing.
  const other = await w.cli(
    "rw",
    w.deliverArgs(
      "--request-id",
      key,
      "--expected-revision",
      String(before.revision + 1),
    ),
  );
  assert.equal(other.code, 4, other.out);
  assert.equal(await w.deliveries(), 1);

  // Without the revision a new request sees an already delivered result and sends nothing.
  const wire = w.wire();
  const again = await w.cli("rw", w.deliverArgs(), { fetch: wire.fetch });
  assert.equal(again.code, 4, again.out);
  assert.match(again.json().error.message, /already delivered/);
  assert.equal(wire.posts, 0);

  // A reopen needs settled work; Stop leaves the recorded delivery as it is.
  await w.f.service.stopTask(w.taskId);
  await w.s.restart();
  const restarted = await w.cli(
    "rw",
    w.deliverArgs(
      "--request-id",
      key,
      "--expected-revision",
      String(before.revision),
    ),
  );
  assert.equal(restarted.code, 0, restarted.out + restarted.err);
  assert.deepEqual(restarted.json().data.receipt, sent.data.receipt);
  assert.equal(await w.deliveries(), 1);
});

test("result deliver refuses an unknown result, an unavailable recipient, a stale revision and a destination that stops being permitted", async (t) => {
  const w = await resultWorld(t);
  const item = await w.item();
  const wire = w.wire();
  const run = (args: string[]) => w.cli("rw", args, { fetch: wire.fetch });

  const unknown = await run(["result", "deliver", w.taskId, randomUUID()]);
  assert.equal(unknown.code, 2, unknown.out);
  assert.equal(unknown.json().error.code, "not-found");

  const stale = await run(
    w.deliverArgs("--expected-revision", String(item.revision + 1)),
  );
  assert.equal(stale.code, 4, stale.out);
  assert.match(
    stale.json().error.message,
    new RegExp(`revision ${item.revision},`),
  );

  w.requester(randomUUID());
  assert.equal((await w.item()).availability, "recipient-unavailable");
  const unavailable = await run(w.deliverArgs());
  assert.equal(unavailable.code, 4, unavailable.out);
  assert.equal(unavailable.json().error.code, "policy-denied");
  assert.equal(wire.posts, 0);
  assert.equal(await w.deliveries(), 0);

  // The destination stops being permitted between the CLI read and its POST.
  w.requester(null);
  const racing = w.wire(() => w.requester(randomUUID()));
  const raced = await w.cli("rw", w.deliverArgs(), { fetch: racing.fetch });
  assert.equal(raced.code, 4, raced.out);
  assert.match(raced.json().error.code, /^(conflict|policy-denied)$/);
  assert.equal(racing.posts, 1);
  assert.equal(await w.deliveries(), 0);
  w.requester(null);
  assert.ok((await w.item()).permittedRecipient);

  // A result that already has a destination is refused as delivered, naming its recipient.
  const sent = await w.cli("rw", w.deliverArgs());
  assert.equal(sent.code, 0, sent.out + sent.err);
  const second = await w.cli("rw", w.deliverArgs());
  assert.equal(second.code, 4, second.out);
  assert.match(second.json().error.message, /already delivered to /);
  assert.equal(await w.deliveries(), 1);
});

test("result deliver keeps the request identity and revision when the reply is lost, and rejects a wrong receipt", async (t) => {
  const w = await resultWorld(t);
  const item = await w.item();
  const lost = await w.cli("rw", w.deliverArgs(), { fetch: w.lostReply });
  assert.equal(lost.code, 6, lost.out);
  const message = lost.json().error.message as string;
  const key = lost.json().error.request.key as string;
  assert.ok(
    message.includes(
      `--request-id ${key} --expected-revision ${item.revision}`,
    ),
    message,
  );
  assert.doesNotMatch(message, /operation get/);
  assert.equal(await w.deliveries(), 1);
  const rerun = await w.cli(
    "rw",
    w.deliverArgs(
      "--request-id",
      key,
      "--expected-revision",
      String(item.revision),
    ),
  );
  assert.equal(rerun.code, 0, rerun.out + rerun.err);
  assert.equal(rerun.json().data.receipt.kind, "coordination");
  assert.equal(await w.deliveries(), 1);

  const other = await resultWorld(t);
  const wrong: typeof fetch = async (input, init) => {
    const response = await fetch(input, init);
    if (!String(input).endsWith("/api/operator/commands")) return response;
    return Response.json({
      kind: "review",
      key: JSON.parse(String(init?.body)).key,
      recorded: true,
      taskId: other.taskId,
      operation: "delivery.refresh",
    });
  };
  const mismatched = await other.cli("rw", other.deliverArgs(), {
    fetch: wrong,
  });
  assert.equal(mismatched.code, 6, mismatched.out);
  assert.match(mismatched.json().error.message, /not the expected receipt/);
});

test("result deliver sends nothing for a read-only credential or a malformed identity", async (t) => {
  const w = await resultWorld(t);
  const wire = w.wire();
  const run = (connection: "ro" | "rw", args: string[]) =>
    w.cli(connection, args, { fetch: wire.fetch });
  assert.equal((await run("ro", w.deliverArgs())).code, 3);
  assert.equal(
    (await run("rw", w.deliverArgs("--request-id", "nope"))).code,
    2,
  );
  assert.equal((await run("rw", ["result", "deliver", w.taskId])).code, 2);
  assert.equal(wire.posts, 0);
  assert.equal(await w.deliveries(), 0);
});
