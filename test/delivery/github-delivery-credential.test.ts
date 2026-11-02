import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { OperatorApi } from "../../src/standalone/operator-api.js";
import type { Runtime } from "../../src/standalone/codex.js";
import {
  StandaloneService,
  type RuntimeSpawnContext,
} from "../../src/standalone/service.js";
import { createFakeGh, fakeGhToken } from "../fixtures/fake-gh.js";
import { tmpdir } from "../fixtures/temp.js";

const refusedRuntime = (): Runtime => ({
  async start() {},
  async stop() {},
  async startThread() {
    throw new Error("model thread forbidden");
  },
  async resumeThread() {
    throw new Error("model thread forbidden");
  },
  async startTurn() {
    throw new Error("model turn forbidden");
  },
  async interruptTurn() {},
  async waitForTurn() {
    throw new Error("model turn forbidden");
  },
  onUnexpectedRequest() {},
});

function environment(
  t: TestContext,
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

async function fixture(t: TestContext, credentialRef: string | null) {
  const gh = createFakeGh();
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "cab-delivery-credential-")),
  );
  const contexts: RuntimeSpawnContext[] = [];
  const spawns: NodeJS.ProcessEnv[] = [];
  const authorizations: string[] = [];
  const delivery = {
    // The provider's reads fail at the code host; only the credential on the wire matters here.
    fetcher: (async (_url: unknown, init?: RequestInit) => {
      authorizations.push(
        new Headers(init?.headers).get("authorization") ?? "",
      );
      return Response.json({ message: "refused" }, { status: 404 });
    }) as typeof fetch,
  };
  const make = () =>
    new StandaloneService(
      join(root, "data"),
      (context) => {
        contexts.push(context);
        spawns.push(context.spawnEnvironment());
        return refusedRuntime();
      },
      undefined,
      {
        runtimeHarnesses: ["codex", "claude"],
        power: { enabled: false },
        routingClient: null,
        ghExecutable: gh.executable,
        issueTrackers: { intervalMs: 60_000 },
        delivery,
      },
    );
  let service = make();
  t.after(async () => {
    await service.stop().catch(() => {});
    gh.close();
    rmSync(root, { recursive: true, force: true });
  });
  const execute = (command: object) =>
    service
      .domain()
      .execute({ actor: "operator", key: randomUUID(), ...command } as never);
  await service.start();
  const projectId = randomUUID();
  execute({
    type: "project.create",
    projectId,
    name: "Delivery",
    leadProfileId: null,
  });
  const configure = (ref: string | null) =>
    execute({
      type: "delivery.configure",
      projectId,
      expectedVersion: service.delivery().configuration(projectId).version,
      mode: "reviewable-pr",
      credentialRef: ref,
      grants: [],
      requiredChecks: [],
    });
  configure(credentialRef);
  return {
    gh,
    authorizations,
    contexts,
    spawns,
    projectId,
    configure,
    execute,
    get service() {
      return service;
    },
    restart: async () => {
      await service.stop();
      service = make();
      await service.start();
    },
  };
}

test("a gh delivery credential is read afresh for every provider use and never falls back", async (t) => {
  environment(t, { GH_TOKEN: "host-gh-token", GITHUB_TOKEN: undefined });
  const f = await fixture(t, "gh:github.com");
  f.gh.setToken("delivery-token-one");
  assert.equal(
    (await f.service.repositoryRequirements(f.projectId, "R1")).status,
    "unavailable",
  );
  f.gh.setToken("delivery-token-two");
  await f.service.repositoryRequirements(f.projectId, "R1");
  assert.deepEqual(f.authorizations, [
    "Bearer delivery-token-one",
    "Bearer delivery-token-two",
  ]);
  assert.equal(f.gh.commands().filter((c) => c === "token").length >= 2, true);

  f.gh.set("not-signed-in");
  f.authorizations.length = 0;
  assert.deepEqual(await f.service.repositoryRequirements(f.projectId, "R1"), {
    status: "unavailable",
    reason: "credential-missing",
  });
  assert.deepEqual(f.authorizations, [], "no request, no fallback to GH_TOKEN");
});

test("an env delivery credential keeps reading its variable", async (t) => {
  environment(t, { FIXTURE_DELIVERY_ENV: "delivery-env-value" });
  const f = await fixture(t, "env:FIXTURE_DELIVERY_ENV");
  await f.service.repositoryRequirements(f.projectId, "R1");
  assert.deepEqual(f.authorizations, ["Bearer delivery-env-value"]);
  assert.equal(
    f.gh.commands().some((c) => c === "token"),
    false,
  );
});

test("a gh delivery credential is excluded by name and value from agent environments and public reads", async (t) => {
  environment(t, { GH_TOKEN: "host-gh-token", GITHUB_TOKEN: undefined });
  environment(t, { FIXTURE_DELIVERY_CLAUDE: "claude-delivery-canary" });
  const f = await fixture(t, "gh:github.com");
  f.execute({
    type: "claude-token.configure",
    credentialRef: "env:FIXTURE_DELIVERY_CLAUDE",
  });
  await f.restart();
  const clean = (env: NodeJS.ProcessEnv) => {
    assert.equal(env.GH_TOKEN, undefined);
    assert.equal(env.GITHUB_TOKEN, undefined);
    for (const token of [fakeGhToken, "host-gh-token"])
      assert.equal(JSON.stringify(env).includes(token), false);
  };
  clean(f.spawns.at(-1) ?? {});
  const claude = f.contexts.at(-1)?.claude;
  assert.ok(claude);
  const turn = claude.turnEnvironment();
  assert.ok("env" in turn);
  clean(turn.env);
  const { names, redactions } = f.service.providerCredentialExclusions();
  assert.ok(names.includes("GH_TOKEN"));
  assert.ok(redactions.includes(fakeGhToken));
  // The reference has no variable name: `slice(4)` would have excluded the bare host.
  assert.equal(names.includes("github.com"), false);
  assert.equal(redactions.includes("github.com"), false);

  const read = await new OperatorApi(f.service).readProjectConfiguration(
    f.projectId,
  );
  const text = JSON.stringify(read);
  assert.equal(text.includes(fakeGhToken), false);
  assert.deepEqual(read.data.delivery?.credential, {
    configured: true,
    source: "gh",
    usable: true,
    reason: null,
    gh: { state: "signed-in", login: "octo" },
  });
});

test("a delivery credential configured after start waits for a restart while the spawn snapshot still holds gh variables", async (t) => {
  environment(t, { GH_TOKEN: "host-gh-token", GITHUB_TOKEN: undefined });
  const f = await fixture(t, null);
  // The snapshot taken at start still carries host GH_TOKEN, as no gh reference existed then.
  assert.equal(f.spawns.at(-1)?.GH_TOKEN, "host-gh-token");
  f.configure("gh:github.com");
  const guard = f.service as unknown as {
    current: {
      deliveryCoordinator: {
        options: { activationAllowed(p: object): boolean };
      };
    };
  };
  assert.equal(
    guard.current.deliveryCoordinator.options.activationAllowed({
      credentialRef: "gh:github.com",
    }),
    false,
  );
  await f.restart();
  assert.equal(
    (
      f.service as unknown as typeof guard
    ).current.deliveryCoordinator.options.activationAllowed({
      credentialRef: "gh:github.com",
    }),
    true,
  );
});
