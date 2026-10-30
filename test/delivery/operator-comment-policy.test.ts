import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import {
  type CommentReasonCode,
  commentAvailability,
  commentReasonCodes,
  commentReasonSentences,
} from "../../src/operator/github-reasons.js";
import { deliveryWorld } from "../fixtures/operator-cli.js";

type World = Awaited<ReturnType<typeof deliveryWorld>>;
type After = Parameters<typeof deliveryWorld>[0];
const credentialName = "FIXTURE_COMMENT_POLICY_CREDENTIAL";

/** Rewrites the delivery policy; a non-empty unique value keeps `activationAllowed` open. */
function configure(
  t: After,
  w: World,
  credentialRef: string | null,
  comment: "allow" | "approval" | null,
) {
  if (credentialRef) {
    process.env[credentialName] = `fixture-${randomUUID()}`;
    t.after(() => {
      delete process.env[credentialName];
    });
  }
  w.f.service.domain().execute({
    type: "delivery.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: w.f.projectId,
    expectedVersion: w.f.service.delivery().configuration(w.f.projectId)
      .version,
    mode: "reviewable-pr",
    credentialRef,
    grants: [
      { action: "pr.merge", repositoryId: "R1", mode: "allow" },
      ...(comment
        ? [
            {
              action: "issue.comment" as const,
              repositoryId: "R1",
              mode: comment,
            },
          ]
        : []),
    ],
    requiredChecks: [{ name: "build", appId: 17 }],
  });
}
const policy = async (w: World) => (await w.task()).commentPolicy;
const credential = `env:${credentialName}`;

test("comment policy: a local task has no issue to comment on", async (t) => {
  const w = await deliveryWorld(t, "allow", true);
  assert.deepEqual(await policy(w), {
    available: false,
    mode: null,
    reason: "Task has no bound issue",
    reasonCode: "no-source-issue",
  });
});

test("comment policy: an imported task without a grant reports the grant", async (t) => {
  const w = await deliveryWorld(t, null);
  assert.deepEqual(await policy(w), {
    available: false,
    mode: null,
    reason: "No project grant for issue comments",
    reasonCode: "no-comment-grant",
  });
});

test("comment policy: a paused project holds comments", async (t) => {
  const w = await deliveryWorld(t, "allow");
  configure(t, w, credential, "allow");
  w.f.service.domain().execute({
    type: "project.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: w.f.projectId,
    expectedVersion: Number(
      w.f.service.domain().project(w.f.projectId).version,
    ),
    paused: true,
  });
  assert.deepEqual(await policy(w), {
    available: false,
    mode: "allow",
    reason: "Task admission or delivery is held",
    reasonCode: "held",
  });
});

test("comment policy: a grant without a delivery credential stays available but says why not", async (t) => {
  const w = await deliveryWorld(t, "allow");
  assert.deepEqual(await policy(w), {
    available: true,
    mode: "allow",
    reason: null,
    reasonCode: "no-delivery-credential",
  });
});

test("comment policy: a grant with a delivery credential has no reason code", async (t) => {
  const w = await deliveryWorld(t, "allow");
  configure(t, w, credential, "approval");
  assert.deepEqual(await policy(w), {
    available: true,
    mode: "approval",
    reason: null,
    reasonCode: null,
  });
});

test("comment policy: the first reason wins when two apply", async (t) => {
  const w = await deliveryWorld(t, null);
  w.f.service.domain().execute({
    type: "project.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: w.f.projectId,
    expectedVersion: Number(
      w.f.service.domain().project(w.f.projectId).version,
    ),
    paused: true,
  });
  assert.equal((await policy(w)).reasonCode, "no-comment-grant");
  const local = await deliveryWorld(t, "allow", true);
  local.f.service.domain().execute({
    type: "project.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: local.f.projectId,
    expectedVersion: Number(
      local.f.service.domain().project(local.f.projectId).version,
    ),
    paused: true,
  });
  assert.equal((await policy(local)).reasonCode, "no-source-issue");
});

test("comment policy: delivery get keeps its three policy fields and no reason code", async (t) => {
  const w = await deliveryWorld(t, "allow");
  assert.equal((await policy(w)).reasonCode, "no-delivery-credential");
  const json = await w.ok("ro", ["delivery", "get", w.f.taskId]);
  assert.deepEqual(json.data.commentPolicy, {
    available: true,
    mode: "allow",
    reason: null,
  });
});

test("comment policy: every code has a sentence and an absent code falls back to the reason", () => {
  const sentences: Record<CommentReasonCode, string> = {
    "no-source-issue": "This task has no issue to comment on.",
    "no-comment-grant": "This project doesn't permit issue comments.",
    held: "Comments wait while the task's admission or delivery is held.",
    "no-delivery-credential": "This project has no delivery credential set.",
  };
  assert.deepEqual(commentReasonSentences, sentences);
  for (const reasonCode of commentReasonCodes)
    assert.deepEqual(
      commentAvailability({ available: false, reason: "x", reasonCode }),
      { postable: false, sentence: sentences[reasonCode] },
    );
  assert.deepEqual(
    commentAvailability({
      available: true,
      reason: null,
      reasonCode: "no-delivery-credential",
    }),
    { postable: false, sentence: sentences["no-delivery-credential"] },
  );
  assert.deepEqual(commentAvailability({ available: true, reason: null }), {
    postable: true,
    sentence: null,
  });
  assert.deepEqual(
    commentAvailability({ available: true, reason: null, reasonCode: null }),
    { postable: true, sentence: null },
  );
  assert.deepEqual(
    commentAvailability({
      available: false,
      reason: "No project grant for issue comments",
    }),
    { postable: false, sentence: "No project grant for issue comments." },
  );
  const generic = "Comments aren't available for this task.";
  assert.deepEqual(commentAvailability({ available: false, reason: null }), {
    postable: false,
    sentence: generic,
  });
  assert.deepEqual(commentAvailability(undefined), {
    postable: false,
    sentence: generic,
  });
  // An inherited property name is not a code.
  assert.equal(
    commentAvailability({
      available: false,
      reason: null,
      reasonCode: "constructor" as CommentReasonCode,
    }).sentence,
    generic,
  );
});
