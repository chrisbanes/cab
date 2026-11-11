import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import {
  answerInstructionDraft,
  draftingTurn,
  seedDraftingProject,
  seedOperatorFeedback,
} from "../fixtures/drafting.js";
import { createOperatorFixture } from "../fixtures/operator-web.js";
import { until } from "../fixtures/until.js";

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

type Run = {
  state: string;
  kind: string;
  instructionProposal: { instructions: string } | null;
  instructionTarget: {
    kind: string;
    name: string | null;
    observedInstructions: string | null;
  } | null;
  feedback: Array<{ id: string; text: string | null }> | null;
  targetCurrent: { version: number; unchanged: boolean } | null;
  impact: {
    projects: Array<{ name: string | null; role: string }>;
    openAssignments: number;
  } | null;
  proposalWithheld: boolean;
};

const projectInstructions = "Keep changes small.";

async function world(t: { after: (fn: () => unknown) => void }) {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const domain = f.service.domain();
  const { projectId, leadId } = await seedDraftingProject(f);
  const execute = (command: Record<string, unknown>) =>
    domain.execute({
      actor: "operator",
      key: randomUUID(),
      ...command,
    } as never);
  execute({
    type: "project.configure",
    projectId,
    expectedVersion: Number(domain.project(projectId).version),
    instructions: projectInstructions,
  });
  const seeded = seedOperatorFeedback(f.service, projectId, leadId);
  const refs = [
    { kind: "message", id: seeded.message.id },
    { kind: "follow-up", id: seeded.followUp.id },
    { kind: "comment", id: seeded.comment.id },
  ];
  const web = await f.startWeb([f.directory]);
  const { cookie, csrf } = await session(web.origin, web.password);
  const post = (command: Record<string, unknown>) =>
    fetch(`${web.origin}/api/operator/commands`, {
      method: "POST",
      headers: {
        cookie,
        origin: web.origin,
        "content-type": "application/json",
        "x-csrf-token": csrf,
      },
      body: JSON.stringify(command),
    });
  const get = (path: string, headers: Record<string, string> = { cookie }) =>
    fetch(`${web.origin}${path}`, { headers });
  const runOf = async (runId: string) =>
    (
      (await (await get(`/api/operator/drafting-runs/${runId}`)).json()) as {
        data: Run;
      }
    ).data;
  const start = (over: Record<string, unknown> = {}): Promise<Response> =>
    post({
      type: "instruction.draft.start",
      key: randomUUID(),
      runId: randomUUID(),
      projectId,
      expectedProjectVersion: Number(domain.project(projectId).version),
      target: { kind: "project" },
      feedback: refs,
      note: "",
      ...over,
    });
  /** Starts a run and has the lead propose `instructions` for it. */
  const proposed = async (
    instructions: string,
    over: Record<string, unknown> = {},
  ) => {
    const runId = randomUUID();
    const response = await start({ runId, ...over });
    assert.equal(response.status, 200, await response.clone().text());
    await until(
      () => draftingTurn(f.service, runId) !== undefined,
      "the drafting turn",
    );
    await answerInstructionDraft(f, runId, {
      summary: "Ask for keyboard evidence",
      instructions,
      rationale: "Asked three times.",
      generalisation: "Every UI change.",
      conflicts: "",
      insufficientEvidence: false,
      evidence: ((over.feedback as typeof refs | undefined) ?? refs).map(
        ({ id }) => ({
          feedbackId: id,
          use: "supports",
          note: "",
        }),
      ),
    });
    await until(
      () => f.service.readDrafting(runId)?.state === "proposed",
      "the proposal",
    );
    return runId;
  };
  return {
    f,
    domain,
    execute,
    projectId,
    leadId,
    seeded,
    refs,
    post,
    get,
    runOf,
    start,
    proposed,
  };
}

test("the feedback list holds only operator feedback, newest first, a comment once, paged, and withholds excluded text", async (t) => {
  const { domain, execute, projectId, seeded, get } = await world(t);
  const page = async (query: string) => {
    const response = await get(
      `/api/operator/projects/${projectId}/operator-feedback${query}`,
    );
    assert.equal(response.status, 200, await response.clone().text());
    return (
      (await response.json()) as {
        data: {
          items: Array<{
            kind: string;
            id: string;
            text: string | null;
            available: boolean;
            recipientName: string | null;
            taskTitle: string | null;
          }>;
          nextCursor: string | null;
        };
      }
    ).data;
  };
  const all = await page("");
  assert.deepEqual(
    all.items.map(({ kind, id }) => [kind, id]),
    [
      ["comment", seeded.comment.id],
      ["follow-up", seeded.followUp.id],
      ["message", seeded.message.id],
    ],
  );
  assert.deepEqual(all.items[0], {
    ...all.items[0],
    text: seeded.comment.text,
    available: true,
    recipientName: "Mira, Rae",
    taskTitle: "Settings dialog",
  });
  const first = await page("?limit=2");
  assert.equal(first.items.length, 2);
  assert.ok(first.nextCursor);
  const second = await page(
    `?limit=2&cursor=${encodeURIComponent(first.nextCursor)}`,
  );
  assert.deepEqual(
    second.items.map(({ id }) => id),
    [seeded.message.id],
  );
  assert.equal(second.nextCursor, null);
  assert.equal(
    (
      await get(
        `/api/operator/projects/${projectId}/operator-feedback?limit=51`,
      )
    ).status,
    400,
  );
  // Another project's instructions inside a message: listed, but its text is withheld.
  const other = randomUUID();
  execute({
    type: "project.create",
    projectId: other,
    name: "Beta",
    leadProfileId: null,
    instructions: "focus-order evidence",
  });
  const withheld = (await page("")).items.find(
    ({ id }) => id === seeded.followUp.id,
  );
  assert.deepEqual([withheld?.text, withheld?.available], [null, false]);
  assert.equal(domain.project(other).name, "Beta");
});

test("start replays by key, refuses a stale project or undisclosable text, and the read needs a session and discloses only the target", async (t) => {
  const { execute, projectId, refs, post, get, runOf, start, proposed } =
    await world(t);
  const key = randomUUID();
  const runId = randomUUID();
  const command = {
    type: "instruction.draft.start",
    key,
    runId,
    projectId,
    expectedProjectVersion: 0,
    target: { kind: "project" },
    feedback: refs,
    note: "",
  };
  assert.equal((await post(command)).status, 400);
  assert.equal((await start({ expectedProjectVersion: 1 })).status, 409);
  const first = await start({ key, runId });
  assert.equal(first.status, 200);
  const receipt = await first.json();
  assert.deepEqual(await (await start({ key, runId })).json(), receipt);
  assert.equal((await start({ key, runId, note: "other" })).status, 409);
  // Too many items is refused whole.
  assert.equal(
    (await start({ feedback: Array.from({ length: 21 }, () => refs[0]) }))
      .status,
    400,
  );
  // A selected item whose text holds another project's instructions cannot be sent.
  execute({
    type: "project.create",
    projectId: randomUUID(),
    name: "Beta",
    leadProfileId: null,
    instructions: "keyboard navigation evidence",
  });
  assert.equal((await start()).status, 403);
  assert.equal(
    (await start({ feedback: [refs[1]], note: "keyboard navigation evidence" }))
      .status,
    403,
  );
  assert.equal(
    (await get(`/api/operator/drafting-runs/${runId}`, {})).status,
    401,
  );
  // The proposal holds the target's text; the read shows it, and the message stays withheld.
  const proposedRun = await proposed(
    `${projectInstructions}\nShow keyboard evidence for UI changes.`,
    { feedback: [refs[1], refs[2]] },
  );
  const read = await runOf(proposedRun);
  assert.equal(read.kind, "instruction");
  assert.equal(read.proposalWithheld, false);
  assert.equal(
    read.instructionProposal?.instructions,
    `${projectInstructions}\nShow keyboard evidence for UI changes.`,
  );
  assert.equal(
    read.instructionTarget?.observedInstructions,
    projectInstructions,
  );
  assert.equal(read.instructionTarget?.name, "Atlas");
  assert.deepEqual(read.targetCurrent?.unchanged, true);
  // Another project's instruction text appearing in recorded feedback is withheld on read.
  execute({
    type: "project.create",
    projectId: randomUUID(),
    name: "Gamma",
    leadProfileId: null,
    instructions: "focus-order evidence",
  });
  const reread = await runOf(proposedRun);
  assert.deepEqual(
    reread.feedback?.map(({ text }) => text),
    [null, "Every UI change needs keyboard evidence."],
  );
});

test("accept is one version-fenced configure that leaves existing assignments bound; reject and staleness change nothing", async (t) => {
  const { domain, execute, projectId, seeded, post, get, runOf, proposed } =
    await world(t);
  const edited = `${projectInstructions}\nAttach keyboard evidence to UI changes.`;
  const runId = await proposed(
    `${projectInstructions}\nShow keyboard evidence.`,
  );
  const run = await runOf(runId);
  assert.ok(run.targetCurrent?.unchanged);
  assert.equal(run.impact?.openAssignments, 2);
  const revision = Number(domain.project(projectId).instructionsRevision);
  const configure = {
    type: "project.configure",
    key: randomUUID(),
    projectId,
    expectedVersion: run.targetCurrent?.version,
    instructions: edited,
  };
  const sent = await post(configure);
  assert.equal(sent.status, 200, await sent.clone().text());
  const receipt = await sent.json();
  assert.deepEqual(await (await post(configure)).json(), receipt);
  assert.equal(
    Number(domain.project(projectId).instructionsRevision),
    revision + 1,
  );
  assert.equal(String(domain.project(projectId).instructions), edited);
  const settled = await post({
    type: "drafting.settle",
    key: randomUUID(),
    runId,
    disposition: "accept",
  });
  assert.equal(settled.status, 200);
  assert.equal((await runOf(runId)).state, "accepted");
  // The lead's existing assignment keeps the revision it captured.
  const bound = (await (
    await get(`/api/operator/assignments/${seeded.leadAssignment}/instructions`)
  ).json()) as { data: { comparison: { boundIsCurrent: boolean } } };
  assert.equal(bound.data.comparison.boundIsCurrent, false);

  // Stale: the instructions change after the run started.
  const stale = await proposed(`${edited}\nOne more line.`);
  const observed = (await runOf(stale)).targetCurrent?.version;
  execute({
    type: "project.configure",
    projectId,
    expectedVersion: Number(domain.project(projectId).version),
    instructions: "Changed elsewhere.",
  });
  assert.equal((await runOf(stale)).targetCurrent?.unchanged, false);
  const refused = await post({
    type: "project.configure",
    key: randomUUID(),
    projectId,
    expectedVersion: observed,
    instructions: `${edited}\nOne more line.`,
  });
  assert.equal(refused.status, 409);
  assert.equal(
    String(domain.project(projectId).instructions),
    "Changed elsewhere.",
  );

  // Reject: discarding changes no revision.
  const rejected = await proposed("Changed elsewhere.\nAnother line.");
  const before = Number(domain.project(projectId).instructionsRevision);
  assert.equal(
    (
      await post({
        type: "drafting.settle",
        key: randomUUID(),
        runId: rejected,
        disposition: "discard",
      })
    ).status,
    200,
  );
  assert.equal((await runOf(rejected)).state, "discarded");
  assert.equal(Number(domain.project(projectId).instructionsRevision), before);
});

test("an agent target discloses every project using the agent and saves as the agent's next revision", async (t) => {
  const { domain, execute, seeded, post, runOf, proposed } = await world(t);
  execute({
    type: "project.create",
    projectId: randomUUID(),
    name: "Beta",
    leadProfileId: seeded.agentId,
  });
  const runId = await proposed(
    "Review interface changes.\nCheck keyboard focus order.",
    { target: { kind: "profile", profileId: seeded.agentId } },
  );
  const run = await runOf(runId);
  assert.equal(run.instructionTarget?.name, "Rae");
  assert.equal(
    run.instructionTarget?.observedInstructions,
    "Review interface changes.",
  );
  assert.deepEqual(
    run.impact?.projects.map(({ name, role }) => [name, role]),
    [
      ["Atlas", "permitted"],
      ["Beta", "lead"],
    ],
  );
  assert.equal(run.impact?.openAssignments, 1);
  const version = Number(domain.profile(seeded.agentId).version);
  const saved = await post({
    type: "profile.configure",
    key: randomUUID(),
    profileId: seeded.agentId,
    expectedVersion: run.targetCurrent?.version,
    instructions: "Review interface changes.\nCheck keyboard focus order.",
  });
  assert.equal(saved.status, 200, await saved.clone().text());
  assert.equal(Number(domain.profile(seeded.agentId).version), version + 1);
  assert.equal((await runOf(runId)).targetCurrent?.unchanged, false);
});
