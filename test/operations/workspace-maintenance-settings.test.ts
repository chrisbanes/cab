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
