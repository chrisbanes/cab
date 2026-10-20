// One bounded live drafting run on the real Codex runtime. Refuses without
// `--live`, makes exactly one attempt (no retries) and prints redacted evidence
// JSON only: states, counts and validity, never the model's text or any path.
// `--issue` runs the issue-improvement kind against a seeded imported task whose
// issue comes from an in-process fake GitHub source; it makes no network call.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { draftProposalSchema } from "../../../dist/src/operator/contracts.js";
import { CodexRuntime } from "../../../dist/src/standalone/codex.js";
import {
  draftingTimeLimitMs,
  issueEditProposalOf,
  issueEditProposalSchema,
} from "../../../dist/src/standalone/drafting.js";
import { StandaloneService } from "../../../dist/src/standalone/service.js";

const args = process.argv.slice(2);
if (!args.includes("--live")) {
  process.stderr.write(
    "Refusing a live drafting run without the explicit --live flag.\n",
  );
  process.exit(2);
}
if (
  args.includes("--harness") &&
  args[args.indexOf("--harness") + 1] !== "codex"
) {
  process.stderr.write("Only the Codex harness is supported by this run.\n");
  process.exit(2);
}

const issueMode = args.includes("--issue");
// A fixed thin issue, as a GitHub reader would list it.
const thinIssue = {
  providerInstance: "github.com",
  nodeId: "I_LIVE",
  repositoryId: "R_LIVE",
  repositoryName: "acme/greeter",
  number: 1,
  title: "Greeter flag",
  body: "add a shout option",
  state: "open",
  labels: ["ready"],
  projectFields: [],
};

const result = {
  mode: issueMode ? "issue" : "brief",
  candidate: execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim(),
  node: process.version,
  codexVersion: execFileSync("codex", ["--version"], {
    encoding: "utf8",
  }).trim(),
  attempts: 1,
  limitMs: draftingTimeLimitMs,
  outcome: "failed",
  stateSequence: [],
  elapsedMs: null,
  proposal: { valid: false, titleLength: null, outcomeLength: null },
  capacityAfter: null,
  worktreeRemoved: null,
  tasksCreated: null,
  assignmentsCreated: null,
  deliveryRecords: null,
  cleanup: { rootRemoved: false },
  failure: null,
};
let root;
let service;
let stage = "setup";

if (issueMode)
  process.env.DRAFTING_LIVE_SOURCE = "offline-drafting-source-value";

const command = (domain, body) =>
  domain.execute({ key: randomUUID(), actor: "operator", ...body });

try {
  root = realpathSync(mkdtempSync(join(tmpdir(), "ensemble-drafting-live-")));
  const repository = join(root, "greeter");
  mkdirSync(join(repository, "src"), { recursive: true });
  writeFileSync(
    join(repository, "README.md"),
    "# Greeter\n\nA tiny command line tool that greets people by name.\n",
  );
  writeFileSync(
    join(repository, "src", "greet.js"),
    'const name = process.argv[2] ?? "world";\nconsole.log("Hello, " + name + "!");\n',
  );
  const git = (...gitArgs) =>
    execFileSync("git", ["-C", repository, ...gitArgs], { stdio: "ignore" });
  git("init", "-q", "-b", "main");
  git("add", ".");
  git(
    "-c",
    "user.name=Drafting Live",
    "-c",
    "user.email=drafting-live@invalid",
    "commit",
    "-q",
    "-m",
    "fixture",
  );

  stage = "service-start";
  const dataDir = join(root, "data");
  service = new StandaloneService(
    dataDir,
    (context) => new CodexRuntime("codex", context),
    undefined,
    issueMode
      ? {
          github: {
            readerFactory: () => ({
              async readSelection() {
                return { complete: true, issues: [thinIssue], reason: null };
              },
              async readBlockers() {
                return { complete: true, blockers: [], reason: null };
              },
              async readIssueStatus() {
                return { status: "open" };
              },
            }),
          },
        }
      : {},
  );
  await service.start();
  const domain = service.domain();
  const profileId = randomUUID();
  const projectId = randomUUID();
  command(domain, {
    type: "profile.create",
    profileId,
    name: "Live lead",
    instructions: "Prefer small, reviewable tasks.",
    capabilities: "plan",
  });
  command(domain, {
    type: "project.create",
    projectId,
    name: "Disposable drafting probe",
    leadProfileId: profileId,
  });
  command(domain, {
    type: "project.configure",
    projectId,
    expectedVersion: 1,
    paused: false,
  });
  await domain.configureGitHub({
    type: "github.configure",
    actor: "operator",
    key: randomUUID(),
    projectId,
    expectedVersion: Number(domain.githubConfiguration(projectId).version),
    credentialRef: issueMode ? "env:DRAFTING_LIVE_SOURCE" : null,
    selections: [
      {
        id: "repo",
        kind: "repository",
        repositoryId: "R_LIVE",
        owner: "acme",
        name: "greeter",
      },
    ],
    repositories: [{ repositoryId: "greeter", path: repository, ref: "main" }],
    readiness: { mode: "all", conditions: [{ kind: "label", name: "ready" }] },
  });

  let taskId;
  if (issueMode) {
    stage = "issue-import";
    command(domain, {
      type: "github.activate",
      projectId,
      selectionId: "repo",
      expectedVersion: Number(domain.githubConfiguration(projectId).version),
    });
    await service.refreshGitHub();
    taskId = service.githubSources().issue(thinIssue.nodeId)?.taskId;
    if (!taskId) throw new Error("The seeded issue was not imported");
  }

  // An imported task comes with its lead assignment, so what a run creates is measured
  // against the state just before it starts.
  const count = () => ({
    tasks: domain.tasks(projectId).length,
    assignments: taskId ? domain.assignments(taskId).length : 0,
    deliveryRecords: service.delivery().actions().length,
  });
  const baseline = count();

  stage = "drafting";
  const runId = randomUUID();
  const started = Date.now();
  if (issueMode) await service.startIssueDrafting({ runId, taskId, note: "" });
  else
    await service.startDrafting({
      runId,
      projectId,
      idea: "Let the greeter take a --shout flag that prints the greeting in capitals.",
    });
  const settled = ["proposed", "failed", "interrupted", "expired"];
  let run = service.readDrafting(runId);
  result.stateSequence.push(run.state);
  // The service's own cap ends a run at the limit; wait a little beyond it.
  while (!settled.includes(run.state)) {
    if (Date.now() - started > draftingTimeLimitMs + 60_000)
      throw new Error("The run did not settle within the limit");
    await new Promise((resolve) => setTimeout(resolve, 1000));
    run = service.readDrafting(runId);
    if (result.stateSequence.at(-1) !== run.state)
      result.stateSequence.push(run.state);
  }
  result.elapsedMs = Date.now() - started;
  result.outcome = run.state;
  const issueProposal = issueMode ? issueEditProposalOf(run) : null;
  const checked = issueMode
    ? issueEditProposalSchema.safeParse(issueProposal)
    : draftProposalSchema.safeParse(run.proposal);
  result.proposal = {
    valid: checked.success,
    titleLength: run.proposal?.title.length ?? null,
    outcomeLength: run.proposal?.outcome.length ?? null,
  };
  result.capacityAfter = service.capacityLimits([
    projectId,
  ]).currentUsage.global;
  const copies = join(dataDir, "drafting-workspaces");
  result.worktreeRemoved =
    !existsSync(copies) || readdirSync(copies).length === 0;
  const after = count();
  result.tasksCreated = after.tasks - baseline.tasks;
  result.assignmentsCreated = after.assignments - baseline.assignments;
  result.deliveryRecords = after.deliveryRecords - baseline.deliveryRecords;
  if (
    run.state !== "proposed" ||
    !checked.success ||
    !result.stateSequence.includes("running") ||
    result.elapsedMs > draftingTimeLimitMs ||
    result.capacityAfter !== 0 ||
    !result.worktreeRemoved ||
    result.tasksCreated !== 0 ||
    result.assignmentsCreated !== 0 ||
    result.deliveryRecords !== 0
  )
    throw new Error("The drafting run did not meet its acceptance conditions");
} catch (error) {
  result.failure = {
    stage,
    kind:
      error instanceof Error && /timed? out|settle/i.test(error.message)
        ? "timeout"
        : "runtime-or-service-error",
  };
  process.exitCode = 1;
} finally {
  try {
    await service?.stop();
  } catch {
    result.failure ??= { stage: "service-shutdown", kind: "cleanup-error" };
    process.exitCode = 1;
  }
  if (root) {
    try {
      rmSync(root, { recursive: true, force: true });
      result.cleanup.rootRemoved = true;
    } catch {
      result.failure ??= { stage: "root-cleanup", kind: "cleanup-error" };
      process.exitCode = 1;
    }
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
