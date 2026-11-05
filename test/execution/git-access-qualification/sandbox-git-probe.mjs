// One bounded probe per harness: can sandboxed Git branch, commit, amend, rebase and delete a
// branch in a worktree of a cab-owned reftable repository, with only the workspace and three
// narrow Git roots writable, while hooks, config, info and the source checkout stay unwritable?
// Codex runs a fixed script through `codex sandbox` (no model); Claude runs it once through the
// pinned SDK with cab's sandbox options. Prints sanitised JSON; reads only CLAUDE_CODE_OAUTH_TOKEN
// from the environment, never operator data or ~/.env.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
if (
  args.length !== 2 ||
  !args.includes("--live") ||
  !args.includes("--one-attempt")
) {
  process.stderr.write(
    "Refusing live sandbox probes without exactly --live --one-attempt.\n",
  );
  process.exit(2);
}
const codexExecutable =
  "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex";
const token = process.env.CLAUDE_CODE_OAUTH_TOKEN;
if (!existsSync(codexExecutable) || !token) {
  process.stderr.write(
    "Refusing: the approved Codex launcher or CLAUDE_CODE_OAUTH_TOKEN is absent.\n",
  );
  process.exit(2);
}

const author = {
  GIT_AUTHOR_NAME: "cab probe",
  GIT_AUTHOR_EMAIL: "probe@example.invalid",
  GIT_COMMITTER_NAME: "cab probe",
  GIT_COMMITTER_EMAIL: "probe@example.invalid",
};
const gitEnv = {
  PATH: process.env.PATH,
  HOME: homedir(),
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  ...author,
};
const git = (cwd, ...gitArgs) =>
  execFileSync("git", ["-C", cwd, ...gitArgs], {
    encoding: "utf8",
    env: gitEnv,
  }).trim();
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const read = (path) => (existsSync(path) ? readFileSync(path, "utf8") : null);

// Runs the agent's Git and the forbidden writes; each line records one outcome.
const script = (managed, source) => `set -u
cd repo-1
export GIT_AUTHOR_NAME="cab probe" GIT_AUTHOR_EMAIL=probe@example.invalid
export GIT_COMMITTER_NAME="cab probe" GIT_COMMITTER_EMAIL=probe@example.invalid
out=../probe-result.txt
: > "$out"
step() { name=$1; shift; if "$@" >/dev/null 2>&1; then echo "$name ok" >> "$out"; else echo "$name denied" >> "$out"; fi; }
step switch git switch -c probe
echo probe > probe.txt
step add git add probe.txt
step commit git commit -m probe
step amend git commit --amend -m probe-amended
step rebase git rebase other
step branch git branch scratch
step branch-delete git branch -d scratch
step hooks mkdir '${managed}/hooks'
step config sh -c 'echo "[evil]" >> "${managed}/config"'
step info touch '${managed}/info'
step source-branch git -C '${source}' branch evil
`;

const evidence = {
  candidate: execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim(),
  node: process.version,
  git: execFileSync("git", ["--version"], { encoding: "utf8" }).trim(),
  codex: {
    launcherSha256: sha256(readFileSync(codexExecutable)),
    version: execFileSync(codexExecutable, ["--version"], {
      encoding: "utf8",
    }).trim(),
  },
  claude: {},
  cleanup: { fixtureRemoved: false },
  failure: null,
};

// A fresh source and managed repository per harness, so one run cannot satisfy the other.
function fixture(root, label) {
  const base = join(root, label);
  const source = join(base, "source");
  mkdirSync(source, { recursive: true });
  git(source, "init", "-q", "-b", "main");
  writeFileSync(join(source, "a.txt"), "one\n");
  git(source, "add", "a.txt");
  git(source, "commit", "-q", "-m", "one");
  const first = git(source, "rev-parse", "HEAD");
  writeFileSync(join(source, "b.txt"), "two\n");
  git(source, "add", "b.txt");
  git(source, "commit", "-q", "-m", "two");
  const second = git(source, "rev-parse", "HEAD");
  const managed = join(base, "repositories", "0123456789abcdef");
  mkdirSync(managed, { recursive: true });
  execFileSync(
    "git",
    ["init", "-q", "--bare", "--template=", "--ref-format=reftable", managed],
    { env: gitEnv },
  );
  writeFileSync(
    join(managed, "objects", "info", "alternates"),
    `${join(source, ".git", "objects")}\n`,
  );
  git(managed, "config", "gc.auto", "0");
  git(managed, "config", "maintenance.auto", "false");
  git(managed, "config", "core.logAllRefUpdates", "true");
  git(managed, "branch", "other", second);
  const workspace = join(base, "ws", "task");
  mkdirSync(workspace, { recursive: true });
  git(
    managed,
    "worktree",
    "add",
    "-q",
    "--detach",
    join(workspace, "repo-1"),
    first,
  );
  const admin = git(
    join(workspace, "repo-1"),
    "rev-parse",
    "--absolute-git-dir",
  );
  const scriptPath = join(base, "probe.sh");
  writeFileSync(scriptPath, script(managed, source));
  return {
    base,
    source,
    managed,
    workspace,
    admin,
    first,
    second,
    scriptPath,
    roots: [
      workspace,
      join(managed, "objects"),
      join(managed, "reftable"),
      admin,
    ],
    before: {
      sourceRefs: git(source, "for-each-ref"),
      sourceConfig: read(join(source, ".git", "config")),
      managedConfig: read(join(managed, "config")),
    },
  };
}

function verdict(f) {
  const lines = (read(join(f.workspace, "probe-result.txt")) ?? "")
    .trim()
    .split("\n")
    .filter(Boolean);
  const steps = Object.fromEntries(lines.map((line) => line.split(" ")));
  let log = null;
  let message = null;
  try {
    log = git(f.managed, "rev-list", "--reverse", "probe").split("\n");
    message = git(f.managed, "log", "-1", "--format=%s", "probe");
  } catch {
    // Absent branch: the failure shows in `pass`.
  }
  const after = {
    sourceRefs: git(f.source, "for-each-ref"),
    sourceConfig: read(join(f.source, ".git", "config")),
    managedConfig: read(join(f.managed, "config")),
  };
  const required = [
    "switch",
    "add",
    "commit",
    "amend",
    "rebase",
    "branch",
    "branch-delete",
  ];
  const forbidden = ["hooks", "config", "info", "source-branch"];
  const checks = {
    requiredOk: required.every((name) => steps[name] === "ok"),
    forbiddenDenied: forbidden.every((name) => steps[name] === "denied"),
    rebasedOrder:
      log?.length === 3 && log[0] === f.first && log[1] === f.second,
    amendedMessage: message === "probe-amended",
    scratchDeleted: !git(f.managed, "branch", "--list", "scratch"),
    sourceRefsUnchanged: after.sourceRefs === f.before.sourceRefs,
    sourceConfigUnchanged: after.sourceConfig === f.before.sourceConfig,
    managedConfigUnchanged: after.managedConfig === f.before.managedConfig,
    hooksAbsent: !existsSync(join(f.managed, "hooks")),
    infoAbsent: !existsSync(join(f.managed, "info")),
  };
  return { steps, checks, pass: Object.values(checks).every(Boolean) };
}

function codexCase(f) {
  const codexHome = join(f.base, "codex-home");
  mkdirSync(codexHome);
  const result = spawnSync(
    codexExecutable,
    [
      "sandbox",
      "-c",
      'sandbox_mode="workspace-write"',
      "-c",
      "sandbox_workspace_write.exclude_slash_tmp=true",
      "-c",
      "sandbox_workspace_write.exclude_tmpdir_env_var=true",
      "-c",
      `sandbox_workspace_write.writable_roots=${JSON.stringify(f.roots)}`,
      "--",
      "/bin/bash",
      f.scriptPath,
    ],
    {
      cwd: f.workspace,
      env: { PATH: process.env.PATH, HOME: homedir(), CODEX_HOME: codexHome },
      encoding: "utf8",
      timeout: 120_000,
    },
  );
  return { exit: result.status, ...verdict(f) };
}

async function claudeCase(f) {
  const sdk = await import("@anthropic-ai/claude-agent-sdk");
  const pkg = JSON.parse(
    readFileSync(
      new URL(
        "../../../node_modules/@anthropic-ai/claude-agent-sdk/package.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const executable = execFileSync("/usr/bin/which", ["claude"], {
    encoding: "utf8",
  }).trim();
  Object.assign(evidence.claude, {
    sdk: pkg.version,
    sdkDeclaredClaudeCode: pkg.claudeCodeVersion ?? null,
    installed: execFileSync(executable, ["--version"], {
      encoding: "utf8",
    }).trim(),
  });
  const configDir = join(f.base, "claude-config");
  mkdirSync(configDir);
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), 180_000);
  let bashCalls = 0;
  let resultSubtype = null;
  try {
    for await (const message of sdk.query({
      prompt: `Use the Bash tool exactly once to run this command, then reply "done": /bin/bash ${f.scriptPath}`,
      options: {
        cwd: f.workspace,
        pathToClaudeCodeExecutable: executable,
        env: {
          PATH: process.env.PATH,
          HOME: homedir(),
          CLAUDE_CODE_OAUTH_TOKEN: token,
          CLAUDE_CONFIG_DIR: configDir,
        },
        settingSources: [],
        strictMcpConfig: true,
        permissionMode: "dontAsk",
        tools: ["Bash"],
        allowedTools: ["Bash"],
        maxTurns: 3,
        abortController,
        canUseTool: async () => ({ behavior: "deny", message: "denied" }),
        sandbox: {
          enabled: true,
          failIfUnavailable: true,
          allowUnsandboxedCommands: false,
          autoAllowBashIfSandboxed: true,
          network: { allowedDomains: [] },
          filesystem: { allowWrite: f.roots },
        },
      },
    })) {
      if (message.type === "assistant")
        bashCalls += message.message.content.filter(
          (part) => part.type === "tool_use" && part.name === "Bash",
        ).length;
      if (message.type === "result") resultSubtype = message.subtype;
    }
  } finally {
    clearTimeout(timer);
  }
  return { bashCalls, resultSubtype, ...verdict(f) };
}

let root;
try {
  const cache = join(homedir(), ".cache");
  mkdirSync(cache, { recursive: true });
  root = realpathSync(mkdtempSync(join(cache, "cab-git-probe-")));
  evidence.codex.result = codexCase(fixture(root, "codex"));
  const claude = fixture(root, "claude");
  evidence.claude.result = await claudeCase(claude);
} catch (error) {
  evidence.failure = String(error?.message ?? error).slice(0, 500);
} finally {
  if (root) {
    rmSync(root, { recursive: true, force: true });
    evidence.cleanup.fixtureRemoved = !existsSync(root);
  }
}
const output = JSON.stringify(
  {
    ...evidence,
    codex: { ...evidence.codex, pass: evidence.codex.result?.pass === true },
    claude: { ...evidence.claude, pass: evidence.claude.result?.pass === true },
  },
  null,
  2,
)
  .replaceAll(token, "<redacted-token>")
  .replaceAll(root ?? "\0", "<fixture>")
  .replaceAll(homedir(), "~");
process.stdout.write(`${output}\n`);
process.exitCode =
  evidence.codex.result?.pass && evidence.claude.result?.pass ? 0 : 1;
