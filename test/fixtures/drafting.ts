import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  draftProposalToolName,
  instructionProposalToolName,
  issueEditProposalToolName,
} from "../../src/standalone/drafting.js";
import type { StandaloneService } from "../../src/standalone/service.js";
import type { createOperatorFixture } from "./operator-web.js";

type Fixture = Awaited<ReturnType<typeof createOperatorFixture>>;

/** A one-commit checkout on `main` for a drafting run to read. */
export function sourceRepository(root: string, name = "drafting-source") {
  const path = join(root, name);
  mkdirSync(path, { recursive: true });
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", path, ...args], { stdio: "ignore" });
  execFileSync("git", ["init", "--quiet", "-b", "main", path]);
  git("config", "user.name", "Drafting Test");
  git("config", "user.email", "drafting-test@example.invalid");
  writeFileSync(join(path, "README.md"), "# Atlas\n");
  git("add", "README.md");
  git("commit", "--quiet", "-m", "initial");
  return path;
}

/** An unpaused project led by Mira with the source checkout linked; or no lead and no link. */
export async function seedDraftingProject(
  f: Fixture,
  options: { name?: string; lead?: boolean } = {},
) {
  const domain = f.service.domain();
  const projectId = randomUUID();
  const leadId = randomUUID();
  domain.execute({
    type: "profile.create",
    actor: "operator",
    key: randomUUID(),
    profileId: leadId,
    name: "Mira",
    instructions: "Prefer small, reviewable tasks.",
    capabilities: "plan",
  });
  domain.execute({
    type: "project.create",
    actor: "operator",
    key: randomUUID(),
    projectId,
    name: options.name ?? "Atlas",
    leadProfileId: options.lead === false ? null : leadId,
  });
  domain.execute({
    type: "project.configure",
    actor: "operator",
    key: randomUUID(),
    projectId,
    expectedVersion: 1,
    paused: false,
  });
  if (options.lead !== false) {
    await domain.configureRepositories({
      type: "repositories.configure",
      actor: "operator",
      key: randomUUID(),
      projectId,
      expectedVersion: domain.repositoryLinks(projectId).version,
      repositories: [
        {
          codeHost: "github",
          host: "github.com",
          repositoryId: "repo-alpha",
          path: sourceRepository(
            f.directory,
            `drafting-source-${projectId.slice(0, 8)}`,
          ),
          ref: "main",
        },
      ],
    });
    domain.execute({
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
      readiness: {
        mode: "all",
        conditions: [{ kind: "label", operator: "has", name: "ready" }],
      },
    });
  }
  return { projectId, leadId };
}

/** The thread and turn the fixture runtime holds for a drafting run, once it is running. */
export function draftingTurn(service: StandaloneService, runId: string) {
  const intent = service
    .list()
    .find((item) => item.workId === `drafting:${runId}`);
  return intent?.threadId && intent.turnId
    ? { threadId: intent.threadId, turnId: intent.turnId }
    : undefined;
}

/** The lead's side of a run: it proposes, then its turn ends. */
export async function answerDraft(
  f: Fixture,
  runId: string,
  proposal: { title: string; outcome: string },
) {
  const turn = draftingTurn(f.service, runId);
  if (!turn) throw new Error("The drafting turn is not running");
  const outcome = await f.runtime.callTool({
    ...turn,
    callId: randomUUID(),
    tool: draftProposalToolName,
    arguments: proposal,
  });
  if (!outcome.success) throw new Error(outcome.text);
  f.runtime.complete(Number(turn.turnId.replace("fixture-turn-", "")));
}

/** The lead's side of an Improve with lead run: it proposes a replacement, then its turn ends. */
export async function answerIssueDraft(
  f: Fixture,
  runId: string,
  proposal: { title: string; body: string },
) {
  const turn = draftingTurn(f.service, runId);
  if (!turn) throw new Error("The drafting turn is not running");
  const outcome = await f.runtime.callTool({
    ...turn,
    callId: randomUUID(),
    tool: issueEditProposalToolName,
    arguments: proposal,
  });
  if (!outcome.success) throw new Error(outcome.text);
  f.runtime.complete(Number(turn.turnId.replace("fixture-turn-", "")));
}

/**
 * A task of the project assigned to its lead and to a permitted agent, Rae, with one of each
 * kind of recorded operator feedback, oldest first: a message, a follow-up and a comment to both.
 * It also records an agent result and a question answer, which are not operator feedback.
 */
export function seedOperatorFeedback(
  service: StandaloneService,
  projectId: string,
  leadId: string,
) {
  const domain = service.domain();
  const db = (service as unknown as { db: import("node:sqlite").DatabaseSync })
    .db;
  const agentId = randomUUID();
  const taskId = randomUUID();
  const leadAssignment = randomUUID();
  const agentAssignment = randomUUID();
  const run = (command: Record<string, unknown>) =>
    domain.execute({
      actor: "operator",
      key: randomUUID(),
      ...command,
    } as never);
  run({
    type: "profile.create",
    profileId: agentId,
    name: "Rae",
    instructions: "Review interface changes.",
    capabilities: "review",
  });
  run({
    type: "routing.configure",
    projectId,
    expectedVersion: Number(domain.routing(projectId).version),
    enabled: false,
    candidateProfileIds: [agentId],
  });
  run({
    type: "task.create",
    projectId,
    taskId,
    title: "Settings dialog",
    outcome: "Ship the settings dialog.",
    ready: false,
    initialAssignment: { assignmentId: leadAssignment, profileId: leadId },
  });
  run({
    type: "assignment.create",
    projectId,
    taskId,
    assignmentId: agentAssignment,
    profileId: agentId,
    brief: "Review the dialog.",
    resultDestination: "lead",
    requesterAssignmentId: null,
  });
  const event = db.prepare(`INSERT INTO coordination_inbox_events
    (eventId, taskId, recipientAssignmentId, eventType, payload, createdAt)
    VALUES (?, ?, ?, ?, ?, ?)`);
  const message = {
    id: randomUUID(),
    text: "Show keyboard navigation evidence for this dialog.",
  };
  const followUp = {
    id: randomUUID(),
    text: "Add focus-order evidence before finishing.",
  };
  const comment = {
    id: randomUUID(),
    text: "Every UI change needs keyboard evidence.",
  };
  event.run(
    message.id,
    taskId,
    leadAssignment,
    "operator-message",
    JSON.stringify({ message: message.text }),
    100,
  );
  event.run(
    followUp.id,
    taskId,
    leadAssignment,
    "assignment-follow-up",
    JSON.stringify({ requester: "operator", instructions: followUp.text }),
    200,
  );
  event.run(
    randomUUID(),
    taskId,
    leadAssignment,
    "assignment-follow-up",
    JSON.stringify({ requester: "lead", instructions: "Lead follow-up." }),
    250,
  );
  db.prepare(
    "INSERT INTO coordination_task_comments (commentId, taskId, author, body, createdAt) VALUES (?, ?, 'operator', ?, 300)",
  ).run(comment.id, taskId, comment.text);
  const deliveries = [leadAssignment, agentAssignment].map((assignmentId) => {
    const eventId = randomUUID();
    event.run(
      eventId,
      taskId,
      assignmentId,
      "operator-message",
      JSON.stringify({ message: comment.text }),
      300,
    );
    db.prepare(
      `INSERT INTO coordination_task_comment_deliveries
      (commentId, recipientAssignmentId, eventId, expectedAssignmentVersion, effect, assignmentVersion)
      VALUES (?, ?, ?, 1, 'input', 1)`,
    ).run(comment.id, assignmentId, eventId);
    return eventId;
  });
  const result = randomUUID();
  event.run(
    result,
    taskId,
    leadAssignment,
    "assignment-result",
    JSON.stringify({ summary: "Done" }),
    400,
  );
  const answer = randomUUID();
  event.run(
    answer,
    taskId,
    leadAssignment,
    "question-answer",
    JSON.stringify({ answer: "Yes" }),
    500,
  );
  return {
    taskId,
    agentId,
    leadAssignment,
    message,
    followUp,
    comment,
    /** Events that are not operator feedback in their own right. */
    ineligible: { result, answer, commentDelivery: deliveries[0] as string },
  };
}

/** The lead's side of an instruction run: it proposes, then its turn ends. */
export async function answerInstructionDraft(
  f: Fixture,
  runId: string,
  proposal: Record<string, unknown>,
) {
  const turn = draftingTurn(f.service, runId);
  if (!turn) throw new Error("The drafting turn is not running");
  const outcome = await f.runtime.callTool({
    ...turn,
    callId: randomUUID(),
    tool: instructionProposalToolName,
    arguments: proposal,
  });
  if (!outcome.success) throw new Error(outcome.text);
  f.runtime.complete(Number(turn.turnId.replace("fixture-turn-", "")));
}
