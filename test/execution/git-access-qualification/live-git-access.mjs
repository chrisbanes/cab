// One bounded live task turn through the real service, for one harness: the agent runs a fixed
// Git script in its task workspace, made from cab's managed repository. Passes when the turn got
// its three Git roots, the branch, commit, amend and rebase landed in the managed repository,
// and the managed config, hooks and the source checkout were not written. Prints sanitised
// evidence JSON; reads only CLAUDE_CODE_OAUTH_TOKEN (Claude), never operator data or ~/.env.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CodexRuntime } from "../../../dist/src/standalone/codex.js";
import { ClaudeRuntime } from "../../../dist/src/standalone/claude.js";
import { StandaloneService } from "../../../dist/src/standalone/service.js";
import { MacProcessTerminationVerifier } from "../../../dist/src/standalone/termination.js";
import { taskGitWritableRoots } from "../../../dist/src/standalone/workspaces.js";

const args = process.argv.slice(2);
const harness = args
  .find((arg) => arg.startsWith("--harness="))
  ?.slice("--harness=".length);
if (
  args.length !== 3 ||
  !args.includes("--live") ||
  !args.includes("--one-attempt") ||
  (harness !== "codex" && harness !== "claude")
) {
  process.stderr.write(
    "Refusing live execution without exactly --live --one-attempt --harness=codex|claude.\n",
  );
  process.exit(2);
}
const codexExecutable =
  "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex";
const token = process.env.CLAUDE_CODE_OAUTH_TOKEN;
if (harness === "codex" ? !existsSync(codexExecutable) : !token) {
  process.stderr.write(
    "Refusing: the approved Codex launcher or CLAUDE_CODE_OAUTH_TOKEN is absent.\n",
  );
  process.exit(2);
}
const tokenVariable = "CAB_GIT_ACCESS_CLAUDE_TOKEN";
delete process.env.CLAUDE_CODE_OAUTH_TOKEN;

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const gitEnv = {
  PATH: process.env.PATH,
  HOME: homedir(),
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};
const git = (cwd, ...gitArgs) =>
  execFileSync(
    "git",
    [
      "-C",
      cwd,
      "-c",
      "user.name=cab probe",
      "-c",
      "user.email=probe@example.invalid",
      ...gitArgs,
    ],
    { encoding: "utf8", env: gitEnv },
  ).trim();
const deadline = Date.now() + 15 * 60_000;
const marker = `git-access-live-${harness}`;
const stage = (name) => process.stderr.write(`[git-access-live] ${name}\n`);

const evidence = {
  candidate: execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim(),
  harness,
  node: process.version,
  git: execFileSync("git", ["--version"], { encoding: "utf8" }).trim(),
  runtime: {},
  startTurnCalls: [],
  refusedTurns: 0,
  task: null,
  checks: null,
  pass: false,
  cleanup: { serviceStopped: false, processExit: null, fixtureRemoved: false },
  failure: null,
};

// The source's refs, config and hooks, which no agent write may change.
const sourceState = (source) =>
  sha256(
    JSON.stringify([
      git(source, "for-each-ref"),
      readFileSync(join(source, ".git", "config"), "utf8"),
      readdirSync(join(source, ".git", "hooks"))
        .sort()
        .map((name) => [
          name,
          sha256(readFileSync(join(source, ".git", "hooks", name))),
        ]),
    ]),
  );

let root;
let service;
const runtimes = [];
try {
  stage("fixture");
  const cache = join(homedir(), ".cache");
  mkdirSync(cache, { recursive: true });
  root = realpathSync(mkdtempSync(join(cache, "cab-git-access-live-")));
  chmodSync(root, 0o700);
  const source = join(root, "source");
  mkdirSync(source);
  git(root, "init", "-q", "-b", "main", source);
  git(
    source,
    "remote",
    "add",
    "origin",
    "https://github.com/cab-probe/git-access.git",
  );
  writeFileSync(join(source, "README.md"), "fixture\n");
  git(source, "add", "README.md");
  git(source, "commit", "-qm", "fixture");
  const sourceBefore = sourceState(source);
  const script = join(root, "git-probe.sh");
  writeFileSync(
    script,
    `set -u
export GIT_AUTHOR_NAME="cab probe" GIT_AUTHOR_EMAIL=probe@example.invalid
export GIT_COMMITTER_NAME="cab probe" GIT_COMMITTER_EMAIL=probe@example.invalid
out="$PWD/git-result.txt"
: > "$out"
cd repo-1
managed=$(git rev-parse --path-format=absolute --git-common-dir)
step() { name=$1; shift; if "$@" >/dev/null 2>&1; then echo "$name ok" >> "$out"; else echo "$name denied" >> "$out"; fi; }
base=$(git rev-parse HEAD)
step other git switch -c other
echo other > other.txt
step other-commit sh -c 'git add other.txt && git commit -qm other'
step probe git switch -c probe "$base"
echo probe > probe.txt
step commit sh -c 'git add probe.txt && git commit -qm probe'
step amend git commit -q --amend -m "probe amended"
step rebase git rebase -q other
step branch-delete git branch -q -d other
step config sh -c "echo '[evil]' >> '$managed/config'"
step hooks mkdir "$managed/hooks"
step source-branch git -C '${source}' branch evil
`,
  );

  const dataDir = join(root, "data");
  const claudeSdk =
    harness === "claude"
      ? await import("@anthropic-ai/claude-agent-sdk")
      : undefined;
  service = new StandaloneService(
    dataDir,
    (context, which) => {
      const runtime =
        which === "codex"
          ? new CodexRuntime(codexExecutable, context)
          : new ClaudeRuntime({
              safety: context.safety,
              claude: context.claude,
              sdk: claudeSdk,
            });
      runtimes.push(runtime);
      const startTurn = runtime.startTurn.bind(runtime);
      // Exactly one real turn, found by its marker; repair turns are refused.
      runtime.startTurn = (...call) => {
        if (
          !String(call[2]).includes(marker) ||
          evidence.startTurnCalls.length > 0
        ) {
          evidence.refusedTurns += 1;
          return Promise.reject(new Error("turn outside the one-turn budget"));
        }
        evidence.startTurnCalls.push({ policy: call[4] ?? null });
        return startTurn(...call);
      };
      return runtime;
    },
    undefined,
    {
      runtimeHarnesses: [harness],
      power: { enabled: false },
      routingClient: null,
    },
  );
  stage("service-start");
  await service.start();
  const exec = (body) =>
    service.domain().execute({ key: randomUUID(), actor: "operator", ...body });
  if (harness === "claude") {
    // The token enters this process only after the reference exists and the first generation stopped.
    exec({
      type: "claude-token.configure",
      credentialRef: `env:${tokenVariable}`,
    });
    await service.stop();
    process.env[tokenVariable] = token;
    await service.start();
    assert.equal(service.claudeTokenStatus().state, "available");
  }
  const d = service.domain();
  evidence.runtime =
    harness === "codex"
      ? {
          launcherSha256: sha256(readFileSync(codexExecutable)),
          version: execFileSync(codexExecutable, ["--version"], {
            encoding: "utf8",
          }).trim(),
        }
      : {
          sdk: JSON.parse(
            readFileSync(
              new URL(
                "../../../node_modules/@anthropic-ai/claude-agent-sdk/package.json",
                import.meta.url,
              ),
              "utf8",
            ),
          ).version,
          claude: execFileSync("claude", ["--version"], {
            encoding: "utf8",
          }).trim(),
        };
  const processIdentity = await runtimes.at(-1)?.processIdentity?.();

  const profileId = randomUUID(),
    projectId = randomUUID(),
    taskId = randomUUID();
  exec({
    type: "profile.create",
    profileId,
    name: "Git access live lead",
    instructions: "Run exactly the one command you are given. Keep it short.",
    capabilities: "shell",
    ...(harness === "claude"
      ? {
          runtime: {
            harness: "claude",
            model: "sonnet",
            reasoningEffort: "low",
          },
        }
      : {}),
  });
  exec({
    type: "project.create",
    projectId,
    name: "Git access live",
    leadProfileId: profileId,
  });
  await d.configureRepositories({
    type: "repositories.configure",
    actor: "operator",
    key: randomUUID(),
    projectId,
    expectedVersion: d.repositoryLinks(projectId).version,
    repositories: [
      {
        codeHost: "github",
        host: "github.com",
        repositoryId: "R_git_access",
        path: source,
        ref: "main",
      },
    ],
  });
  exec({
    type: "project.configure",
    projectId,
    expectedVersion: Number(d.project(projectId).version),
    paused: false,
  });
  stage("task");
  exec({
    type: "task.create",
    projectId,
    taskId,
    title: "Git access live",
    outcome: [
      "Disposable Git access probe.",
      `Marker: ${marker}`,
      `Run exactly this one shell command in the current directory: /bin/bash ${script}`,
      "Then reply with one short sentence and end the turn. Do not call any cab tool.",
    ].join("\n"),
    ready: true,
  });
  let intent;
  while (Date.now() < deadline) {
    intent = service.list().find((i) => i.workId.endsWith(":initial"));
    if (
      intent &&
      ["completed", "held", "resolved-failed"].includes(intent.state)
    )
      break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  assert.ok(intent, "an execution was admitted");
  const binding = await service.taskWorkspace(taskId);
  const repository = binding?.repositories[0];
  const managed = repository?.gitCommonDir;
  const resultFile = binding && join(binding.path, "git-result.txt");
  const steps = Object.fromEntries(
    (resultFile && existsSync(resultFile)
      ? readFileSync(resultFile, "utf8").trim().split("\n").filter(Boolean)
      : []
    ).map((line) => line.split(" ")),
  );
  evidence.task = { state: intent.state, reason: intent.reason, steps };
  let history = [];
  let message = null;
  try {
    history = git(managed, "rev-list", "--reverse", "probe").split("\n");
    message = git(managed, "log", "-1", "--format=%s", "probe");
  } catch {
    // An absent branch fails the checks below.
  }
  const roots = binding ? taskGitWritableRoots(binding) : [];
  evidence.checks = {
    turnCompleted: intent.state === "completed",
    oneTurn: evidence.startTurnCalls.length === 1,
    policyRoots:
      roots.length === 3 &&
      JSON.stringify(evidence.startTurnCalls[0]?.policy?.gitWritableRoots) ===
        JSON.stringify(roots),
    requiredOk: [
      "other",
      "other-commit",
      "probe",
      "commit",
      "amend",
      "rebase",
      "branch-delete",
    ].every((name) => steps[name] === "ok"),
    forbiddenDenied: ["config", "hooks", "source-branch"].every(
      (name) => steps[name] === "denied",
    ),
    rebasedHistory: history.length === 3,
    amendedMessage: message === "probe amended",
    managedConfigClean: !readFileSync(join(managed, "config"), "utf8").includes(
      "evil",
    ),
    managedHooksAbsent: !existsSync(join(managed, "hooks")),
    sourceUnchanged: sourceState(source) === sourceBefore,
    sourceNotWorktreeOwner: !git(
      source,
      "worktree",
      "list",
      "--porcelain",
    ).includes(repository.workspacePath),
  };
  // Roots are recorded only as their shape: the data-directory path stays private.
  evidence.startTurnCalls = evidence.startTurnCalls.map(({ policy }) => ({
    policy: policy && {
      networkAccess: policy.networkAccess,
      gitWritableRoots: policy.gitWritableRoots?.map((path) =>
        path.replace(managed, "<managed>"),
      ),
    },
  }));

  stage("stop");
  await service.stop();
  service = undefined;
  evidence.cleanup.serviceStopped = true;
  if (processIdentity) {
    const verifier = new MacProcessTerminationVerifier();
    const until = Date.now() + 10_000;
    let result;
    do {
      result = await verifier.verify(processIdentity);
      if (result.kind === "verified") break;
      await new Promise((r) => setTimeout(r, 100));
    } while (Date.now() < until);
    evidence.cleanup.processExit = result.kind;
  } else
    evidence.cleanup.processExit =
      harness === "claude"
        ? "per-turn claude process; no long-lived identity"
        : "unproved: no process identity";
  evidence.pass = Object.values(evidence.checks).every(Boolean);
} catch (error) {
  evidence.failure = String(error?.message ?? error).slice(0, 500);
} finally {
  try {
    await service?.stop();
  } catch (error) {
    evidence.failure ??= `cleanup: ${String(error)}`;
  }
  if (root) {
    rmSync(root, { recursive: true, force: true });
    evidence.cleanup.fixtureRemoved = !existsSync(root);
  }
}
let output = JSON.stringify(evidence, null, 2);
for (const secret of [token, root, homedir()].filter(Boolean))
  output = output.replaceAll(secret, secret === homedir() ? "~" : "<redacted>");
process.stdout.write(`${output}\n`);
process.exitCode = evidence.pass && !evidence.failure ? 0 : 1;
