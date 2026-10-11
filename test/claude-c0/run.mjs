// Guarded driver for the #822 Claude Agent SDK probes. See
// docs/evidence/issue-822-claude-sdk-probes-*.md for the recorded run.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  assertCleanupRoot,
  cleanupRoot,
  createRecorder,
  createRoot,
  loadToken,
  probeDisposition,
  queryCount,
  readJson,
  REPO,
  redact,
  redactionContext,
  requireLive,
  returnedToChris,
  summarize,
  terminateExact,
  verifyExit,
} from "./harness.mjs";
import { seedDecoys } from "./p7-isolation.mjs";

const PROBES = {
  p7: "./p7-isolation.mjs",
  p8: "./p8-process.mjs",
  p1: "./p1-p2-session.mjs",
  p3: "./p3-crash.mjs",
  p4: "./p4-mcp.mjs",
  p5: "./p5-policy.mjs",
  p6: "./p6-sandbox.mjs",
};

const text = (command, args, options = {}) => {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  return result.status === 0 ? result.stdout.trim() : null;
};

function init() {
  const root = createRoot();
  const sdkDir = join(root, "sdk");
  const zod = readJson(join(REPO, "package.json")).dependencies.zod;
  const sdkVersion = text("npm", [
    "view",
    "@anthropic-ai/claude-agent-sdk",
    "version",
  ]);
  if (!sdkVersion) throw new Error("npm view did not return an SDK version");
  writeFileSync(join(sdkDir, "package.json"), '{"private":true}\n');
  execFileSync(
    "npm",
    [
      "install",
      "--save-exact",
      "--no-audit",
      "--no-fund",
      `@anthropic-ai/claude-agent-sdk@${sdkVersion}`,
      `zod@${zod}`,
    ],
    { cwd: sdkDir, stdio: ["ignore", process.stderr, process.stderr] },
  );
  const modules = join(sdkDir, "node_modules");
  const lifecycle = [];
  const scan = (dir) => {
    for (const name of existsSync(dir) ? readdirSync(dir) : []) {
      if (name.startsWith(".")) continue;
      if (name.startsWith("@")) scan(join(dir, name));
      else {
        const file = join(dir, name, "package.json");
        if (!existsSync(file)) continue;
        const scripts = readJson(file).scripts ?? {};
        for (const key of ["preinstall", "install", "postinstall"])
          if (scripts[key]) lifecycle.push(`${name}:${key}`);
      }
    }
  };
  scan(modules);
  const installed = readJson(
    join(modules, "@anthropic-ai", "claude-agent-sdk", "package.json"),
  );
  seedDecoys(root);
  const sandbox = spawnSync(
    "/usr/bin/sandbox-exec",
    ["-p", "(version 1)(allow default)", "/usr/bin/true"],
    { encoding: "utf8" },
  );
  const preflight = {
    macos: text("sw_vers", ["-productVersion"]),
    node: process.version,
    npm: text("npm", ["--version"]),
    sdkVersion: installed.version,
    sdkClaudeCodeVersion: installed.claudeCodeVersion ?? null,
    zod,
    lifecycleScripts: lifecycle,
    installedCli: {
      path: "/opt/homebrew/bin/claude",
      version: text("/opt/homebrew/bin/claude", ["--version"]),
    },
    tokenPresent: loadToken() !== null,
    nestedSandboxExec: {
      status: sandbox.status,
      stderr: sandbox.stderr.trim().slice(0, 300),
    },
    checkout: text("git", ["rev-parse", "HEAD"], { cwd: REPO }),
  };
  writeFileSync(
    join(root, "results", "preflight.json"),
    `${JSON.stringify(preflight, null, 2)}\n`,
  );
  process.stdout.write(`${root}\n`);
}

async function loadDeclared() {
  const declared = {};
  for (const [step, path] of Object.entries(PROBES))
    declared[step] = (await import(path)).facetIds;
  return declared;
}

async function summary(root) {
  const declared = await loadDeclared();
  const results = {};
  for (const step of Object.keys(declared)) {
    const file = join(root, "results", `${step}.json`);
    if (existsSync(file)) results[step] = readJson(file);
  }
  const present = Object.fromEntries(
    Object.entries(declared).filter(([step]) => results[step]),
  );
  const rows = summarize(results, present);
  const all = rows.flatMap((row) => row.facets);
  for (let probe = 1; probe <= 8; probe++) {
    const facets = all.filter((item) => item.id.startsWith(`F${probe}.`));
    if (!facets.length) continue;
    console.log(`probe ${probe}: ${probeDisposition(facets)}`);
    for (const item of facets)
      console.log(
        `  ${item.id}${item.adr ? " [ADR]" : " [I]"} ${item.disposition}${item.reason ? ` (${item.reason})` : ""}`,
      );
  }
  const missing = Object.keys(declared).filter((step) => !results[step]);
  if (missing.length) console.log(`not yet run: ${missing.join(", ")}`);
  const returned = returnedToChris(all);
  console.log(
    `returned to Chris: ${returned.length ? returned.map((item) => item.id).join(", ") : "none"}`,
  );
  console.log(`model-backed queries: ${queryCount(root)}`);
  const live = [];
  for (const step of Object.keys(results))
    for (const identity of results[step].identities ?? [])
      if ((await verifyExit(identity)).kind !== "verified")
        live.push(identity.processId);
  console.log(`recorded identities not verified gone: ${live.length}`);
}

/** Copies each redacted trace, plus its step's facets, into docs/evidence. */
function exportTraces(root) {
  const context = redactionContext(root, loadToken());
  const date = new Date().toISOString().slice(0, 10);
  for (const name of readdirSync(join(root, "traces"))) {
    if (!name.endsWith(".jsonl")) continue;
    const step = name.slice(0, -".jsonl".length);
    const lines = readFileSync(join(root, "traces", name), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.stringify(redact(JSON.parse(line), context)));
    const result = join(root, "results", `${step}.json`);
    if (existsSync(result)) {
      const { facets, hookLog } = readJson(result);
      lines.push(
        JSON.stringify(
          redact(
            { event: "facets", step, facets, ...(hookLog ? { hookLog } : {}) },
            context,
          ),
        ),
      );
    }
    writeFileSync(
      join(
        REPO,
        "docs",
        "evidence",
        `issue-822-claude-sdk-probes-${step}-${date}.jsonl`,
      ),
      `${lines.join("\n")}\n`,
    );
  }
}

async function cleanup(root) {
  assertCleanupRoot(root);
  const recorder = createRecorder(root, "cleanup", null);
  let survivors = 0;
  for (const name of readdirSync(join(root, "results"))) {
    if (!name.endsWith(".json")) continue;
    for (const identity of readJson(join(root, "results", name)).identities ??
      []) {
      if ((await verifyExit(identity)).kind === "verified") continue;
      survivors++;
      await terminateExact(identity, recorder, `cleanup:${name}`);
    }
  }
  console.error(`cleanup: ${survivors} survivor(s) handled`);
  cleanupRoot(root);
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
  const root = parsed.root;
  assertCleanupRoot(root);
  if (parsed.step === "summary") return summary(root);
  if (parsed.step === "export") return exportTraces(root);
  if (parsed.step === "cleanup") return cleanup(root);
  const module = await import(PROBES[parsed.step]);
  const facets = await module.run({ root, token: loadToken() });
  console.log(`${parsed.step}: ${probeDisposition(facets)}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
  await main(process.argv.slice(2));
