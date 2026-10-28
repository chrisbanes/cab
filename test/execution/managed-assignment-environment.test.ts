import assert from "node:assert/strict";
import { test } from "node:test";
import type { RuntimeSpawnContext } from "../../src/standalone/service.js";
import {
  createOperatorFixture,
  OperatorFixtureRuntime,
} from "../fixtures/operator-web.js";

test("service runtime children get the managed-assignment marker and no CLI selection", async (t) => {
  const keys = [
    "CAB_CLI_CONFIG_DIR",
    "CAB_CONNECTION",
    "CAB_MANAGED_ASSIGNMENT",
    "MANAGED_ENV_SENTINEL",
  ] as const;
  const previous = keys.map((key) => process.env[key]);
  t.after(() =>
    keys.forEach((key, index) => {
      const value = previous[index];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }),
  );
  process.env.CAB_CLI_CONFIG_DIR = "/tmp/cab-cli-config";
  process.env.CAB_CONNECTION = "home";
  delete process.env.CAB_MANAGED_ASSIGNMENT;
  process.env.MANAGED_ENV_SENTINEL = "kept";
  const contexts: RuntimeSpawnContext[] = [];
  const f = await createOperatorFixture(
    null,
    undefined,
    undefined,
    {},
    (context) => {
      contexts.push(context);
      return new OperatorFixtureRuntime();
    },
  );
  t.after(() => f.close());
  const environment = contexts[0]?.spawnEnvironment();
  assert.ok(environment);
  assert.equal(environment.CAB_MANAGED_ASSIGNMENT, "1");
  assert.equal(environment.CAB_CLI_CONFIG_DIR, undefined);
  assert.equal(environment.CAB_CONNECTION, undefined);
  assert.equal(environment.MANAGED_ENV_SENTINEL, "kept");
});
