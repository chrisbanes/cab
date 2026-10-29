// Guarded driver for the ADR-1021 skill-plugin and subagent probes. Live steps
// spend model-backed queries, so nothing runs without `--live`.
//   node run.mjs --live init
//   node run.mjs --live <q1|q2|q3|q3-crash|cleanup> --root <dir>
//   node run.mjs <summary|export> --root <dir>
// docs/evidence/skill-plugin-probes-*.md records the run.
import { spawnSync } from "node:child_process";
import {
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  assertCleanupRoot,
  createRoot,
  loadToken,
  queryCount,
  readJson,
  REPO,
  redact,
  redactionContext,
  verifyExit,
} from "../claude-qualification/harness.mjs";
import { cleanup } from "../claude-qualification/run.mjs";
import { run, STEP_FACETS } from "./claude-probes.mjs";

const LIVE_STEPS = ["q1", "q2", "q3", "q3-crash", "cleanup"];

/** Parses the exact grammar above; throws otherwise. */
export function requireLive(args) {
  const [first, second, flag, root, ...rest] = args;
  if (
    (first === "summary" || first === "export") &&
    second === "--root" &&
    flag &&
    root === undefined
  )
    return { step: first, root: flag };
  if (first === "--live" && second === "init" && flag === undefined)
    return { step: "init" };
  if (
    first === "--live" &&
    LIVE_STEPS.includes(second) &&
    flag === "--root" &&
    root &&
    rest.length === 0
  )
    return { step: second, root };
  throw new Error(
    "Refusing skill-plugin probes: use --live init, --live <q1|q2|q3|q3-crash|cleanup> --root <dir>, or summary|export --root <dir>",
  );
}

const text = (command, args) => {
  const result = spawnSync(command, args, { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
};

/** Creates the root and links the checkout's installed SDK, which must match the package.json pin. */
function init() {
  const pinned = readJson(join(REPO, "package.json")).dependencies[
    "@anthropic-ai/claude-agent-sdk"
  ];
  const modules = join(REPO, "node_modules");
  const installed = readJson(
    join(modules, "@anthropic-ai", "claude-agent-sdk", "package.json"),
  );
  if (installed.version !== pinned)
    throw new Error(
      `Installed SDK ${installed.version} differs from the pin ${pinned}; run npm ci`,
    );
  const root = createRoot();
  symlinkSync(modules, join(root, "sdk", "node_modules"));
  const sandbox = spawnSync(
    "/usr/bin/sandbox-exec",
    ["-p", "(version 1)(allow default)", "/usr/bin/true"],
    { encoding: "utf8" },
  );
  writeFileSync(
    join(root, "results", "preflight.json"),
    `${JSON.stringify(
      {
        macos: text("sw_vers", ["-productVersion"]),
        node: process.version,
        npm: text("npm", ["--version"]),
        sdkPin: pinned,
        sdkVersion: installed.version,
        sdkClaudeCodeVersion: installed.claudeCodeVersion ?? null,
        codex: text("codex", ["--version"]),
        tokenPresent: loadToken() !== null,
        nestedSandboxExec: {
          status: sandbox.status,
          stderr: sandbox.stderr.trim().slice(0, 300),
        },
        checkout: text("git", ["-C", REPO, "rev-parse", "HEAD"]),
      },
      null,
      2,
    )}\n`,
  );
  process.stdout.write(`${root}\n`);
}

const results = (root) =>
  Object.fromEntries(
    Object.keys(STEP_FACETS)
      .filter((step) => existsSync(join(root, "results", `${step}.json`)))
      .map((step) => [step, readJson(join(root, "results", `${step}.json`))]),
  );

async function summary(root) {
  const done = results(root);
  for (const [step, ids] of Object.entries(STEP_FACETS)) {
    if (!done[step]) {
      console.log(`${step}: not yet run`);
      continue;
    }
    for (const id of ids) {
      const item = done[step].facets.find((facet) => facet.id === id);
      if (!item) throw new Error(`Result for ${step} omits facet ${id}`);
      console.log(
        `${id} ${item.disposition}${item.reason ? ` (${item.reason})` : ""}`,
      );
    }
  }
  console.log(`model-backed queries: ${queryCount(root)}`);
  let live = 0;
  for (const step of Object.values(done))
    for (const identity of step.identities ?? [])
      if ((await verifyExit(identity)).kind !== "verified") live++;
  console.log(`recorded identities not verified gone: ${live}`);
}

/** Writes every redacted trace line and each step's facets to one evidence file. */
function exportTraces(root) {
  const context = redactionContext(root, loadToken());
  const lines = [];
  for (const name of readdirSync(join(root, "traces")).sort()) {
    if (!name.endsWith(".jsonl")) continue;
    for (const line of readFileSync(join(root, "traces", name), "utf8")
      .split("\n")
      .filter(Boolean))
      lines.push(JSON.stringify(redact(JSON.parse(line), context)));
  }
  for (const [step, { facets, hookLog }] of Object.entries(results(root)))
    lines.push(
      JSON.stringify(
        redact({ event: "facets", step, facets, hookLog }, context),
      ),
    );
  const date = new Date().toISOString().slice(0, 10);
  writeFileSync(
    join(REPO, "docs", "evidence", `skill-plugin-probes-claude-${date}.jsonl`),
    `${lines.join("\n")}\n`,
  );
}

async function main(args) {
  let parsed;
  try {
    parsed = requireLive(args);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(2);
  }
  if (parsed.step === "init") return init();
  assertCleanupRoot(parsed.root);
  if (parsed.step === "summary") return summary(parsed.root);
  if (parsed.step === "export") return exportTraces(parsed.root);
  if (parsed.step === "cleanup") {
    // Unlink the SDK link first so removal can never reach the checkout's node_modules.
    rmSync(join(parsed.root, "sdk", "node_modules"), { force: true });
    return cleanup(parsed.root);
  }
  const facets = await run({
    root: parsed.root,
    token: loadToken(),
    step: parsed.step,
  });
  for (const item of facets)
    console.log(
      `${item.id} ${item.disposition}${item.reason ? ` (${item.reason})` : ""}`,
    );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
  await main(process.argv.slice(2));
