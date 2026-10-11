import assert from "node:assert/strict";
import { test } from "node:test";
import type { RuntimeSpawnContext } from "../src/standalone/service.js";
import {
  createOperatorFixture,
  OperatorFixtureRuntime,
} from "./fixtures/operator-web.js";

test("service runtime children get the managed-assignment marker and no CLI selection", async (t) => {
  const keys = [
    "ENSEMBLE_CLI_CONFIG_DIR",
    "ENSEMBLE_CONNECTION",
    "ENSEMBLE_MANAGED_ASSIGNMENT",
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
  process.env.ENSEMBLE_CLI_CONFIG_DIR = "/tmp/ensemble-cli-config";
  process.env.ENSEMBLE_CONNECTION = "home";
  delete process.env.ENSEMBLE_MANAGED_ASSIGNMENT;
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
  assert.equal(environment.ENSEMBLE_MANAGED_ASSIGNMENT, "1");
  assert.equal(environment.ENSEMBLE_CLI_CONFIG_DIR, undefined);
  assert.equal(environment.ENSEMBLE_CONNECTION, undefined);
  assert.equal(environment.MANAGED_ENV_SENTINEL, "kept");
});
