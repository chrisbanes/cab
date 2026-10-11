import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { Runtime } from "../src/standalone/codex.js";
import type { ExecutionHarness } from "../src/standalone/execution-harness.js";
import {
  type RuntimeSpawnContext,
  StandaloneService,
} from "../src/standalone/service.js";
import { tmpdir } from "./temp.js";

/** Captures the spawn context; never starts a turn. */
class ContextRuntime implements Runtime {
  async start() {}
  async stop() {}
  async startThread(): Promise<string> {
    throw new Error("unused");
  }
  async resumeThread() {}
  async startTurn(): Promise<string> {
    throw new Error("unused");
  }
  async interruptTurn() {}
  async waitForTurn(): Promise<"completed"> {
    throw new Error("unused");
  }
  onUnexpectedRequest() {}
}

const TOKEN = "claude-token-canary-4471";
const NAME = "FIXTURE_CLAUDE_SUBSCRIPTION";
const ALIAS = "FIXTURE_CLAUDE_ALIAS";
const DELIVERY = "FIXTURE_CLAUDE_DELIVERY_CREDENTIAL";
const DELIVERY_VALUE = "delivery-canary-9910";

function withEnvironment(
  t: { after: (fn: () => void) => void },
  values: Record<string, string | undefined>,
) {
  for (const [key, value] of Object.entries(values)) {
    const previous = process.env[key];
    t.after(() => {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    });
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function harnessFixture(t: { after: (fn: () => Promise<void>) => void }) {
  const dataDir = join(
    mkdtempSync(join(tmpdir(), "ensemble-claude-service-")),
    "data",
  );
  const contexts = new Map<ExecutionHarness, RuntimeSpawnContext>();
  const service = new StandaloneService(
    dataDir,
    (context, harness) => {
      contexts.set(harness, context);
      return new ContextRuntime();
    },
    undefined,
    {
      runtimeHarnesses: ["codex", "claude"],
      power: { enabled: false },
      routingClient: null,
    },
  );
  t.after(async () => {
    await service.stop().catch(() => {});
    rmSync(join(dataDir, ".."), { recursive: true, force: true });
  });
  const configure = (credentialRef: string | null) =>
    service.domain().execute({
      type: "claude-token.configure",
      actor: "operator",
      key: randomUUID(),
      credentialRef,
    });
  const claude = () => {
    const context = contexts.get("claude")?.claude;
    assert.ok(context);
    return context;
  };
  return { service, dataDir, contexts, configure, claude };
}

test("the Claude token reaches only the Claude turn environment, never Codex or alias spawn environments", async (t) => {
  withEnvironment(t, {
    [NAME]: TOKEN,
    [ALIAS]: TOKEN,
    [DELIVERY]: DELIVERY_VALUE,
  });
  const f = harnessFixture(t);
  await f.service.start();
  f.configure(`env:${NAME}`);
  const projectId = randomUUID();
  f.service.domain().execute({
    type: "project.create",
    actor: "operator",
    key: randomUUID(),
    projectId,
    name: "Delivery",
    leadProfileId: null,
  });
  f.service.domain().execute({
    type: "delivery.configure",
    actor: "operator",
    key: randomUUID(),
    projectId,
    expectedVersion: 1,
    mode: "reviewable-pr",
    credentialRef: `env:${DELIVERY}`,
    grants: [],
    requiredChecks: [],
  });
  await f.service.stop();
  await f.service.start();
  const codex = f.contexts.get("codex")?.spawnEnvironment();
  assert.ok(codex);
  const serialized = JSON.stringify(codex);
  assert.equal(serialized.includes(TOKEN), false);
  assert.equal(codex[NAME], undefined);
  assert.equal(codex[ALIAS], undefined);
  assert.equal(serialized.includes(DELIVERY_VALUE), false);
  const turn = f.claude().turnEnvironment();
  assert.ok("env" in turn);
  assert.equal(turn.token, TOKEN);
  assert.equal(JSON.stringify(turn.env).includes(TOKEN), false);
  assert.equal(JSON.stringify(turn.env).includes(DELIVERY_VALUE), false);
  assert.equal(turn.env.ENSEMBLE_MANAGED_ASSIGNMENT, "1");
  assert.equal(f.claude().configDirectory, join(f.dataDir, "claude", "config"));
});

test("a Claude token reference inherited by the running runtime waits until restart", async (t) => {
  withEnvironment(t, { [NAME]: TOKEN, [ALIAS]: undefined });
  const f = harnessFixture(t);
  await f.service.start();
  f.configure(`env:${NAME}`);
  const held = f.claude().turnEnvironment();
  assert.ok("unavailable" in held);
  assert.match(
    held.unavailable,
    /^Claude runtime unavailable: .*restart the service/,
  );
  assert.equal(held.unavailable.includes(TOKEN), false);
  await f.service.stop();
  await f.service.start();
  const turn = f.claude().turnEnvironment();
  assert.ok("token" in turn);
  assert.equal(turn.token, TOKEN);
});

test("a missing or empty Claude token makes the turn environment unavailable without revealing it", async (t) => {
  withEnvironment(t, { [NAME]: undefined, [ALIAS]: undefined });
  const f = harnessFixture(t);
  await f.service.start();
  const missing = f.claude().turnEnvironment();
  assert.deepEqual(missing, {
    unavailable:
      "Claude runtime unavailable: subscription token is not configured",
  });
  f.configure(`env:${NAME}`);
  await f.service.stop();
  await f.service.start();
  const empty = f.claude().turnEnvironment();
  assert.deepEqual(empty, {
    unavailable:
      "Claude runtime unavailable: subscription token is unavailable",
  });
  assert.equal(JSON.stringify(empty).includes(NAME), false);
});
