import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { childProcessEnvironment } from "../../src/core/child-environment.js";
import type { Runtime } from "../../src/standalone/codex.js";
import type { ExecutionHarness } from "../../src/standalone/execution-harness.js";
import { ghEnvironment } from "../../src/standalone/gh-credential.js";
import { glabToken } from "../../src/standalone/glab-credential.js";
import { OperatorApi } from "../../src/standalone/operator-api.js";
import {
  type RuntimeSpawnContext,
  StandaloneService,
} from "../../src/standalone/service.js";
import { createFakeGlab, fakeGlabToken } from "../fixtures/fake-glab.js";
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
const CLAUDE = "FIXTURE_GX_CLAUDE";
const CLAUDE_VALUE = "gx-claude-canary-311";
const ALIAS = "FIXTURE_GX_ALIAS";
const host = "gitlab.example.com";

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
    ref: "env:FIXTURE_GX_GITLAB",
    names: ["FIXTURE_GX_GITLAB", ALIAS],
    value: "gxgitlabcanary311",
    set: {
      FIXTURE_GX_GITLAB: "gxgitlabcanary311",
      [ALIAS]: "gxgitlabcanary311",
    },
  },
  {
    ref: `glab:${host}`,
    names: ["GITLAB_TOKEN", "GITLAB_ACCESS_TOKEN", "OAUTH_TOKEN", ALIAS],
    value: fakeGlabToken,
    // A glab-resolved token held under another name is excluded by value.
    set: { [ALIAS]: fakeGlabToken },
  },
  {
    ref: `glab:${host}`,
    names: ["GITLAB_TOKEN", "GITLAB_ACCESS_TOKEN", "OAUTH_TOKEN", ALIAS],
    // glab prints the override it is given, so that is the value it resolves.
    value: "gxglabenvcanary311",
    set: {
      GITLAB_TOKEN: "gxglabenvcanary311",
      GITLAB_ACCESS_TOKEN: "gxglabaccesscanary311",
      OAUTH_TOKEN: "gxglaboauthcanary311",
      [ALIAS]: "gxglabenvcanary311",
    },
  },
] as const;

for (const c of cases)
  test(`the ${c.ref.split(":")[0]} GitLab credential (${Object.keys(c.set).length} variables set) reaches no runtime, Claude turn, helper child, gh child or task read`, async (t) => {
    withEnvironment(t, {
      FIXTURE_GX_GITLAB: undefined,
      GITLAB_TOKEN: undefined,
      GITLAB_ACCESS_TOKEN: undefined,
      OAUTH_TOKEN: undefined,
      ...c.set,
      [CLAUDE]: CLAUDE_VALUE,
    });
    const glab = createFakeGlab();
    // Resolve the signed-in login with no override, as startup does for a glab reference.
    const dataDir = join(
      mkdtempSync(join(tmpdir(), "cab-gitlab-exclusion-")),
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
        glabExecutable: glab.executable,
      },
    );
    t.after(async () => {
      await service.stop().catch(() => {});
      rmSync(join(dataDir, ".."), { recursive: true, force: true });
      glab.close();
    });
    await service.start();
    const execute = (command: Record<string, unknown>) =>
      service.domain().execute({
        actor: "operator",
        key: randomUUID(),
        ...command,
      } as never);
    execute({
      type: "code-host-credential.configure",
      codeHost: "gitlab",
      host,
      credentialRef: c.ref,
    });
    execute({ type: "claude-token.configure", credentialRef: `env:${CLAUDE}` });
    // Restart so the glab login is resolved at start and enters the spawn snapshot's exclusions.
    await service.stop();
    await service.start();
    const hidden = [c.value, ...Object.values(c.set)];
    const clean = (environment: NodeJS.ProcessEnv, where: string) => {
      const text = JSON.stringify(environment);
      for (const key of c.names)
        assert.equal(environment[key], undefined, `${where} ${key}`);
      for (const value of hidden)
        assert.equal(text.includes(value), false, `${where} ${value}`);
    };
    const codex = contexts.get("codex")?.spawnEnvironment();
    assert.ok(codex);
    clean(codex, "runtime spawn");
    const claude = contexts.get("claude")?.claude;
    assert.ok(claude);
    const turn = claude.turnEnvironment();
    assert.ok("env" in turn, JSON.stringify(turn));
    clean(turn.env, "Claude env turn");
    clean(childProcessEnvironment(), "helper child");
    clean(
      ghEnvironment(service.domain(), { reference: "gh:github.com" }),
      "gh child",
    );

    // The reference, variable names and values are redacted and never captured from task text.
    const redactions = service.providerCredentialExclusions().redactions;
    for (const secret of [c.ref, ...hidden])
      assert.ok(redactions.includes(secret), `redaction ${secret}`);
    const api = new OperatorApi(service, [dataDir], undefined, undefined, {
      glabExecutable: glab.executable,
    });
    const projectId = randomUUID();
    execute({
      type: "project.create",
      projectId,
      name: "Exclusion",
      leadProfileId: null,
    });
    for (const text of [c.ref, ...hidden, "gitlab.example"]) {
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
        text === "gitlab.example",
        `task read ${text}`,
      );
    }
  });

test("a glab value resolved earlier stays excluded after the credential is cleared", async (t) => {
  withEnvironment(t, {
    GITLAB_TOKEN: undefined,
    GITLAB_ACCESS_TOKEN: undefined,
    OAUTH_TOKEN: undefined,
    [ALIAS]: "gx-rotated-canary-311",
  });
  const glab = createFakeGlab();
  t.after(() => glab.close());
  glab.setToken("gx-rotated-canary-311");
  assert.deepEqual(await glabToken(host, { executable: glab.executable }), {
    token: "gx-rotated-canary-311",
  });
  const cleared = ghEnvironment(
    {
      claudeTokenReference: () => null,
      projects: () => [],
      deliveryCredentialReference: () => null,
      discoveryCredentialReference: () => null,
    },
    { reference: null },
  );
  assert.equal(cleared[ALIAS], undefined);
});

test("a GitLab credential configured after start is excluded at once and flags a restart for runtimes that inherited it", async (t) => {
  const LATE = "FIXTURE_GX_LATE";
  const canary = "gxlatecanary311";
  withEnvironment(t, {
    GITLAB_TOKEN: canary,
    GITLAB_ACCESS_TOKEN: undefined,
    OAUTH_TOKEN: undefined,
    [LATE]: undefined,
    [CLAUDE]: CLAUDE_VALUE,
  });
  const glab = createFakeGlab();
  const dataDir = join(
    mkdtempSync(join(tmpdir(), "cab-gitlab-exclusion-")),
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
      glabExecutable: glab.executable,
    },
  );
  t.after(async () => {
    await service.stop().catch(() => {});
    rmSync(join(dataDir, ".."), { recursive: true, force: true });
    glab.close();
  });
  await service.start();
  const execute = (command: Record<string, unknown>) =>
    service.domain().execute({
      actor: "operator",
      key: randomUUID(),
      ...command,
    } as never);
  const configure = (credentialRef: string | null) =>
    execute({
      type: "code-host-credential.configure",
      codeHost: "gitlab",
      host,
      credentialRef,
    });
  execute({ type: "claude-token.configure", credentialRef: `env:${CLAUDE}` });
  const api = new OperatorApi(service, [dataDir], undefined, undefined, {
    glabExecutable: glab.executable,
  });
  const codexSnapshot = () => contexts.get("codex")?.spawnEnvironment();
  const flagged = async () => {
    const read = JSON.stringify(await api.readCodeHostCredentials());
    assert.equal(read.includes(canary), false);
    assert.equal(read.includes("GITLAB_TOKEN"), false);
    return (await api.readCodeHostCredentials()).data.restartRequired;
  };

  // With no GitLab credential the runtime legitimately inherits the variable.
  assert.equal(codexSnapshot()?.GITLAB_TOKEN, canary);
  assert.equal(service.gitLabCredentialRestartRequired(), false);

  configure(`glab:${host}`);
  // Children the service builds from now on exclude it with no restart.
  assert.equal(childProcessEnvironment().GITLAB_TOKEN, undefined);
  const turn = contexts.get("claude")?.claude?.turnEnvironment();
  assert.ok(turn && "env" in turn, JSON.stringify(turn));
  assert.equal(turn.env.GITLAB_TOKEN, undefined);
  assert.equal(JSON.stringify(turn.env).includes(canary), false);
  // The Codex runtime keeps what it inherited, so the operator is told.
  assert.equal(service.gitLabCredentialRestartRequired(), true);
  assert.equal(await flagged(), true);

  // A restart takes a fresh snapshot without the credential and clears the notice.
  await service.stop();
  await service.start();
  assert.equal(codexSnapshot()?.GITLAB_TOKEN, undefined);
  assert.equal(JSON.stringify(codexSnapshot()).includes(canary), false);
  assert.equal(service.gitLabCredentialRestartRequired(), false);
  assert.equal(await flagged(), false);

  // A variable that was not in the environment at start cannot have been inherited.
  configure(`env:${LATE}`);
  process.env[LATE] = "gxlatevalue311";
  assert.equal(service.gitLabCredentialRestartRequired(), false);
  assert.equal(await flagged(), false);
  configure(null);
});
