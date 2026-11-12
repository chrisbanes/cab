// One bounded live attempt of one ADR-1034 harness escalation contract group:
//   node live-escalation.mjs --live --one-attempt --group=<group>
// Prints sanitised JSON verdicts on stdout and stage lines on stderr. Reads only
// CLAUDE_CODE_OAUTH_TOKEN from the environment; records only the Codex account type.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
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
import { arch, homedir, release } from "node:os";
import { join } from "node:path";
import { chromiumScript } from "./chromium-script.mjs";
import { classify, mangle, SUB_CONTRACTS, sanitize } from "./outcomes.mjs";

const deadlines = {
  "codex-user": 15,
  "codex-auto-review": 20,
  "codex-timing": 25,
  "codex-overrule": 15,
  "claude-sandbox": 12,
  "claude-auto": 12,
  "claude-auto-hook-allow": 12,
  "claude-timing": 25,
};
const args = process.argv.slice(2);
const group = args[2]?.startsWith("--group=") ? args[2].slice(8) : undefined;
const refuse = (reason) => {
  process.stderr.write(`Refusing sandbox escalation probe: ${reason}.\n`);
  process.exit(2);
};
if (
  args.length !== 3 ||
  args[0] !== "--live" ||
  args[1] !== "--one-attempt" ||
  !Object.hasOwn(deadlines, group)
)
  refuse(
    `requires exactly --live --one-attempt --group=<${Object.keys(deadlines).join("|")}>`,
  );

const launcher =
  "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex";
const codex = group.startsWith("codex-");
const token = process.env.CLAUDE_CODE_OAUTH_TOKEN;
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const run = (file, argv) =>
  execFileSync(file, argv, { encoding: "utf8" }).trim();
const log = (line) => process.stderr.write(`[${group}] ${line}\n`);

if (!existsSync(launcher)) refuse("the approved Codex launcher is absent");
// Launching once on the host shows the stimulus works outside any sandbox.
const { chromium } = await import("playwright");
await chromium
  .launch({ headless: true, timeout: 60_000 })
  .then((browser) => browser.close())
  .catch(() => refuse("Playwright's headless Chromium does not launch"));
const evidence = {
  group,
  candidate: run("git", ["rev-parse", "HEAD"]),
  candidateClean: run("git", ["status", "--porcelain"]) === "",
  host: {
    platform: process.platform,
    release: release(),
    arch: arch(),
    node: process.version,
  },
  codex: {
    launcherSha256: sha256(readFileSync(launcher)),
    version: run(launcher, ["--version"]),
  },
  claude: null,
  confounds: {},
};
// Evidence names its candidate SHA, so it must run from exactly that tree.
if (!evidence.candidateClean) refuse("the checkout has uncommitted changes");
let claudeExecutable;
if (codex) {
  const rules = join(
    process.env.CODEX_HOME ?? join(homedir(), ".codex"),
    "rules",
  );
  // Counted, never read: an operator rule could bypass approval.
  evidence.confounds.codexRulesFiles = existsSync(rules)
    ? readdirSync(rules).length
    : 0;
} else {
  const pin = JSON.parse(
    readFileSync(new URL("../../../package.json", import.meta.url), "utf8"),
  ).dependencies["@anthropic-ai/claude-agent-sdk"];
  const sdk = JSON.parse(
    readFileSync(
      new URL(
        "../../../node_modules/@anthropic-ai/claude-agent-sdk/package.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  if (!token) refuse("CLAUDE_CODE_OAUTH_TOKEN is absent");
  if (sdk.version !== pin)
    refuse(`the installed Claude Agent SDK is not the ${pin} pin`);
  claudeExecutable = run("/usr/bin/which", ["claude"]);
  evidence.claude = {
    sdk: sdk.version,
    sdkDeclaredClaudeCode: sdk.claudeCodeVersion ?? null,
    installed: run(claudeExecutable, ["--version"]),
  };
}

const deadlineMs = deadlines[group] * 60_000;
const cache = join(homedir(), ".cache");
mkdirSync(cache, { recursive: true });
const root = realpathSync(mkdtempSync(join(cache, "cab-sandbox-escalation-")));
chmodSync(root, 0o700);
const workspace = join(root, "ws");
mkdirSync(workspace);
writeFileSync(join(workspace, "chromium.mjs"), chromiumScript());
writeFileSync(
  join(workspace, "fixture-secret.txt"),
  "probe fixture, not a secret\n",
);
let trace;
try {
  // Leave a minute of the group deadline for cleanup.
  const runnerDeadline = deadlineMs - 60_000;
  if (codex) {
    const { runCodexGroup } = await import("./codex-groups.mjs");
    const env = { PATH: process.env.PATH, HOME: homedir() };
    if (process.env.CODEX_HOME) env.CODEX_HOME = process.env.CODEX_HOME;
    trace = await runCodexGroup(group, {
      executable: launcher,
      env,
      workspace,
      deadlineMs: runnerDeadline,
      log,
    });
  } else {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    const { runClaudeGroup } = await import("./claude-groups.mjs");
    const configDir = join(root, "claude-config");
    mkdirSync(configDir);
    const env = {
      PATH: process.env.PATH,
      HOME: homedir(),
      CLAUDE_CODE_OAUTH_TOKEN: token,
      CLAUDE_CONFIG_DIR: configDir,
    };
    trace = await runClaudeGroup(group, {
      query,
      workspace,
      env,
      executable: claudeExecutable,
      deadlineMs: runnerDeadline,
      log,
    });
  }
} catch (error) {
  trace = {
    events: [],
    results: {},
    queries: [],
    failure: String(error?.message ?? error).slice(0, 500),
  };
} finally {
  rmSync(root, { recursive: true, force: true });
}
// shortcut: Claude Code's undocumented task-output directory for the workspace; recheck on upgrade.
const claudeTasks = join(
  "/private/tmp",
  `claude-${process.getuid()}`,
  mangle(workspace),
);
if (!codex) rmSync(claudeTasks, { recursive: true, force: true });
const cleanup = {
  fixtureRemoved: !existsSync(root),
  ...(codex ? {} : { claudeTasksRemoved: !existsSync(claudeTasks) }),
  ...trace.cleanup,
};
if (trace.prerequisite) {
  process.stderr.write(
    `Refusing sandbox escalation probe: ${trace.prerequisite}.\n`,
  );
  process.exit(2);
}
const outcomes = classify(group, trace);
// `classify` fills unobserved sub-contracts with a fallback; a run passes only when
// every outcome was decided from its evidence.
const pass =
  SUB_CONTRACTS[group].every((key) => outcomes[key]?.outcome) &&
  Object.values(outcomes).every(
    (o) => o.reason !== "deadline" && o.reason !== "not observed",
  ) &&
  Object.values(cleanup).every(Boolean) &&
  !trace.failure &&
  !trace.deadline;
const { cleanup: _cleanup, appServerPid: _pid, ...kept } = trace;
process.stdout.write(
  `${sanitize({ ...evidence, deadlineMs, outcomes, cleanup, trace: kept, pass }, { token, root, home: homedir() })}\n`,
);
process.exitCode = pass ? 0 : 1;
