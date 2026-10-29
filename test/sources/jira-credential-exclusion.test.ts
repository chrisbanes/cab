import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { childProcessEnvironment } from "../../src/core/child-environment.js";
import type { Runtime } from "../../src/standalone/codex.js";
import type { ExecutionHarness } from "../../src/standalone/execution-harness.js";
import { ghEnvironment } from "../../src/standalone/gh-credential.js";
import { glabEnvironment } from "../../src/standalone/glab-credential.js";
import { OperatorApi } from "../../src/standalone/operator-api.js";
import {
  type RuntimeSpawnContext,
  StandaloneService,
} from "../../src/standalone/service.js";
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
const env = {
  FIXTURE_JX_SITE: "https://jx-canary.atlassian.net",
  FIXTURE_JX_EMAIL: "jx-canary-1318@example.test",
  FIXTURE_JX_KEY: "jx-credential-canary-1318",
  // The same email held under another name must go too.
  FIXTURE_JX_ALIAS: "jx-canary-1318@example.test",
  FIXTURE_JX_CLAUDE: "jx-claude-canary-1318",
};

test("the Jira site, email and token reach no runtime, Claude turn, helper child, gh or glab child, or task read", async (t) => {
  for (const [key, value] of Object.entries(env)) {
    const previous = process.env[key];
    t.after(() => {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    });
    process.env[key] = value;
  }
  const dataDir = join(mkdtempSync(join(tmpdir(), "cab-jira-excl-")), "data");
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
      issueTrackers: { jiraFetcher: (async () => new Response("{}")) as never },
    },
  );
  t.after(async () => {
    await service.stop().catch(() => {});
    rmSync(join(dataDir, ".."), { recursive: true, force: true });
  });
  await service.start();
  const execute = (command: Record<string, unknown>) =>
    service.domain().execute({
      actor: "operator",
      key: randomUUID(),
      ...command,
    } as never);
  execute({
    type: "issue-tracker-credential.configure",
    issueTracker: "jira",
    instance: "jx-canary.atlassian.net",
    credential: {
      siteRef: "env:FIXTURE_JX_SITE",
      emailRef: "env:FIXTURE_JX_EMAIL",
      tokenRef: "env:FIXTURE_JX_KEY",
    },
  });
  execute({
    type: "claude-token.configure",
    credentialRef: "env:FIXTURE_JX_CLAUDE",
  });
  await service.stop();
  await service.start();
  const names = [
    "FIXTURE_JX_SITE",
    "FIXTURE_JX_EMAIL",
    "FIXTURE_JX_KEY",
    "FIXTURE_JX_ALIAS",
  ];
  const clean = (environment: NodeJS.ProcessEnv, where: string) => {
    const text = JSON.stringify(environment);
    for (const key of names)
      assert.equal(environment[key], undefined, `${where} ${key}`);
    for (const value of Object.values(env))
      assert.equal(text.includes(value), false, `${where} ${value}`);
  };
  const codex = contexts.get("codex")?.spawnEnvironment();
  assert.ok(codex);
  clean(codex, "runtime spawn");
  const turn = contexts.get("claude")?.claude?.turnEnvironment();
  assert.ok(turn && "env" in turn);
  clean(turn.env, "Claude env turn");
  clean(childProcessEnvironment(), "helper child");
  clean(
    ghEnvironment(service.domain(), { reference: "gh:github.com" }),
    "gh child",
  );
  clean(glabEnvironment(service.domain()), "glab child");

  const redactions = service.providerCredentialExclusions().redactions;
  for (const name of ["FIXTURE_JX_SITE", "FIXTURE_JX_EMAIL", "FIXTURE_JX_KEY"])
    for (const secret of [
      `env:${name}`,
      name,
      name === "FIXTURE_JX_SITE" ? name : (process.env[name] ?? ""),
    ])
      assert.ok(redactions.includes(secret), `redaction ${secret}`);

  // A task that mentions the token is withheld from every read; the site host alone is not secret.
  const api = new OperatorApi(service, [dataDir]);
  const projectId = randomUUID();
  execute({
    type: "project.create",
    projectId,
    name: "Exclusion",
    leadProfileId: null,
  });
  for (const text of [
    env.FIXTURE_JX_KEY,
    env.FIXTURE_JX_EMAIL,
    "FIXTURE_JX_KEY",
  ]) {
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
      false,
      `task read ${text}`,
    );
  }

  // The site address is the task's link, not a secret: text that links to it stays readable.
  const linked = randomUUID();
  execute({
    type: "task.create",
    projectId,
    taskId: linked,
    title: "Links https://jx-canary.atlassian.net/browse/ABC-1 plainly",
    outcome: "Exclusion",
    ready: false,
  });
  assert.equal(
    JSON.stringify(
      await api.readSearch(new URLSearchParams({ query: "plainly" })),
    ).includes("https://jx-canary.atlassian.net/browse/ABC-1"),
    true,
  );
});
