import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { childProcessEnvironment } from "../../src/core/child-environment.js";
import type { Runtime } from "../../src/standalone/codex.js";
import type { ExecutionHarness } from "../../src/standalone/execution-harness.js";
import { OperatorApi } from "../../src/standalone/operator-api.js";
import {
  type RuntimeSpawnContext,
  StandaloneService,
} from "../../src/standalone/service.js";
import { createFakeGh, fakeGhToken } from "../fixtures/fake-gh.js";
import { tmpdir } from "../fixtures/temp.js";

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

// The names deliberately avoid the generic TOKEN/SECRET history pattern.
const CLAUDE = "FIXTURE_DX_CLAUDE";
const CLAUDE_VALUE = "dx-claude-canary-5521";
const ALIAS = "FIXTURE_DX_ALIAS";
const RESOLVED_ALIAS = "FIXTURE_DX_RESOLVED_ALIAS";

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

const cases = [
  {
    ref: "env:FIXTURE_DX_DISCOVERY",
    name: "FIXTURE_DX_DISCOVERY",
    value: "dxdiscoverycanary7731",
  },
  { ref: "gh:github.com", name: "GH_TOKEN", value: "dxghenvcanary7731" },
] as const;

for (const c of cases)
  test(`the ${c.ref.split(":")[0]} discovery credential reaches no runtime, Claude turn, helper child or task read`, async (t) => {
    withEnvironment(t, {
      FIXTURE_DX_DISCOVERY: undefined,
      GH_TOKEN: undefined,
      GITHUB_TOKEN: undefined,
      [c.name]: c.value,
      [ALIAS]: c.value,
      // A gh-resolved token held elsewhere in the environment is excluded by value.
      [RESOLVED_ALIAS]: fakeGhToken,
      [CLAUDE]: CLAUDE_VALUE,
    });
    const gh = createFakeGh();
    const dataDir = join(
      mkdtempSync(join(tmpdir(), "ensemble-discovery-exclusion-")),
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
        ghExecutable: gh.executable,
      },
    );
    t.after(async () => {
      await service.stop().catch(() => {});
      rmSync(join(dataDir, ".."), { recursive: true, force: true });
      gh.close();
    });
    await service.start();
    const execute = (command: Record<string, unknown>) =>
      service.domain().execute({
        actor: "operator",
        key: randomUUID(),
        ...command,
      } as never);
    execute({ type: "discovery.configure", credentialRef: c.ref });
    execute({ type: "claude-token.configure", credentialRef: `env:${CLAUDE}` });
    await service.stop();
    await service.start();
    const hidden = [c.value, ...(c.ref.startsWith("gh:") ? [fakeGhToken] : [])];
    const clean = (environment: NodeJS.ProcessEnv, where: string) => {
      const text = JSON.stringify(environment);
      for (const key of [c.name, ALIAS])
        assert.equal(environment[key], undefined, `${where} ${key}`);
      for (const value of hidden)
        assert.equal(text.includes(value), false, `${where} value`);
    };
    const codex = contexts.get("codex")?.spawnEnvironment();
    assert.ok(codex);
    clean(codex, "runtime spawn");
    const claude = contexts.get("claude")?.claude;
    assert.ok(claude);
    const turn = claude.turnEnvironment();
    assert.ok("env" in turn, JSON.stringify(turn));
    clean(turn.env, "Claude env turn");
    // The file-sourced Claude branch excludes it as well.
    const root = realpathSync(mkdtempSync(join(tmpdir(), "ensemble-dx-")));
    chmodSync(root, 0o700);
    t.after(() => rmSync(root, { recursive: true, force: true }));
    writeFileSync(join(root, "token"), "dx-file-canary-5521\n", {
      mode: 0o600,
    });
    execute({
      type: "claude-token.configure",
      credentialRef: `file:${join(root, "token")}`,
    });
    const fileTurn = claude.turnEnvironment();
    assert.ok("env" in fileTurn, JSON.stringify(fileTurn));
    clean(fileTurn.env, "Claude file turn");
    clean(childProcessEnvironment(), "helper child");
    if (c.ref.startsWith("gh:")) {
      // gh itself still receives its own token variable.
      const received = gh.environments().at(-1);
      assert.equal(received?.GH_TOKEN, c.value);
      assert.equal(received?.[CLAUDE], undefined);
    } else assert.equal(gh.environments().length, 0);
    // Task text holding the reference, name or value is never captured.
    const api = new OperatorApi(service, [dataDir], undefined, undefined, {
      ghExecutable: gh.executable,
    });
    const projectId = randomUUID();
    execute({
      type: "project.create",
      projectId,
      name: "Exclusion",
      leadProfileId: null,
    });
    const mentioned = [
      c.ref,
      ...(c.ref.startsWith("env:") ? [c.name] : []),
      ...hidden,
    ];
    // One task per text, so each is checked on its own; the control mentions github.com only.
    for (const text of [...mentioned, "github.com"]) {
      const taskId = randomUUID();
      execute({
        type: "task.create",
        projectId,
        taskId,
        title: `Uses ${text} plainly`,
        outcome: "Exclusion",
        ready: false,
      });
      const reads = JSON.stringify([
        (await api.readReview(taskId)).data,
        await api.readSearch(new URLSearchParams({ query: "plainly" })),
      ]);
      assert.equal(
        reads.includes(`Uses ${text} plainly`),
        text === "github.com",
        `task read ${text}`,
      );
    }
  });
