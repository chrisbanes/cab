import { lifecycleOptions, VERIFY_OPTIONS } from "../../src/cli/service.js";
import { configurationSchema } from "../../src/cli/installation-record.js";
import { launchdEnvironment } from "../../src/standalone/launchd.js";
import { productionService } from "../../src/standalone/cli.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseWorkspaceMaintenanceLimit,
  workspaceMaintenanceFromEnv,
  workspaceMaintenanceSettings,
} from "../../src/operator/workspace-maintenance-settings.js";

test("workspace limits default independently and preserve each explicit off", () => {
  const defaults = {
    idleHours: 24,
    deliveredRetentionHours: 24,
    mergedRetentionHours: 1,
    diskCapGb: 10,
  };
  assert.deepEqual(workspaceMaintenanceFromEnv({}), defaults);
  for (const [key, definition] of Object.entries(
    workspaceMaintenanceSettings,
  )) {
    assert.deepEqual(
      workspaceMaintenanceFromEnv({ [definition.name]: "off" }),
      {
        ...defaults,
        [key]: "off",
      },
    );
    assert.deepEqual(workspaceMaintenanceFromEnv({ [definition.name]: "7" }), {
      ...defaults,
      [key]: 7,
    });
    assert.equal(parseWorkspaceMaintenanceLimit(7, definition), 7);
  }
  assert.deepEqual(
    workspaceMaintenanceFromEnv({
      CAB_WORKSPACE_DELIVERED_RETENTION_HOURS: "off",
      CAB_WORKSPACE_MERGED_RETENTION_HOURS: "off",
    }),
    {
      ...defaults,
      deliveredRetentionHours: "off",
      mergedRetentionHours: "off",
    },
  );
  assert.equal(
    workspaceMaintenanceSettings.diskCapGb.multiplier,
    1_000_000_000,
  );
  assert.deepEqual(
    Object.values(workspaceMaintenanceSettings).map(
      (definition) => definition.option,
    ),
    [
      "workspace-idle-hours",
      "workspace-delivered-retention-hours",
      "workspace-merged-retention-hours",
      "workspace-disk-cap-gb",
    ],
  );
});

test("workspace limits reject malformed values and unsafe converted integers", () => {
  for (const definition of Object.values(workspaceMaintenanceSettings)) {
    for (const value of [
      "",
      " ",
      "0",
      "-1",
      "1.5",
      "NaN",
      "Infinity",
      "OFF",
      "unknown",
      "1e3",
      "+1",
      "1h",
      " 1",
      "1\n",
      null,
      true,
      {},
      0,
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER,
    ]) {
      assert.throws(
        () => parseWorkspaceMaintenanceLimit(value, definition),
        definition.name,
      );
    }
    const max = Math.floor(Number.MAX_SAFE_INTEGER / definition.multiplier);
    assert.equal(parseWorkspaceMaintenanceLimit(String(max), definition), max);
    assert.throws(() =>
      parseWorkspaceMaintenanceLimit(String(max + 1), definition),
    );
    assert.throws(() => workspaceMaintenanceFromEnv({ [definition.name]: "" }));
  }
});

test("supported lifecycle flags and protected records share strict values and preserve legacy omission", () => {
  const flags = Object.values(workspaceMaintenanceSettings).flatMap(
    (definition) => [`--${definition.option}`, "off"],
  );
  const parsed = lifecycleOptions(
    flags,
    { HOME: "/fixture/home" },
    "/fixture/daemons",
  );
  assert.ok(parsed);
  assert.deepEqual(parsed.options.workspaceMaintenance, {
    idleHours: "off",
    deliveredRetentionHours: "off",
    mergedRetentionHours: "off",
    diskCapGb: "off",
  });
  for (const definition of Object.values(workspaceMaintenanceSettings)) {
    for (const value of [
      "",
      "0",
      "-1",
      "1.5",
      "default",
      "OFF",
      String(Number.MAX_SAFE_INTEGER),
    ])
      assert.equal(
        lifecycleOptions(
          [`--${definition.option}`, value],
          { HOME: "/fixture/home" },
          "/fixture/daemons",
        ),
        null,
      );
    assert.equal(VERIFY_OPTIONS[definition.option], "irrelevant");
  }
  const legacy = {
    label: "local.cab.test",
    nodePath: "/fixture/node",
    cliPath: "/fixture/cli",
    dataDirectory: "/fixture/data",
    authFile: "/fixture/auth",
    origin: "http://127.0.0.1:8787",
    port: 8787,
    stdoutPath: "/fixture/out",
    stderrPath: "/fixture/err",
  };
  assert.equal(
    configurationSchema.parse(legacy).workspaceMaintenance,
    undefined,
  );
  const saved = configurationSchema.parse({
    ...legacy,
    workspaceMaintenance: parsed.options.workspaceMaintenance,
  });
  const env = launchdEnvironment(saved);
  for (const definition of Object.values(workspaceMaintenanceSettings))
    assert.equal(env[definition.name], "off");
  assert.deepEqual(
    configurationSchema.parse(JSON.parse(JSON.stringify(saved))),
    saved,
  );
  assert.throws(() =>
    configurationSchema.parse({
      ...legacy,
      workspaceMaintenance: { unknown: 1 },
    }),
  );
  assert.throws(() =>
    configurationSchema.parse({
      ...legacy,
      workspaceMaintenance: { idleHours: "24" },
    }),
  );
  assert.throws(() =>
    configurationSchema.parse({
      ...legacy,
      workspaceMaintenance: { diskCapGb: Number.MAX_SAFE_INTEGER },
    }),
  );
});

test("production load rejects invalid workspace limits before starting or opening a data directory", () => {
  const name = "CAB_WORKSPACE_IDLE_HOURS",
    prior = process.env[name];
  try {
    process.env[name] = "";
    assert.throws(
      () => productionService("/must-not-open-1727"),
      /CAB_WORKSPACE_IDLE_HOURS/,
    );
  } finally {
    if (prior === undefined) delete process.env[name];
    else process.env[name] = prior;
  }
});

test("production load passes every validated limit to service options while maintenance remains inactive", () => {
  const names = Object.values(workspaceMaintenanceSettings).map((d) => d.name);
  const prior = names.map((name) => process.env[name]);
  try {
    for (const name of names) process.env[name] = "off";
    const service = productionService("/must-not-open-1727");
    assert.deepEqual(service.workspaceMaintenance, {
      idleHours: "off",
      deliveredRetentionHours: "off",
      mergedRetentionHours: "off",
      diskCapGb: "off",
    });
  } finally {
    names.forEach((name, index) => {
      if (prior[index] === undefined) delete process.env[name];
      else process.env[name] = prior[index];
    });
  }
});

test("low-level renderer writes all workspace limits and rejects invalid limits before writing", async () => {
  const { mkdtemp, readFile, rm, access, mkdir, writeFile } = await import(
    "node:fs/promises"
  );
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { Writable } = await import("node:stream");
  const { runOperations } = await import(
    "../../src/standalone/operations-cli.js"
  );
  const root = await mkdtemp(join(tmpdir(), "workspace-render-"));
  const plist = join(root, "me.cab.test.plist");
  await mkdir(join(root, "data"), { mode: 0o700 });
  await writeFile(join(root, "node"), "fixture", { mode: 0o700 });
  await writeFile(join(root, "cli.js"), "fixture");
  await writeFile(join(root, "auth"), "fixture", { mode: 0o600 });
  const output = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  const args = [
    "render-launch-agent",
    "me.cab.test",
    join(root, "node"),
    join(root, "cli.js"),
    join(root, "data"),
    join(root, "auth"),
    "http://127.0.0.1:9999",
    "9999",
    join(root, "out"),
    join(root, "err"),
    plist,
  ];
  try {
    assert.equal(
      await runOperations([...args, "--workspace-idle-hours", "invalid"], {
        stdout: output,
        stderr: output,
      }),
      2,
    );
    await assert.rejects(access(plist));
    const flags = Object.values(workspaceMaintenanceSettings).flatMap(
      (definition) => [`--${definition.option}`, "off"],
    );
    assert.equal(
      await runOperations([...args, ...flags], {
        stdout: output,
        stderr: output,
      }),
      0,
    );
    const rendered = await readFile(plist, "utf8");
    for (const definition of Object.values(workspaceMaintenanceSettings))
      assert.ok(
        rendered.includes(`<key>${definition.name}</key>`) &&
          rendered.includes("<string>off</string>"),
      );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
