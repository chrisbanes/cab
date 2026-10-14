import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  claudeTokenCheckSchema,
  readinessCheckIds,
  readinessSchema,
} from "../../src/operator/readiness.js";
import {
  Readiness,
  type ReadinessDeps,
  type ReadinessProfile,
  serviceReadiness,
} from "../../src/standalone/readiness.js";
import type { StandaloneService } from "../../src/standalone/service.js";
import {
  assertCanonicalDirectoryPath,
  assertExistingCanonicalDirectoryPath,
} from "../../src/standalone/data-directory.js";
import { tmpdir } from "../fixtures/temp.js";

const TOKEN = "canary-readiness-token-4417";
const ENV_NAME = "CANARY_READINESS_VARIABLE_4417";
const uid = process.getuid?.();

type Fixture = { root: string; bin: string; data: string; auth: string };

function fixture(t: { after: (fn: () => void) => void }): Fixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ensemble-ready-")));
  chmodSync(root, 0o700);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, "bin");
  const data = join(root, "data");
  mkdirSync(bin, { mode: 0o700 });
  mkdirSync(data, { mode: 0o700 });
  for (const name of ["codex", "git"])
    writeFileSync(join(bin, name), "#!/bin/sh\n", { mode: 0o755 });
  const auth = join(root, "auth.json");
  writeFileSync(auth, "{}", { mode: 0o600 });
  return { root, bin, data, auth };
}

const claudeSettings = {
  models: [{ model: "sonnet", efforts: ["low", "high"] }],
};
const claude = (model: string | null, effort: string | null = null) =>
  ({ harness: "claude", model, reasoningEffort: effort }) as const;

function deps(f: Fixture, over: Partial<ReadinessDeps> = {}): ReadinessDeps {
  return {
    env: { PATH: f.bin },
    uid,
    dataDir: f.data,
    authFile: f.auth,
    codexLogin: async () => "verified",
    discovery: async () => ({ configured: false, available: false }),
    claudeTokenReference: () => null,
    claudeTokenStatus: () => ({ state: "not-configured" }),
    harnessStatuses: () => [
      { harness: "codex", state: "available" },
      { harness: "claude", state: "not-configured" },
    ],
    harnessSettings: () => null,
    profiles: () => [],
    now: () => 1234,
    timeoutMs: 25,
    ...over,
  };
}

async function check(
  f: Fixture,
  id: (typeof readinessCheckIds)[number],
  over: Partial<ReadinessDeps> = {},
) {
  const { data } = await new Readiness(deps(f, over)).read();
  const found = data.checks.find((c) => c.id === id);
  assert.ok(found);
  return found;
}

const REJECTED = (n: number) =>
  `${n} ${n === 1 ? "profile uses" : "profiles use"} a model or reasoning effort the runtime does not accept`;
const profiles = (...p: ReadinessProfile[]) => ({ profiles: () => p });
const codexProfile = (): ReadinessProfile => ({
  revoked: false,
  runtime: { harness: "codex" },
});

test("codex and git pass when an executable regular file is on the service PATH", async (t) => {
  const f = fixture(t);
  for (const id of ["codex-executable", "git"] as const) {
    const result = await check(f, id);
    assert.equal(result.status, "pass");
    assert.equal(result.reason, null);
    assert.equal(result.fix, null);
  }
});

test("codex and git fail with the contract fix when missing, not executable or not a file", async (t) => {
  const f = fixture(t);
  rmSync(join(f.bin, "codex"));
  chmodSync(join(f.bin, "git"), 0o644);
  const codex = await check(f, "codex-executable");
  assert.equal(codex.status, "fail");
  assert.equal(codex.fix, "Install Codex into the fixed PATH");
  const git = await check(f, "git");
  assert.equal(git.status, "fail");
  assert.equal(git.fix, "Install git");

  mkdirSync(join(f.bin, "codex"));
  assert.equal((await check(f, "codex-executable")).status, "fail");
  assert.equal(
    (await check(f, "codex-executable", { env: {} })).status,
    "fail",
    "an unset PATH finds nothing",
  );
  assert.equal(
    (await check(f, "git", { env: { PATH: `relative:${join(f.bin, "x")}` } }))
      .status,
    "fail",
    "relative PATH entries are not searched",
  );
});

/** A fixture `claude` whose body is a shell script; the version probe runs it for real. */
function installClaude(f: Fixture, body: string) {
  writeFileSync(join(f.bin, "claude"), `#!/bin/sh\n${body}\n`, {
    mode: 0o755,
  });
}
const claudeExecutable = (f: Fixture, over: Partial<ReadinessDeps> = {}) =>
  check(f, "claude-executable", { versionTimeoutMs: 1000, ...over });
const MISSING = {
  reason: "Claude Code is not on the service PATH",
  fix: "Install Claude Code into the fixed PATH, then restart the service",
};
const UNRUNNABLE = {
  reason: "Claude Code did not report a version",
  fix: "Run `claude --version` as the service user, or reinstall Claude Code, then restart the service",
};

test("a runnable claude passes with its version in the label and no path anywhere", async (t) => {
  const f = fixture(t);
  installClaude(f, 'echo "2.1.296 (Claude Code)"');
  const result = await claudeExecutable(f);
  assert.equal(result.status, "pass");
  assert.equal(result.label, "Claude executable (2.1.296)");
  assert.equal(result.reason, null);
  assert.equal(result.fix, null);
  assert.ok(!JSON.stringify(result).includes(f.bin));
});

test("the claude version is reported and never compared", async (t) => {
  const f = fixture(t);
  for (const [printed, version] of [
    ["0.0.1 (Claude Code)", "0.0.1"],
    ["99.9.9", "99.9.9"],
    ["3.0.0-beta.1+build5 (Claude Code)", "3.0.0-beta.1+build5"],
  ] as const) {
    installClaude(f, `echo "${printed}"`);
    const result = await claudeExecutable(f);
    assert.equal(result.status, "pass", printed);
    assert.equal(result.label, `Claude executable (${version})`);
  }
});

test("a missing claude is not configured while Claude is unused and fails once it is needed", async (t) => {
  const f = fixture(t);
  const unused = await claudeExecutable(f);
  assert.equal(unused.status, "not-configured");
  assert.equal(unused.label, "Claude executable");
  assert.equal(unused.reason, MISSING.reason);
  assert.equal(unused.fix, MISSING.fix);
  assert.equal(
    (await claudeExecutable(f, profiles(codexProfile()))).status,
    "not-configured",
    "a Codex-only host shows no red row",
  );
  assert.equal(
    (
      await claudeExecutable(
        f,
        profiles({ revoked: true, runtime: claude(null) }),
      )
    ).status,
    "not-configured",
    "a revoked Claude profile does not need it",
  );
  for (const over of [
    { claudeTokenReference: () => "file:/x" },
    profiles({ revoked: false, runtime: claude(null) }),
    {
      profiles: () => {
        throw new Error("unreadable");
      },
    },
  ]) {
    const needed = await claudeExecutable(f, over);
    assert.equal(needed.status, "fail");
    assert.equal(needed.label, "Claude executable");
    assert.equal(needed.reason, MISSING.reason);
    assert.equal(needed.fix, MISSING.fix);
  }
});

test("a claude that does not print a version fails as not runnable", async (t) => {
  const f = fixture(t);
  for (const [body, over] of [
    ["echo hello", {}],
    ["exit 1", {}],
    ["", {}],
    ['echo "v2.1.296"', {}],
    ['echo "11111111111.2.3"', {}],
    ["exec /bin/sleep 30", { versionTimeoutMs: 200 }],
  ] as const) {
    installClaude(f, body);
    const result = await claudeExecutable(f, over);
    assert.equal(result.status, "fail", body);
    assert.equal(result.label, "Claude executable");
    assert.equal(result.reason, UNRUNNABLE.reason);
    assert.equal(result.fix, UNRUNNABLE.fix);
  }
});

test("a claude that ignores SIGTERM is killed, and the check settles only after it has exited", async (t) => {
  const f = fixture(t);
  const pidFile = join(f.root, "pid");
  // Ignored signals stay ignored across exec, so the long sleep is the process that traps SIGTERM.
  installClaude(f, `trap '' TERM\necho $$ > "${pidFile}"\nexec /bin/sleep 30`);
  const result = await claudeExecutable(f, { versionTimeoutMs: 1000 });
  const pid = Number(readFileSync(pidFile, "utf8"));
  assert.ok(pid > 1);
  try {
    assert.equal(result.status, "fail");
    assert.equal(result.reason, UNRUNNABLE.reason);
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  } finally {
    // Only a regression leaves it running; the fixture root, and the pid file, outlive this.
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone, which is what the test expects.
    }
  }
});

test("a claude that exits while a descendant keeps its output open still settles the check", async (t) => {
  const f = fixture(t);
  installClaude(f, "/bin/sleep 3 &\nexit 0");
  const started = Date.now();
  const result = await claudeExecutable(f, { versionTimeoutMs: 200 });
  assert.equal(result.status, "fail");
  assert.ok(Date.now() - started < 1500);
});

test("a claude whose child outlives the timeout still settles the check", async (t) => {
  const f = fixture(t);
  installClaude(f, "/bin/sleep 2 &\nwait");
  const started = Date.now();
  const result = await claudeExecutable(f, { versionTimeoutMs: 200 });
  assert.equal(result.status, "fail");
  assert.ok(Date.now() - started < 1500);
});

test("the claude version probe sees the PATH and nothing else of the service environment", async (t) => {
  const f = fixture(t);
  const seen = join(f.root, "seen");
  installClaude(f, `echo "\${${ENV_NAME}-unset}" > "${seen}"\necho 2.1.296`);
  const result = await claudeExecutable(f, {
    env: { PATH: f.bin, [ENV_NAME]: "leaked" },
  });
  assert.equal(result.status, "pass");
  assert.equal(readFileSync(seen, "utf8").trim(), "unset");
});

test("codex login passes when verified and fails otherwise with the login fix", async (t) => {
  const f = fixture(t);
  assert.equal((await check(f, "codex-login")).status, "pass");
  const cases: [string, ReadinessDeps["codexLogin"]][] = [
    ["failed", async () => "failed"],
    ["unavailable", async () => "unavailable"],
    ["rejects", async () => Promise.reject(new Error(`boom ${TOKEN}`))],
    ["never settles", () => new Promise(() => {})],
  ];
  for (const [name, codexLogin] of cases) {
    const result = await check(f, "codex-login", { codexLogin });
    assert.equal(result.status, "fail", name);
    assert.equal(result.fix, "Run `codex login` as the service user", name);
    assert.ok(!JSON.stringify(result).includes(TOKEN), name);
  }
});

test("a Codex policy mismatch is not reported as a missing login", async (t) => {
  const f = fixture(t);
  const result = await check(f, "codex-login", {
    codexLogin: async () => "policy",
  });
  assert.equal(result.status, "fail");
  assert.doesNotMatch(
    `${result.reason} ${result.fix}`,
    /signed in|codex login/i,
  );
  assert.match(result.fix ?? "", /approval policy/);
});

test("github discovery is not configured, readable or failing", async (t) => {
  const f = fixture(t);
  const discovery = (configured: boolean, available: boolean) => async () => ({
    configured,
    available,
    source: configured ? ("gh" as const) : null,
    gh: configured
      ? { state: "signed-in" as const, login: "octo" }
      : { state: "not-signed-in" as const },
  });
  const none = await check(f, "github-discovery");
  assert.equal(none.status, "not-configured");
  assert.ok(none.fix);
  assert.equal(
    (await check(f, "github-discovery", { discovery: discovery(true, true) }))
      .status,
    "pass",
  );
  const failing = await check(f, "github-discovery", {
    discovery: discovery(true, false),
  });
  assert.equal(failing.status, "fail");
  assert.equal(
    failing.fix,
    "Run `gh auth login`, or Settings → discovery credential",
  );
  for (const discoveryFailure of [
    async () => Promise.reject(new Error(TOKEN)),
    () => new Promise<never>(() => {}),
  ]) {
    const result = await check(f, "github-discovery", {
      discovery: discoveryFailure,
    });
    assert.equal(result.status, "fail");
    assert.ok(!JSON.stringify(result).includes(TOKEN));
  }
});

test("service discovery probes gh only for a gh reference", async (t) => {
  const f = fixture(t);
  const variable = "ENSEMBLE_READINESS_DISCOVERY_TEST";
  let ref: string | null = null;
  let probes = 0;
  const service = {
    verifyCodexLogin: async () => "verified",
    domain: () => ({
      discoveryCredentialReference: () => ref,
      claudeTokenReference: () => null,
      profiles: () => [],
    }),
    claudeTokenStatus: () => ({ state: "not-configured" }),
    harnessStatuses: () => [],
    harnessSettings: () => null,
  } as unknown as StandaloneService;
  const api = {
    readDiscoveryStatus: async () => {
      probes++;
      return {
        data: { configured: true, available: true, source: "gh" as const },
      };
    },
  } as never;
  const discovery = async () =>
    (
      await serviceReadiness(service, api, {
        dataDir: f.data,
        authFile: f.auth,
      }).read()
    ).data.checks.find((c) => c.id === "github-discovery")?.status;
  assert.equal(await discovery(), "not-configured");
  ref = `env:${variable}`;
  assert.equal(await discovery(), "fail");
  process.env[variable] = "set";
  t.after(() => delete process.env[variable]);
  assert.equal(await discovery(), "pass");
  assert.equal(probes, 0);
  ref = "gh:github.com";
  assert.equal(await discovery(), "pass");
  assert.equal(probes, 1);
});

test("the Claude token check reports each reference state without path or value", async (t) => {
  const f = fixture(t);
  const tokenPath = join(f.root, "claude-token");
  const withFile = (mode: number, over: Partial<ReadinessDeps> = {}) => {
    writeFileSync(tokenPath, `${TOKEN}\n`, { mode });
    chmodSync(tokenPath, mode);
    return {
      claudeTokenReference: () => `file:${tokenPath}`,
      claudeTokenStatus: () => ({ state: "missing-value" as const }),
      ...over,
    };
  };

  const none = await check(f, "claude-token");
  assert.equal(none.status, "not-configured");

  const readable = await check(
    f,
    "claude-token",
    withFile(0o600, { claudeTokenStatus: () => ({ state: "available" }) }),
  );
  assert.equal(readable.status, "pass");

  const open = await check(f, "claude-token", withFile(0o644));
  assert.equal(open.status, "fail");
  assert.equal(open.reason, "Token file permits group or other access");
  assert.ok(open.fix?.includes("Add Claude"));

  rmSync(tokenPath);
  const missing = await check(f, "claude-token", {
    claudeTokenReference: () => `file:${tokenPath}`,
    claudeTokenStatus: () => ({ state: "missing-value" }),
  });
  assert.equal(missing.reason, "Token file is missing");

  const target = join(f.root, "real-token");
  writeFileSync(target, TOKEN, { mode: 0o600 });
  symlinkSync(target, tokenPath);
  const link = await check(f, "claude-token", {
    claudeTokenReference: () => `file:${tokenPath}`,
    claudeTokenStatus: () => ({ state: "missing-value" }),
  });
  assert.equal(link.reason, "Token file is a symbolic link");

  const env = {
    claudeTokenReference: () => `env:${ENV_NAME}`,
  };
  const unset = await check(f, "claude-token", {
    ...env,
    claudeTokenStatus: () => ({ state: "missing-value" }),
  });
  assert.equal(unset.reason, "Token variable is unavailable");
  const restart = await check(f, "claude-token", {
    ...env,
    claudeTokenStatus: () => ({ state: "restart-required" }),
  });
  assert.equal(restart.reason, "Restart the service to use this variable");
  assert.equal(restart.fix, "Restart the service");
  const fileRestart = await check(f, "claude-token", {
    claudeTokenReference: () => `file:${tokenPath}`,
    claudeTokenStatus: () => ({ state: "restart-required" }),
  });
  assert.equal(fileRestart.reason, "Restart the service to use this token");

  for (const result of [open, missing, link, unset, restart, fileRestart]) {
    const text = JSON.stringify(result);
    for (const secret of [TOKEN, ENV_NAME, tokenPath, f.root])
      assert.ok(!text.includes(secret), secret);
  }
});

test("the runtime harness check follows the profiles in use", async (t) => {
  const f = fixture(t);
  const claudeUp = [
    { harness: "codex", state: "available" },
    { harness: "claude", state: "available" },
  ] as const;
  const harness = (over: Partial<ReadinessDeps>) =>
    check(f, "runtime-harness", over);

  const none = await harness({});
  assert.equal(none.status, "not-configured");
  assert.equal(
    (await harness(profiles({ ...codexProfile(), revoked: true }))).status,
    "not-configured",
    "revoked profiles are ignored",
  );

  assert.equal((await harness(profiles(codexProfile()))).status, "pass");

  const down = await harness({
    ...profiles(codexProfile()),
    harnessStatuses: () => [
      { harness: "codex", state: "unavailable" },
      { harness: "claude", state: "not-configured" },
    ],
  });
  assert.equal(down.status, "fail");
  assert.match(down.fix ?? "", /^Restart the service/);

  const claudeProfile = (runtime = claude("sonnet", "high")) => ({
    revoked: false,
    runtime,
  });
  const withClaude = (...p: ReadinessProfile[]) => ({
    ...profiles(...p),
    harnessStatuses: () => [...claudeUp],
    harnessSettings: () => claudeSettings,
  });
  assert.equal((await harness(withClaude(claudeProfile()))).status, "pass");
  assert.equal(
    (await harness(withClaude(claudeProfile(claude(null))))).status,
    "fail",
    "the default model is only accepted when the runtime lists it",
  );

  const badModel = await harness(withClaude(claudeProfile(claude("opus"))));
  assert.equal(badModel.status, "fail");
  assert.equal(badModel.reason, REJECTED(1));
  const badEffort = await harness(
    withClaude(claudeProfile(claude("sonnet", "max"))),
  );
  assert.equal(badEffort.reason, REJECTED(1));

  assert.equal(
    (
      await harness(
        withClaude(codexProfile(), {
          ...claudeProfile(claude("opus")),
          revoked: true,
        }),
      )
    ).status,
    "pass",
    "a revoked Claude profile is ignored",
  );

  const unknown = await harness({
    ...withClaude(claudeProfile()),
    harnessSettings: () => null,
  });
  assert.equal(unknown.status, "fail");
  assert.equal(unknown.reason, "Claude's supported models are not known yet");
  assert.match(unknown.fix ?? "", /^Run a Claude task/);

  // A runtime that failed is restarted; one that is not enabled is installed, never restarted.
  const states = (claudeState: "unavailable" | "not-configured") => ({
    ...withClaude(claudeProfile()),
    harnessStatuses: () => [
      { harness: "codex" as const, state: "available" as const },
      { harness: "claude" as const, state: claudeState },
    ],
  });
  const notRunning = await harness(states("unavailable"));
  assert.equal(notRunning.status, "fail");
  assert.equal(notRunning.reason, "Claude runtime is not running");
  assert.equal(
    notRunning.fix,
    "Restart the service, or edit the profile's model or reasoning effort",
  );
  const notEnabled = await harness(states("not-configured"));
  assert.equal(notEnabled.status, "fail");
  assert.equal(
    notEnabled.reason,
    "Claude runtime is not enabled on this service",
  );
  assert.equal(notEnabled.fix, MISSING.fix);
  assert.doesNotMatch(notEnabled.fix ?? "", /^Restart/);
  // Both at once: the failed runtime still calls for the restart.
  const both = await harness({
    ...withClaude(codexProfile(), claudeProfile()),
    harnessStatuses: () => [
      { harness: "codex" as const, state: "unavailable" as const },
      { harness: "claude" as const, state: "not-configured" as const },
    ],
  });
  assert.equal(
    both.reason,
    "Codex runtime is not running; Claude runtime is not enabled on this service",
  );
  assert.match(both.fix ?? "", /^Restart the service/);
});

test("the data and auth paths check names the rule, not the path", async (t) => {
  const f = fixture(t);
  assert.equal((await check(f, "data-paths")).status, "pass");

  chmodSync(f.data, 0o755);
  const open = await check(f, "data-paths");
  assert.equal(open.status, "fail");
  assert.equal(
    open.reason,
    "Data directory must not permit group or other access",
  );
  chmodSync(f.data, 0o700);

  chmodSync(f.auth, 0o644);
  const mode = await check(f, "data-paths");
  assert.equal(mode.reason, "Operator auth file must have mode 600");
  chmodSync(f.auth, 0o600);

  const real = join(f.root, "real");
  mkdirSync(real, { mode: 0o700 });
  const link = join(f.root, "link");
  symlinkSync(real, link);
  const linked = await check(f, "data-paths", { dataDir: link });
  assert.equal(linked.status, "fail");
  assert.match(linked.reason ?? "", /^Data directory must be an absolute/);

  const authLink = join(f.root, "auth-link.json");
  symlinkSync(f.auth, authLink);
  assert.equal(
    (await check(f, "data-paths", { authFile: authLink })).status,
    "fail",
  );
  assert.equal((await check(f, "data-paths", { authFile: "" })).status, "fail");
  assert.equal(
    (await check(f, "data-paths", { dataDir: join(f.root, "missing") })).status,
    "fail",
  );
  assert.equal(
    (await check(f, "data-paths", { uid: (uid ?? 0) + 1 })).status,
    "fail",
    "files owned by another user fail",
  );

  for (const result of [open, mode, linked])
    for (const path of [f.root, f.data, f.auth, link])
      assert.ok(!JSON.stringify(result).includes(path));
});

test("read returns all eight checks in fixed order and parses with the shared schema", async (t) => {
  const f = fixture(t);
  const result = await new Readiness(deps(f)).read();
  assert.deepEqual(
    result.data.checks.map((c) => c.id),
    [...readinessCheckIds],
  );
  assert.deepEqual(readinessSchema.parse(result), result);
  assert.equal(result.observedAt, 1234);
  for (const c of result.data.checks)
    assert.equal(c.status === "pass", c.fix === null && c.reason === null);

  const token = await new Readiness(deps(f)).claudeToken();
  assert.equal(token.data.id, "claude-token");
  assert.deepEqual(claudeTokenCheckSchema.parse(token), token);
});

test("failing profiles are counted, never named, and stay inside the schema", async (t) => {
  const f = fixture(t);
  const claudeUp = [
    { harness: "codex", state: "available" },
    { harness: "claude", state: "available" },
  ] as const;
  const wrong = (): ReadinessProfile => ({
    revoked: false,
    runtime: claude("not-a-model"),
  });
  const run = async (count: number) => {
    const { data } = await new Readiness(
      deps(f, {
        harnessStatuses: () => [...claudeUp],
        harnessSettings: () => claudeSettings,
        profiles: () => Array.from({ length: count }, wrong),
      }),
    ).read();
    return data.checks;
  };
  for (const count of [1, 2, 20]) {
    const checks = await run(count);
    const harness = checks.find((c) => c.id === "runtime-harness");
    assert.equal(harness?.status, "fail");
    assert.equal(harness?.reason, REJECTED(count));
    assert.equal(checks.length, 8, "the other checks are unaffected");
  }
});

test("an invalid check result degrades to that check's failure, not a failed read", async (t) => {
  const f = fixture(t);
  const { data } = await new Readiness(
    deps(f, { codexLogin: async () => "weird" as never }),
  ).read();
  assert.equal(data.checks.length, 8);
  assert.equal(
    data.checks.filter((c) => c.status === "pass").length >= 3,
    true,
  );
});

test("a throwing dependency fails that check only, without its message", async (t) => {
  const f = fixture(t);
  const { data } = await new Readiness(
    deps(f, {
      profiles: () => {
        throw new Error(`secret ${TOKEN}`);
      },
    }),
  ).read();
  const harness = data.checks.find((c) => c.id === "runtime-harness");
  assert.equal(harness?.status, "fail");
  assert.ok(!JSON.stringify(data).includes(TOKEN));
  assert.equal(data.checks.filter((c) => c.status === "pass").length, 4);
});

test("the shared schema rejects a pass with a fix and a failure without one", () => {
  const base = { id: "git", label: "Git", observedAt: 0 };
  const parse = (status: string, reason: string | null, fix: string | null) =>
    readinessSchema.safeParse({
      data: {
        checks: readinessCheckIds.map((id) => ({
          id,
          label: base.label,
          status: id === "git" ? status : "pass",
          reason: id === "git" ? reason : null,
          fix: id === "git" ? fix : null,
        })),
      },
      observedAt: 0,
    }).success;
  assert.equal(parse("pass", null, null), true);
  assert.equal(parse("fail", "No", "Install git"), true);
  assert.equal(parse("pass", null, "Install git"), false);
  assert.equal(parse("fail", "No", null), false);
  assert.equal(parse("unknown", "No", "x"), false);
});

function snapshot(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const s = statSync(path);
      out.push(`${path} ${s.mode} ${s.mtimeMs} ${s.size}`);
      if (s.isDirectory()) walk(path);
    }
  };
  walk(root);
  return out;
}

test("running the checks changes nothing on disk and leaks no canary", async (t) => {
  const f = fixture(t);
  const tokenPath = join(f.root, "claude-token");
  writeFileSync(tokenPath, TOKEN, { mode: 0o644 });
  chmodSync(tokenPath, 0o644);
  chmodSync(f.data, 0o755);
  const before = snapshot(f.root);
  const failing = deps(f, {
    env: { PATH: join(f.root, "none") },
    codexLogin: async () => "failed",
    claudeTokenReference: () => `file:${tokenPath}`,
    claudeTokenStatus: () => ({ state: "missing-value" }),
    ...profiles(codexProfile()),
  });
  const readiness = new Readiness(failing);
  const first = await readiness.read();
  assert.deepEqual(await readiness.read(), first, "no cache, same answer");
  assert.deepEqual(snapshot(f.root), before);
  const text = JSON.stringify(first);
  for (const canary of [TOKEN, tokenPath, f.root, f.data, f.auth, f.bin])
    assert.ok(!text.includes(canary), canary);
  assert.ok(
    first.data.checks.filter((c) => c.status === "fail").length >= 4,
    "the scenario exercises the failure paths",
  );
});

test("the data path check keeps the canonical-path semantics without blocking the loop", async (t) => {
  const f = fixture(t);
  const real = join(f.root, "real");
  mkdirSync(real, { mode: 0o700 });
  symlinkSync(real, join(f.root, "link"));
  writeFileSync(join(f.root, "file"), "");
  const cases = [
    f.data,
    join(f.root, "link"),
    join(f.root, "link", "child"),
    join(f.root, "file", "child"),
    join(f.root, "missing"),
    join(f.root, "missing", "child"),
    `${f.root}/data/../data`,
    "relative/path",
    "",
  ];
  for (const path of cases) {
    let sync: boolean;
    try {
      assertCanonicalDirectoryPath(path, "Path");
      sync = true;
    } catch {
      sync = false;
    }
    let async: boolean;
    try {
      await assertExistingCanonicalDirectoryPath(path, "Path");
      async = true;
    } catch {
      async = false;
    }
    // A missing final component is allowed by neither variant without `missing`.
    assert.equal(async, sync, path);
    assert.equal(
      (await check(f, "data-paths", { dataDir: path })).status === "pass",
      sync && path === f.data,
      path,
    );
  }
  // The readiness module has no synchronous filesystem calls on its request path.
  const source = readFileSync(
    join(import.meta.dirname, "../../../src/standalone/readiness.ts"),
    "utf8",
  );
  assert.doesNotMatch(source, /[A-Za-z]Sync\(|assertCanonicalDirectoryPath/);
});
