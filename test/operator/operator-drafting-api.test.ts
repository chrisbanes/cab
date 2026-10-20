import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { draftProposalToolName } from "../../src/standalone/drafting.js";
import { draftingTurn, seedDraftingProject } from "../fixtures/drafting.js";
import { startedOf } from "../fixtures/service-internals.js";
import { createOperatorFixture } from "../fixtures/operator-web.js";

const proposal = {
  title: "Publish a keyboard guide",
  outcome: "Publish the guide.\nDone: reviewed and checked examples.",
};

async function until(check: () => boolean, description: string) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`Timed out waiting for ${description}`);
}

async function session(origin: string, password: string) {
  const first = await fetch(`${origin}/api/operator/session`);
  const anonymous = (await first.json()) as { csrfToken: string };
  const cookie = first.headers.get("set-cookie")?.split(";")[0] ?? "";
  const login = await fetch(`${origin}/api/operator/login`, {
    method: "POST",
    headers: {
      cookie,
      origin,
      "content-type": "application/json",
      "x-csrf-token": anonymous.csrfToken,
    },
    body: JSON.stringify({ password }),
  });
  assert.equal(login.status, 200);
  const authed = (await login.json()) as { csrfToken: string };
  return {
    cookie: login.headers.get("set-cookie")?.split(";")[0] ?? "",
    csrf: authed.csrfToken,
  };
}

test("drafting commands are receipted, readable, stoppable and settle without creating a task", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const domain = f.service.domain();
  const { projectId } = await seedDraftingProject(f);
  const web = await f.startWeb([f.directory]);
  const { cookie, csrf } = await session(web.origin, web.password);
  const post = (command: Record<string, unknown>, token = csrf) =>
    fetch(`${web.origin}/api/operator/commands`, {
      method: "POST",
      headers: {
        cookie,
        origin: web.origin,
        "content-type": "application/json",
        "x-csrf-token": token,
      },
      body: JSON.stringify(command),
    });
  const read = (id: string, headers: Record<string, string> = { cookie }) =>
    fetch(`${web.origin}/api/operator/drafting-runs/${id}`, { headers });
  const runOf = async (id: string) =>
    ((await (await read(id)).json()) as { data: Record<string, unknown> }).data;

  // Start: a receipt, a replay under the same key, and a conflict for other content.
  const runId = randomUUID();
  const key = randomUUID();
  const start = {
    type: "drafting.start",
    key,
    runId,
    projectId,
    idea: "Document the keyboard shortcuts",
  };
  const started = await post(start);
  assert.equal(started.status, 200);
  const receipt = (await started.json()) as Record<string, unknown>;
  assert.equal(receipt.kind, "drafting");
  assert.equal(receipt.operation, "start");
  assert.equal(receipt.runId, runId);
  assert.equal("proposal" in receipt, false, "a receipt never carries text");
  const replay = await post(start);
  assert.equal(replay.status, 200);
  assert.deepEqual(await replay.json(), receipt);
  const other = await post({ ...start, idea: "Something else" });
  assert.equal(other.status, 409);

  // The lead proposes; the read carries state and proposal.
  await until(() => f.runtime.hasPending(1), "the drafting turn");
  const outcome = await f.runtime.callTool({
    threadId: "fixture-thread",
    turnId: "fixture-turn-1",
    callId: randomUUID(),
    tool: draftProposalToolName,
    arguments: proposal,
  });
  assert.equal(outcome.success, true);
  f.runtime.complete(1);
  await until(
    () => f.service.readDrafting(runId)?.state === "proposed",
    "the proposal",
  );
  const proposed = await runOf(runId);
  assert.equal(proposed.state, "proposed");
  assert.deepEqual(proposed.proposal, proposal);
  assert.equal(proposed.leadName, "Mira");
  // The project's lead is replaced: the run still names the lead it captured.
  const replacement = randomUUID();
  domain.execute({
    type: "profile.create",
    actor: "operator",
    key: randomUUID(),
    profileId: replacement,
    name: "Replacement",
    instructions: "Another lead.",
    capabilities: "plan",
  });
  domain.execute({
    type: "project.configure",
    actor: "operator",
    key: randomUUID(),
    projectId,
    expectedVersion: Number(domain.project(projectId).version),
    leadProfileId: replacement,
  });
  assert.equal((await runOf(runId)).leadName, "Mira");
  assert.equal(typeof proposed.expiresAt, "number");

  // Accepting settles the run; neither the receipt nor a later read carries the text.
  const accept = {
    type: "drafting.settle",
    key: randomUUID(),
    runId,
    disposition: "accept",
  };
  const accepted = await post(accept);
  assert.equal(accepted.status, 200);
  const acceptReceipt = (await accepted.json()) as Record<string, unknown>;
  assert.equal(acceptReceipt.operation, "accept");
  assert.equal(acceptReceipt.state, "accepted");
  assert.equal("proposal" in acceptReceipt, false);
  assert.equal((await runOf(runId)).proposal, null);
  assert.equal((await post({ ...accept, key: randomUUID() })).status, 409);

  // Stop: the run waits for the runtime to end, then reads interrupted.
  const stopId = randomUUID();
  assert.equal(
    (
      await post({
        type: "drafting.start",
        key: randomUUID(),
        runId: stopId,
        projectId,
        idea: "Another idea",
      })
    ).status,
    200,
  );
  await until(() => f.runtime.hasPending(2), "the second drafting turn");
  const stopped = await post({
    type: "drafting.stop",
    key: randomUUID(),
    runId: stopId,
  });
  assert.equal(stopped.status, 200);
  assert.equal(((await stopped.json()) as { state: string }).state, "stopping");
  assert.equal((await runOf(stopId)).state, "stopping");
  f.runtime.fail(2);
  await until(
    () => f.service.readDrafting(stopId)?.state === "interrupted",
    "the interrupted run",
  );
  const discard = await post({
    type: "drafting.settle",
    key: randomUUID(),
    runId: stopId,
    disposition: "discard",
  });
  assert.equal(
    ((await discard.json()) as { state: string }).state,
    "discarded",
  );

  // Text the read would have to alter is withheld whole, never shown empty or altered.
  const leakId = randomUUID();
  await post({
    type: "drafting.start",
    key: randomUUID(),
    runId: leakId,
    projectId,
    idea: "A third idea",
  });
  await until(() => f.runtime.hasPending(3), "the third drafting turn");
  // Another profile's instructions pass the tool, which knows only this run's, but are
  // redacted on every read.
  domain.execute({
    type: "profile.create",
    actor: "operator",
    key: randomUUID(),
    profileId: randomUUID(),
    name: "Other",
    instructions: "Private second profile instructions.",
    capabilities: "review",
  });
  await f.runtime.callTool({
    ...draftingTurn(f.service, leakId)!,
    callId: randomUUID(),
    tool: draftProposalToolName,
    arguments: {
      title: "Leaky draft",
      outcome: "Follow: Private second profile instructions.",
    },
  });
  f.runtime.complete(3);
  await until(
    () => f.service.readDrafting(leakId)?.state === "proposed",
    "the third proposal",
  );
  const withheld = await runOf(leakId);
  assert.equal(withheld.proposal, null);
  assert.equal(withheld.proposalWithheld, true);
  assert.equal((await runOf(runId)).proposalWithheld, false);

  // A path of the grant a run was built from stays withheld after the project unlinks it.
  const pathId = randomUUID();
  await post({
    type: "drafting.start",
    key: randomUUID(),
    runId: pathId,
    projectId,
    idea: "A fourth idea",
  });
  await until(() => f.runtime.hasPending(4), "the fourth drafting turn");
  const grantPath = f.service.draftingGrantPaths(pathId)[0];
  assert.ok(grantPath);
  // Recorded straight in the store, as a proposal that got past the tool would be.
  startedOf(f.service).drafting.recordProposal(pathId, {
    title: "Path draft",
    outcome: `Look in ${grantPath}`,
  });
  await domain.configureGitHub({
    type: "github.configure",
    actor: "operator",
    key: randomUUID(),
    projectId,
    expectedVersion: Number(domain.githubConfiguration(projectId).version),
    credentialRef: null,
    selections: [
      {
        id: "repo",
        kind: "repository",
        repositoryId: "R_1",
        owner: "acme",
        name: "atlas",
      },
    ],
    repositories: [],
    readiness: { mode: "all", conditions: [{ kind: "label", name: "ready" }] },
  });
  f.runtime.complete(4);
  await until(
    () => f.service.readDrafting(pathId)?.state === "proposed",
    "the fourth proposal",
  );
  const unlinkedRead = await runOf(pathId);
  assert.equal(unlinkedRead.proposal, null);
  assert.equal(unlinkedRead.proposalWithheld, true);

  // Guards: CSRF, authentication, unknown runs and a missing project.
  assert.equal((await post(start, "wrong-token")).status, 403);
  assert.equal((await read(runId, {})).status, 401);
  assert.equal((await read(randomUUID())).status, 404);
  assert.equal((await read("not-a-uuid")).status, 404);
  assert.equal(
    (
      await post({
        type: "drafting.stop",
        key: randomUUID(),
        runId: randomUUID(),
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await post({
        ...start,
        key: randomUUID(),
        runId: randomUUID(),
        projectId: randomUUID(),
      })
    ).status,
    404,
  );
  assert.equal(domain.tasks(projectId).length, 0, "drafting created no task");
});
