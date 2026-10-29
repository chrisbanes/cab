import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { AdoptOutcome } from "../../src/standalone/git-fetch.js";
import type { PushOutcome } from "../../src/standalone/git-push.js";
import { OperatorApi } from "../../src/standalone/operator-api.js";
import { publicationWorld } from "../fixtures/delivery-integration.js";
import { scriptedGitLabRemote } from "../fixtures/gitlab-remote.js";

const host = "gitlab.example.com";
const projectPath = "group/sub/app";
const repositoryId = "42";
const credentialVariable = "CAB_TEST_GITLAB_DELIVERY_TOKEN";
const token = "glpat-synthetic-journey-token";

/** A task whose checkout is linked to a GitLab project that a scripted instance stands in for. */
async function gitlabWorld(
  t: { after: (cleanup: () => void) => void },
  mode: "allow" | "approval" = "allow",
  options: { credential?: boolean } = {},
) {
  const remote = scriptedGitLabRemote({ repositoryId });
  remote.state.project = { id: 42, path_with_namespace: projectPath };
  const pushes: Array<Record<string, unknown>> = [];
  const adopts: Array<Record<string, unknown>> = [];
  const script = {
    push: "pushed" as PushOutcome,
    adopt: "adopted" as AdoptOutcome,
  };
  const prior = process.env[credentialVariable];
  process.env[credentialVariable] = token;
  t.after(() => {
    if (prior === undefined) delete process.env[credentialVariable];
    else process.env[credentialVariable] = prior;
  });
  const world = await publicationWorld(mode, {
    host,
    repositoryId,
    projectPath,
    origin: `https://${host}/${projectPath}.git`,
    delivery: {
      fetcher: remote.fetcher,
      push: async (request) => {
        pushes.push({ ...request });
        if (script.push === "pushed") remote.state.head = request.commitSha;
        return script.push;
      },
      adopt: async (request) => {
        adopts.push({ ...request });
        return script.adopt;
      },
    },
  });
  if (options.credential !== false)
    world.f.service.domain().execute({
      type: "code-host-credential.configure",
      actor: "operator",
      key: randomUUID(),
      codeHost: "gitlab",
      host,
      credentialRef: `env:${credentialVariable}`,
    });
  return { ...world, remote, pushes, adopts, script };
}

const branchOf = (w: Awaited<ReturnType<typeof gitlabWorld>>) =>
  w.f.service.delivery().taskBranch(w.f.taskId, repositoryId);

/** Nothing the service shows or stores carries the token. */
function assertNoToken(w: Awaited<ReturnType<typeof gitlabWorld>>) {
  const actions = w.f.service.delivery().actions(w.f.taskId);
  assert.equal(JSON.stringify(actions).includes(token), false);
  assert.equal(JSON.stringify(branchOf(w)).includes(token), false);
}

test("an allowed push publishes to the GitLab project and settles on the branch read", async (t) => {
  const w = await gitlabWorld(t);
  try {
    const sha = w.commit("one.txt");
    const pushed = await w.push(sha);
    assert.equal(pushed.success, true, pushed.text);
    const branch = branchOf(w);
    assert.equal(branch?.lastPushedSha, sha);
    assert.equal(w.pushes.length, 1);
    assert.deepEqual(w.pushes[0], {
      workspacePath: w.pushes[0]?.workspacePath,
      commitSha: sha,
      branch: branch?.branch,
      lease: null,
      host,
      codeHost: "gitlab",
      nameWithOwner: projectPath,
      token,
    });
    assert.equal(
      w.remote.requests.every(
        (r) => new URL(r.url).origin === `https://${host}`,
      ),
      true,
    );
    assert.equal(pushed.text.includes(token), false);
    assertNoToken(w);
  } finally {
    await w.f.close();
  }
});

test("a lost push response stays uncertain and settles by the branch read without a second push", async (t) => {
  const w = await gitlabWorld(t);
  try {
    const sha = w.commit("one.txt");
    w.script.push = "uncertain";
    const lost = await w.push(sha);
    assert.equal(lost.success, false);
    const [record] = w.f.service.delivery().actions(w.f.taskId);
    assert.equal(record?.state, "uncertain");
    // The push had landed after all.
    w.remote.state.head = sha;
    await w.f.service.coordinationView().refreshDelivery(w.f.taskId);
    const settled = w.f.service.delivery().action(record?.operationId ?? "");
    assert.equal(settled.state, "confirmed-success");
    assert.equal(w.pushes.length, 1, "never replayed");
    assert.equal(branchOf(w)?.lastPushedSha, sha);
  } finally {
    await w.f.close();
  }
});

test("a GitLab head cab did not push is recorded as an outside change", async (t) => {
  const w = await gitlabWorld(t);
  try {
    const first = w.commit("one.txt");
    assert.equal((await w.push(first)).success, true);
    const outside = "5".repeat(40);
    w.remote.state.head = outside;
    assert.equal((await w.push(w.commit("two.txt"))).success, false);
    assert.equal(branchOf(w)?.outsideHeadSha, outside);
    assert.equal(w.pushes.length, 1, "the second push never reached Git");
  } finally {
    await w.f.close();
  }
});

test("overwrite and adoption of a GitLab outside head need the exact approval and then succeed", async (t) => {
  const w = await gitlabWorld(t);
  try {
    const first = w.commit("one.txt");
    assert.equal((await w.push(first)).success, true);
    const branch = String(branchOf(w)?.branch);
    const outside = "5".repeat(40);
    w.remote.state.head = outside;
    const next = w.commit("two.txt");
    assert.equal((await w.push(next)).success, false);
    const material = { branch, outsideHeadSha: outside, lastPushedSha: first };

    const overwrite = w.action("branch.force-push", {
      commitSha: next,
      ...material,
    });
    assert.equal((await w.recover(overwrite, 1)).success, false);
    assert.equal(w.remote.state.head, outside);
    const approval = await w.approve(overwrite, 1);
    // A head that moved since the approval is another outside change, and the approval is spent on
    // material that no longer matches.
    const moved = "6".repeat(40);
    w.remote.state.head = moved;
    assert.equal((await w.recover(overwrite, 2, approval)).success, false);
    assert.equal(w.pushes.length, 1);
    assert.equal(branchOf(w)?.outsideHeadSha, moved);
    const again = { ...overwrite, outsideHeadSha: moved };
    const second = await w.approve(again, 2);
    const done = await w.recover(again, 3, second);
    assert.equal(done.success, true, done.text);
    assert.equal(w.pushes.at(-1)?.lease, moved);
    assert.equal(w.pushes.at(-1)?.codeHost, "gitlab");
    assert.equal(branchOf(w)?.lastPushedSha, next);
    // The approval shows GitLab's comparison on the link's host.
    const shown = (
      await new OperatorApi(w.f.service, [w.f.directory]).readTask(w.f.taskId)
    ).data.approvals.find((a) => a.interactionId === second.interactionId);
    assert.equal(
      shown?.compareUrl,
      `https://${host}/${projectPath}/-/compare/${first}...${moved}`,
    );
    assert.equal(shown?.compareCodeHost, "gitlab");
    assertNoToken(w);
  } finally {
    await w.f.close();
  }
});

test("adopting a GitLab outside head fetches it from the project and records it as the lead's own", async (t) => {
  const w = await gitlabWorld(t);
  try {
    const first = w.commit("one.txt");
    assert.equal((await w.push(first)).success, true);
    const branch = String(branchOf(w)?.branch);
    const outside = "5".repeat(40);
    w.remote.state.head = outside;
    assert.equal((await w.push(w.commit("two.txt"))).success, false);
    const adoption = w.action("branch.adopt", {
      branch,
      outsideHeadSha: outside,
      lastPushedSha: first,
    });
    assert.equal((await w.recover(adoption, 1)).success, false);
    assert.equal(w.adopts.length, 0);
    const approval = await w.approve(adoption, 1);
    const done = await w.recover(adoption, 2, approval);
    assert.equal(done.success, true, done.text);
    assert.equal(w.adopts.length, 1);
    assert.equal(w.adopts[0]?.codeHost, "gitlab");
    assert.equal(w.adopts[0]?.nameWithOwner, projectPath);
    assert.equal(w.adopts[0]?.commitSha, outside);
    assert.equal(w.adopts[0]?.token, token);
    assert.equal(branchOf(w)?.lastPushedSha, outside);
    assert.equal(branchOf(w)?.outsideHeadSha, null);
    assertNoToken(w);
  } finally {
    await w.f.close();
  }
});

test("a host without a usable credential holds the push before any request or Git", async (t) => {
  const w = await gitlabWorld(t, "allow", { credential: false });
  try {
    const refused = await w.push(w.commit("one.txt"));
    assert.equal(refused.success, false);
    assert.match(refused.text, /provider-preflight-held/);
    assert.deepEqual(w.pushes, []);
    assert.equal(w.adopts.length, 0);
    assert.deepEqual(w.remote.requests, []);
  } finally {
    await w.f.close();
  }
});

test("merge requests stay unavailable on a GitLab link until they are implemented", async (t) => {
  const w = await gitlabWorld(t);
  try {
    const sha = w.commit("one.txt");
    assert.equal((await w.push(sha)).success, true);
    const requests = w.remote.requests.length;
    const refused = await w.createPr(String(branchOf(w)?.branch), sha);
    assert.equal(refused.success, false);
    assert.match(refused.text, /code-host-delivery-unavailable/);
    assert.equal(w.remote.requests.length, requests);
    assertNoToken(w);
    // The operator's task read carries no token either.
    const read = await new OperatorApi(w.f.service, [w.f.directory]).readTask(
      w.f.taskId,
    );
    assert.equal(JSON.stringify(read).includes(token), false);
  } finally {
    await w.f.close();
  }
});
