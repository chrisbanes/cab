import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { z } from "zod";
import type { Runtime } from "../../src/standalone/codex.js";
import { GitLabDiscoveryFailure } from "../../src/standalone/gitlab-discovery.js";
import { OperatorApi } from "../../src/standalone/operator-api.js";
import { StandaloneService } from "../../src/standalone/service.js";
import { createFakeGlab, fakeGlabToken } from "../fixtures/fake-glab.js";
import { tmpdir } from "../fixtures/temp.js";

class IdleRuntime implements Runtime {
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

const host = "gitlab.example.com";
const ENV_NAME = "FIXTURE_GL_CREDENTIAL";
const ENV_VALUE = "glpat-env-service-canary-311";

async function fixture(t: { after: (fn: () => void | Promise<void>) => void }) {
  for (const name of [ENV_NAME, "GITLAB_TOKEN"]) {
    const previous = process.env[name];
    t.after(() => {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    });
    delete process.env[name];
  }
  const glab = createFakeGlab();
  const dataDir = join(mkdtempSync(join(tmpdir(), "cab-gitlab-")), "data");
  const service = new StandaloneService(
    dataDir,
    () => new IdleRuntime(),
    undefined,
    {
      runtimeHarnesses: ["codex"],
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
  const tokens: string[] = [];
  const api = new OperatorApi(service, [dataDir], undefined, undefined, {
    glabExecutable: glab.executable,
    gitlab: (_host, token) => {
      tokens.push(token);
      return {
        user: async () => {
          if (token === "glpat-rejected")
            throw new GitLabDiscoveryFailure("unauthorized");
          return { username: "fake-user" };
        },
        projects: async () => ({
          projects: [
            {
              repositoryId: "42",
              projectPath: "group/app",
              defaultBranch: "main",
            },
          ],
          truncated: false,
        }),
      };
    },
  });
  const configure = (credentialRef: string | null, forHost = host) =>
    api.execute({
      type: "code-host-credential.configure",
      key: randomUUID(),
      codeHost: "gitlab",
      host: forHost,
      credentialRef,
    });
  return { glab, api, service, configure, tokens };
}

test("a glab credential is configured, reported with its account and cleared without exposing the token", async (t) => {
  const f = await fixture(t);
  const receipt = await f.configure(`glab:${host}`);
  assert.ok("result" in receipt);
  assert.deepEqual(receipt.result, {
    commandType: "code-host-credential.configure",
    resourceId: `system:code-host-credential:gitlab:${host}`,
    configured: true,
  });
  assert.equal(JSON.stringify(receipt).includes("glab:"), false);
  const status = await f.api.readCodeHostCredentials();
  assert.deepEqual(status.data.credentials, [
    {
      codeHost: "gitlab",
      host,
      kind: "glab",
      state: "usable",
      account: "fake-user",
      glabOverridden: false,
    },
  ]);
  assert.deepEqual(f.tokens, [fakeGlabToken]);
  assert.equal(JSON.stringify(status).includes(fakeGlabToken), false);

  const projects = await f.api.readGitLabProjects(
    new URLSearchParams({ host }),
  );
  assert.equal(projects.data.state, "ready");
  assert.deepEqual(
    (
      await f.api.readGitLabProjects(
        new URLSearchParams({ host: "other.example.com" }),
      )
    ).data,
    { state: "unavailable", reason: "unconfigured" },
  );

  await f.configure(null);
  assert.deepEqual(
    (await f.api.readCodeHostCredentials()).data.credentials,
    [],
  );
});

test("a glab reference for another host is refused as invalid input", async (t) => {
  const f = await fixture(t);
  // The operator HTTP layer answers a ZodError as 400 invalid-input.
  await assert.rejects(
    f.configure("glab:other.example.com"),
    (e: unknown) =>
      e instanceof z.ZodError &&
      e.issues[0]?.path.join(".") === "credentialRef",
  );
  assert.deepEqual(f.service.domain().codeHostCredentials(), []);
});

test("glab states give specific reasons and a token variable is reported as an override", async (t) => {
  const f = await fixture(t);
  await f.configure(`glab:${host}`);
  const reason = async () => {
    const [c] = (await f.api.readCodeHostCredentials()).data.credentials;
    return c?.state === "unavailable" ? c.reason : c?.state;
  };
  f.glab.set("not-signed-in");
  assert.equal(await reason(), "glab-not-signed-in");
  f.glab.set("unreadable");
  assert.equal(await reason(), "glab-unreadable");
  f.glab.set("network-error");
  assert.equal(await reason(), "glab-unreachable");
  assert.deepEqual(await f.api.codeHostCredentialLocalState(), {
    configured: true,
    unusable: true,
    unreachable: true,
    overridden: false,
  });
  f.glab.set("signed-in");
  assert.equal(await reason(), "usable");

  process.env.GITLAB_TOKEN = "glpat-shadow-311";
  const [overridden] = (await f.api.readCodeHostCredentials()).data.credentials;
  assert.equal(overridden?.glabOverridden, true);
  assert.deepEqual(await f.api.codeHostCredentialLocalState(), {
    configured: true,
    unusable: false,
    unreachable: false,
    overridden: true,
  });
  delete process.env.GITLAB_TOKEN;

  const missing = await fixture(t);
  await missing.configure(`glab:${host}`);
  const absent = new OperatorApi(missing.service, [], undefined, undefined, {
    glabExecutable: missing.glab.missing,
  });
  const [c] = (await absent.readCodeHostCredentials()).data.credentials;
  assert.equal(c?.state === "unavailable" && c.reason, "glab-not-installed");
});

test("an environment variable reference reports its kind and usability, never its name or value", async (t) => {
  const f = await fixture(t);
  await f.configure(`env:${ENV_NAME}`);
  const read = async () =>
    JSON.stringify(await f.api.readCodeHostCredentials());
  let text = await read();
  assert.match(text, /"reason":"missing-credential"/);
  process.env[ENV_NAME] = ENV_VALUE;
  text = await read();
  assert.match(text, /"kind":"env"/);
  assert.match(text, /"state":"usable"/);
  assert.match(text, /"account":"fake-user"/);
  assert.deepEqual(f.tokens, [ENV_VALUE]);
  for (const secret of [ENV_NAME, ENV_VALUE])
    assert.equal(text.includes(secret), false);
  const receipt = JSON.stringify(await f.configure(`env:${ENV_NAME}`));
  assert.equal(receipt.includes(ENV_NAME), false);
  assert.equal(f.glab.commands().length, 0, "an env reference never runs glab");
});

test("the GitLab credentials readiness input is local and names an override", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await f.api.codeHostCredentialLocalState(), {
    configured: false,
    unusable: false,
    unreachable: false,
    overridden: false,
  });
  await f.configure(`env:${ENV_NAME}`);
  assert.equal((await f.api.codeHostCredentialLocalState()).unusable, true);
  assert.equal(f.tokens.length, 0, "no GitLab request is made");
});
