import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  accessSync,
  chmodSync,
  constants as fsConstants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { diagnosticLimitsFromEnv } from "../../src/standalone/execution-diagnostics.js";
import {
  assertNotRoot,
  ROOT_REFUSAL,
  renderLaunchAgent,
  writeLaunchAgent,
  type LaunchAgentConfiguration,
} from "../../src/standalone/launchd.js";

function createFixture(): {
  root: string;
  configuration: LaunchAgentConfiguration;
} {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ensemble-launchd-")));
  chmodSync(root, 0o700);
  const dataDirectory = join(root, "private & <data>");
  const authDirectory = join(root, "auth");
  const logs = join(root, "logs");
  mkdirSync(dataDirectory, { mode: 0o700 });
  mkdirSync(authDirectory, { mode: 0o700 });
  mkdirSync(logs, { mode: 0o700 });
  const authFile = join(authDirectory, "operator-auth.json");
  writeFileSync(authFile, "{}\n", { mode: 0o600 });
  const cliPath = resolve("dist/src/standalone/cli.js");
  return {
    root,
    configuration: {
      label: "com.example.ensemble.disposable",
      nodePath: process.execPath,
      cliPath,
      dataDirectory,
      authFile,
      origin: "http://127.0.0.1:28787",
      port: 28787,
      stdoutPath: join(logs, "stdout & <operator>.log"),
      stderrPath: join(logs, "stderr.log"),
    },
  };
}

function lintPlistIfAvailable(
  plistPath: string,
  environment: {
    platform: NodeJS.Platform;
    executablePath: string;
  } = { platform: process.platform, executablePath: "/usr/bin/plutil" },
): boolean {
  if (environment.platform !== "darwin") return false;
  try {
    accessSync(environment.executablePath, fsConstants.X_OK);
  } catch {
    return false;
  }
  execFileSync(environment.executablePath, ["-lint", plistPath], {
    encoding: "utf8",
  });
  return true;
}

test("native plist lint requires macOS and an available executable", () => {
  const fixture = createFixture();
  try {
    const plistPath = join(fixture.root, "not-created.plist");
    assert.equal(
      lintPlistIfAvailable(plistPath, {
        platform: "linux",
        executablePath: "/usr/bin/false",
      }),
      false,
    );
    assert.equal(
      lintPlistIfAvailable(plistPath, {
        platform: "darwin",
        executablePath: join(fixture.root, "missing-plutil"),
      }),
      false,
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function assertLaunchAgentFields(
  plist: string,
  configuration: LaunchAgentConfiguration,
): void {
  const argumentsXml = [
    configuration.nodePath,
    configuration.cliPath,
    "operator",
    configuration.dataDirectory,
    String(configuration.port),
  ]
    .map((value) => `    <string>${xmlEscape(value)}</string>`)
    .join("\n");
  const environmentXml = Object.entries({
    PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
    ENSEMBLE_OPERATOR_AUTH_FILE: configuration.authFile,
    ENSEMBLE_OPERATOR_ORIGIN: configuration.origin,
  })
    .map(
      ([key, value]) =>
        `    <key>${key}</key>\n    <string>${xmlEscape(value)}</string>`,
    )
    .join("\n");
  const expectedFields = [
    `  <key>Label</key>\n  <string>${xmlEscape(configuration.label)}</string>`,
    `  <key>ProgramArguments</key>\n  <array>\n${argumentsXml}\n  </array>`,
    `  <key>EnvironmentVariables</key>\n  <dict>\n${environmentXml}\n  </dict>`,
    `  <key>StandardOutPath</key>\n  <string>${xmlEscape(configuration.stdoutPath)}</string>`,
    `  <key>StandardErrorPath</key>\n  <string>${xmlEscape(configuration.stderrPath)}</string>`,
    "  <key>RunAtLoad</key>\n  <true/>",
    "  <key>KeepAlive</key>\n  <false/>",
  ];

  for (const field of expectedFields) {
    assert.ok(plist.includes(field), `plist must include ${field}`);
  }
}

test("LaunchAgent renders exact private operator arguments and writes exclusively", () => {
  const fixture = createFixture();
  const plistPath = join(fixture.root, `${fixture.configuration.label}.plist`);
  try {
    const plist = renderLaunchAgent(fixture.configuration);
    writeLaunchAgent(fixture.configuration, plistPath);
    assert.equal(readFileSync(plistPath, "utf8"), plist);
    assert.equal(statSync(plistPath).mode & 0o777, 0o600);
    assert.throws(() => writeLaunchAgent(fixture.configuration, plistPath));
    assert.equal(existsSync(plistPath), true);

    lintPlistIfAvailable(plistPath);
    assertLaunchAgentFields(
      readFileSync(plistPath, "utf8"),
      fixture.configuration,
    );
    assert.equal(plist.includes("password"), false);
    assert.equal(plist.includes("/bin/sh"), false);
    assert.equal(plist.includes("launchctl"), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("LaunchAgent rejects unsafe identities, paths, origins, ports, and system targets", () => {
  const fixture = createFixture();
  const { configuration } = fixture;
  try {
    const bad = (change: Partial<LaunchAgentConfiguration>) =>
      renderLaunchAgent({ ...configuration, ...change });
    assert.throws(() => bad({ label: "../../system" }));
    assert.throws(() => bad({ nodePath: "relative/node" }));
    assert.throws(() => bad({ origin: "http://example.com:28787" }));
    assert.throws(() => bad({ origin: "https://user:pass@example.com" }));
    assert.throws(() => bad({ port: 65_536 }));
    assert.throws(() => bad({ port: 0 }));
    assert.throws(() => bad({ stderrPath: configuration.stdoutPath }));
    assert.throws(() => bad({ stdoutPath: configuration.authFile }));

    const symlinkNode = join(fixture.root, "node-link");
    symlinkSync(configuration.nodePath, symlinkNode);
    assert.throws(() => bad({ nodePath: symlinkNode }));

    const symlinkData = join(fixture.root, "data-link");
    symlinkSync(configuration.dataDirectory, symlinkData);
    assert.throws(() => bad({ dataDirectory: symlinkData }));

    const symlinkAuth = join(fixture.root, "auth-link");
    symlinkSync(configuration.authFile, symlinkAuth);
    assert.throws(() => bad({ authFile: symlinkAuth }));

    const symlinkLogs = join(fixture.root, "log-link");
    symlinkSync(dirname(configuration.stdoutPath), symlinkLogs);
    assert.throws(() => bad({ stdoutPath: join(symlinkLogs, "stdout.log") }));

    assert.throws(() =>
      writeLaunchAgent(
        configuration,
        "/Library/LaunchDaemons/com.example.ensemble.plist",
      ),
    );
    assert.throws(() =>
      writeLaunchAgent(
        configuration,
        "/Library/LaunchAgents/com.example.ensemble.plist",
      ),
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("operations CLI renders a private LaunchAgent without echoing paths", () => {
  const fixture = createFixture();
  const { configuration } = fixture;
  const plistPath = join(fixture.root, `${configuration.label}.plist`);
  const npmCli = process.env.npm_execpath;
  assert.ok(npmCli, "launchd CLI test must run from npm");
  try {
    const result = spawnSync(
      process.execPath,
      [
        npmCli,
        "run",
        "operations",
        "--",
        "render-launch-agent",
        configuration.label,
        configuration.nodePath,
        configuration.cliPath,
        configuration.dataDirectory,
        configuration.authFile,
        configuration.origin,
        String(configuration.port),
        configuration.stdoutPath,
        configuration.stderrPath,
        plistPath,
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}`,
          npm_config_loglevel: "silent",
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      `${result.stdout}${result.stderr}`.includes(fixture.root),
      false,
    );
    const output = JSON.parse(result.stdout) as Record<string, unknown>;
    assert.deepEqual(output, {
      ok: true,
      operation: "render-launch-agent",
      label: configuration.label,
    });
    assert.equal(statSync(plistPath).mode & 0o777, 0o600);
    lintPlistIfAvailable(plistPath);
    assertLaunchAgentFields(readFileSync(plistPath, "utf8"), configuration);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

function environmentOf(plist: string): Record<string, string> {
  const block =
    /<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/.exec(
      plist,
    )?.[1];
  assert.ok(block);
  return Object.fromEntries(
    [...block.matchAll(/<key>(.*?)<\/key>\s*<string>(.*?)<\/string>/g)].map(
      (m) => [m[1] as string, m[2] as string],
    ),
  );
}

test("LaunchAgent delivers diagnostic retention values the service accepts", () => {
  const fixture = createFixture();
  const plistPath = join(fixture.root, `${fixture.configuration.label}.plist`);
  try {
    const configuration = {
      ...fixture.configuration,
      diagnosticRetentionDays: 7,
      diagnosticStorageMib: 256,
    };
    const plist = renderLaunchAgent(configuration);
    assert.ok(
      plist.includes(
        "    <key>ENSEMBLE_OPERATOR_ORIGIN</key>\n    <string>http://127.0.0.1:28787</string>\n" +
          "    <key>ENSEMBLE_DIAGNOSTIC_RETENTION_DAYS</key>\n    <string>7</string>\n" +
          "    <key>ENSEMBLE_DIAGNOSTIC_STORAGE_MIB</key>\n    <string>256</string>\n  </dict>",
      ),
    );
    writeLaunchAgent(configuration, plistPath);
    lintPlistIfAvailable(plistPath);
    const limits = diagnosticLimitsFromEnv(environmentOf(plist));
    assert.equal(limits.ageMs, 7 * 86_400_000);
    assert.equal(limits.installationBytes, 256 * 1024 * 1024);

    const only = environmentOf(
      renderLaunchAgent({ ...fixture.configuration, diagnosticStorageMib: 16 }),
    );
    assert.equal(only.ENSEMBLE_DIAGNOSTIC_STORAGE_MIB, "16");
    assert.equal("ENSEMBLE_DIAGNOSTIC_RETENTION_DAYS" in only, false);
    const none = renderLaunchAgent(fixture.configuration);
    assert.equal(none.includes("ENSEMBLE_DIAGNOSTIC"), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("LaunchAgent diagnostic retention bounds match the service parser", () => {
  const fixture = createFixture();
  try {
    const render = (change: Partial<LaunchAgentConfiguration>) =>
      renderLaunchAgent({ ...fixture.configuration, ...change });
    for (const diagnosticRetentionDays of [1, 365])
      render({ diagnosticRetentionDays });
    for (const diagnosticStorageMib of [16, 1_048_576])
      render({ diagnosticStorageMib });
    for (const diagnosticRetentionDays of [0, 366, 1.5, Number.NaN, -1])
      assert.throws(() => render({ diagnosticRetentionDays }));
    for (const diagnosticStorageMib of [15, 1_048_577, 1.5, Number.NaN, -1])
      assert.throws(() => render({ diagnosticStorageMib }));
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("operations CLI renders diagnostic retention options and refuses bad ones", () => {
  const fixture = createFixture();
  const { configuration } = fixture;
  const npmCli = process.env.npm_execpath;
  assert.ok(npmCli, "launchd CLI test must run from npm");
  const render = (plistPath: string, extra: string[]) =>
    spawnSync(
      process.execPath,
      [
        npmCli,
        "run",
        "operations",
        "--",
        "render-launch-agent",
        configuration.label,
        configuration.nodePath,
        configuration.cliPath,
        configuration.dataDirectory,
        configuration.authFile,
        configuration.origin,
        String(configuration.port),
        configuration.stdoutPath,
        configuration.stderrPath,
        plistPath,
        ...extra,
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}`,
          npm_config_loglevel: "silent",
        },
      },
    );
  try {
    const plistPath = join(fixture.root, `${configuration.label}.plist`);
    const ok = render(plistPath, [
      "--diagnostic-retention-days",
      "7",
      "--diagnostic-storage-mib",
      "256",
    ]);
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(`${ok.stdout}${ok.stderr}`.includes(fixture.root), false);
    const env = environmentOf(readFileSync(plistPath, "utf8"));
    assert.equal(env.ENSEMBLE_DIAGNOSTIC_RETENTION_DAYS, "7");
    assert.equal(env.ENSEMBLE_DIAGNOSTIC_STORAGE_MIB, "256");

    for (const bad of [
      ["--diagnostic-retention-days", "366"],
      ["--diagnostic-storage-mib", "abc"],
      ["--diagnostic-storage-mib", "15"],
      ["--diagnostic-retention-days", "1.5"],
      ["--diagnostic-retention-days"],
      ["--unknown", "1"],
    ]) {
      const target = join(fixture.root, "bad", "x.plist");
      const result = render(target, bad);
      assert.equal(result.status, 2);
      assert.match(result.stderr, /Usage/);
      assert.equal(
        `${result.stdout}${result.stderr}`.includes(fixture.root),
        false,
      );
      assert.equal(existsSync(target), false);
    }
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

const environmentKeys = (plist: string) => {
  const block =
    /<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/.exec(
      plist,
    )?.[1] ?? "";
  return [...block.matchAll(/<key>([^<]*)<\/key>/g)].map((m) => m[1]);
};

const withDaemonAccount = (
  fixture: ReturnType<typeof createFixture>,
  userName = "operator",
): LaunchAgentConfiguration => {
  const home = join(fixture.root, "home");
  mkdirSync(home, { mode: 0o755 });
  return { ...fixture.configuration, userName, home };
};

test("daemon plist renders UserName and HOME with the LaunchAgent environment and no secrets", () => {
  const fixture = createFixture();
  const canaries = {
    GH_TOKEN: "canary-gh-1144",
    GITHUB_TOKEN: "canary-github-1144",
    CLAUDE_CODE_OAUTH_TOKEN: "canary-claude-1144",
    ENSEMBLE_DELIVERY_TOKEN: "canary-delivery-1144",
  };
  const saved = Object.fromEntries(
    Object.keys(canaries).map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, canaries);
  try {
    const configuration = withDaemonAccount(fixture);
    const plist = renderLaunchAgent({
      ...configuration,
      diagnosticRetentionDays: 7,
    });
    assert.match(plist, /<key>UserName<\/key>\s*<string>operator<\/string>/);
    assert.deepEqual(environmentKeys(plist), [
      "PATH",
      "HOME",
      "ENSEMBLE_OPERATOR_AUTH_FILE",
      "ENSEMBLE_OPERATOR_ORIGIN",
      "ENSEMBLE_DIAGNOSTIC_RETENTION_DAYS",
    ]);
    assert.match(
      plist,
      new RegExp(
        `<key>PATH</key>\\s*<string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>\\s*<key>HOME</key>\\s*<string>${configuration.home?.replaceAll("/", "\\/")}</string>`,
      ),
    );
    for (const value of Object.values(canaries))
      assert.equal(plist.includes(value), false, value);
    const argumentsXml = [
      configuration.nodePath,
      configuration.cliPath,
      "operator",
      configuration.dataDirectory,
      String(configuration.port),
    ]
      .map((value) => `    <string>${xmlEscape(value)}</string>`)
      .join("\n");
    assert.ok(
      plist.includes(
        `<key>ProgramArguments</key>\n  <array>\n${argumentsXml}\n  </array>`,
      ),
    );
    assert.ok(
      plist.includes(
        `<key>StandardOutPath</key>\n  <string>${xmlEscape(configuration.stdoutPath)}</string>`,
      ),
    );
    assert.ok(
      plist.includes(
        `<key>StandardErrorPath</key>\n  <string>${xmlEscape(configuration.stderrPath)}</string>`,
      ),
    );
    assert.ok(plist.includes("<key>RunAtLoad</key>\n  <true/>"));
    assert.ok(plist.includes("<key>KeepAlive</key>\n  <false/>"));
  } finally {
    for (const [key, value] of Object.entries(saved))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("daemon plist fields are absent from the LaunchAgent", () => {
  const fixture = createFixture();
  try {
    const plist = renderLaunchAgent(fixture.configuration);
    assert.equal(plist.includes("UserName"), false);
    assert.equal(plist.includes("<key>HOME</key>"), false);
    assert.deepEqual(environmentKeys(plist), [
      "PATH",
      "ENSEMBLE_OPERATOR_AUTH_FILE",
      "ENSEMBLE_OPERATOR_ORIGIN",
    ]);
    // The daemon rendering differs from it only by the two added entries.
    const daemon = renderLaunchAgent(withDaemonAccount(fixture));
    assert.equal(
      daemon
        .replace(/\n {2}<key>UserName<\/key>\n {2}<string>[^<]*<\/string>/, "")
        .replace(/\n {4}<key>HOME<\/key>\n {4}<string>[^<]*<\/string>/, ""),
      plist,
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("daemon plist rejects root, unsafe names, relative or symlinked home and half-set fields", () => {
  const fixture = createFixture();
  try {
    const good = withDaemonAccount(fixture);
    const link = join(fixture.root, "home-link");
    symlinkSync(good.home as string, link);
    const file = join(fixture.root, "home-file");
    writeFileSync(file, "");
    const cases: Partial<LaunchAgentConfiguration>[] = [
      { userName: "root" },
      { userName: "ROOT" },
      { userName: "" },
      { userName: "-flag" },
      { userName: "a b" },
      { userName: "a</string>" },
      { userName: "x".repeat(256) },
      { home: "relative/home" },
      { home: link },
      { home: file },
      { home: join(fixture.root, "missing") },
      { userName: undefined },
      { home: undefined },
    ];
    for (const override of cases)
      assert.throws(
        () => renderLaunchAgent({ ...good, ...override }),
        /./,
        Object.keys(override).join(),
      );
    assert.doesNotThrow(() => renderLaunchAgent(good));
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("daemon plist passes plutil -lint", {
  skip: process.platform !== "darwin",
}, () => {
  const fixture = createFixture();
  try {
    const plistPath = join(fixture.root, "daemon.plist");
    const configuration = withDaemonAccount(fixture);
    writeFileSync(plistPath, renderLaunchAgent(configuration));
    assert.equal(lintPlistIfAvailable(plistPath), true);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("assertNotRoot refuses uid 0 with a fixed message and allows others", () => {
  assert.throws(
    () => assertNotRoot(0),
    (error: Error) =>
      error.message === ROOT_REFUSAL &&
      error.message ===
        "Ensemble does not run as root; run it as the account that owns the service" &&
      !error.message.includes("/"),
  );
  assert.doesNotThrow(() => assertNotRoot(501));
  assert.doesNotThrow(() => assertNotRoot(undefined));
});

test("the service entry point refuses root before main runs", () => {
  // A preload makes the process report uid 0. With the guard in place the entry exits at once;
  // without it main() would only fail on its missing arguments, so the message tells them apart.
  const entry = resolve("dist/src/standalone/cli.js");
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "data:text/javascript,process.getuid=()=>0;process.geteuid=()=>0",
      entry,
      "operator",
    ],
    { encoding: "utf8", timeout: 20_000 },
  );
  assert.equal(result.status, 1);
  assert.equal(
    result.stderr.trim(),
    "Ensemble does not run as root; run it as the account that owns the service",
  );
});
