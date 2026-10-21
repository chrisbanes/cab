import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  draftProposalToolName,
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
  if (options.lead !== false)
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
      repositories: [
        {
          repositoryId: "repo-alpha",
          path: sourceRepository(
            f.directory,
            `drafting-source-${projectId.slice(0, 8)}`,
          ),
          ref: "main",
        },
      ],
      readiness: {
        mode: "all",
        conditions: [{ kind: "label", name: "ready" }],
      },
    });
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
