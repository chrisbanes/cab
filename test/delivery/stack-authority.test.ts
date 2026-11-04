import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, realpath, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
const opened: StackV2Authority[] = [];
after(async () => {
  for (const guard of opened) await guard.close();
});
import {
  StackV2Authority,
  authorityHash,
  materialHash,
} from "./github-qualification/stack-authority.js";

async function fixture() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "cab-authority-offline-")),
  );
  const data = join(root, "data"),
    scratch = join(root, "scratch"),
    workspace = join(root, "workspace"),
    common = join(root, "common");
  for (const p of [data, scratch, workspace, common]) await mkdir(p);
  const file = join(root, "not-an-executable");
  await writeFile(file, "offline-inert-test-input");
  const pin = { path: file, sha256: authorityHash("offline-inert-test-input") };
  const stamp = await stat(root);
  const runId = randomUUID(),
    taskA = randomUUID(),
    taskB = randomUUID();
  const now = Date.now();
  let clock = now;
  const req = {
    url: "https://api.github.com/user",
    method: "GET",
    body: "",
    version: "2022-11-28",
  };
  const authority = {
    reads: [{ id: "actor", request: req, maxCalls: 1 }],
    writes: [],
    captures: { mergeRuleId: null, maxFreshHeads: 1, maxFreshBases: 1 },
    serviceCalls: [
      {
        id: "service.refresh",
        materialSha256: materialHash({ projectId: "offline" }),
        maxCalls: 1,
      },
    ],
    host: {
      runRoot: root,
      dataDirectory: data,
      scratchParent: scratch,
      files: [pin],
      directories: [{ path: root, dev: stamp.dev, ino: stamp.ino }],
      gitExecutable: pin,
      runtimeExecutable: pin,
      runtimeVersion: "offline",
      settingsSha256: materialHash(null),
      configSha256: materialHash(null),
      writes: [join(root, "result")],
      teardownDeadline: new Date(now + 120000).toISOString(),
    },
    gitFetch: {
      repositoryUrl: "https://github.com/offline/inert.git",
      workspace,
      commonDirectory: common,
      executable: pin,
      scratchParent: scratch,
      commits: ["1".repeat(40), "2".repeat(40)],
      branch: "fixture/upper",
      maxFetches: 0,
      maxObjectBytes: 1024,
      maxElapsedMs: 1000,
    },
    runtime: [taskA, taskB].map((taskId) => ({
      taskId,
      assignmentId: randomUUID(),
      workspace,
      settingsSha256: materialHash(null),
      maxTurns: 0,
    })),
    limits: {
      reads: 1,
      writes: 0,
      credentials: 1,
      turns: 0,
      firstEffects: 0,
      serviceCalls: 1,
      gitFetches: 0,
    },
  };
  const resource = {
    projectId: randomUUID(),
    repository: "offline/inert",
    repositoryNodeId: "OFFLINE_REPOSITORY",
    actor: "offline",
    actorNodeId: "OFFLINE_ACTOR",
    lowerTask: taskA,
    upperTask: taskB,
    lowerPr: 1,
    upperPr: 2,
    lowerPrId: "OFFLINE_LOWER",
    upperPrId: "OFFLINE_UPPER",
    lowerRef: "fixture/lower",
    upperRef: "fixture/upper",
    lowerHead: "1".repeat(40),
    upperHead: "2".repeat(40),
    base: "main",
    baseSha: "1".repeat(40),
    stackNumber: 1,
    stackId: "OFFLINE_STACK",
    operationKey: "offline-original",
    unstackCommandSha256: materialHash(null),
  };
  const readiness = JSON.stringify({
    version: 2,
    runId,
    observedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 60000).toISOString(),
    resourceSha256: materialHash(resource),
    authoritySha256: materialHash(authority),
    source: [pin],
    configSha256: authority.host.configSha256,
    settingsSha256: authority.host.settingsSha256,
    runtimeVersion: "offline",
    credentialRef: "offline:unresolvable",
    hostId: "offline",
  });
  const manifest = JSON.stringify({
    version: 2,
    runId,
    scenario: "unstack-healthy",
    resource,
    credentialRef: "offline:unresolvable",
    readinessSha256: authorityHash(readiness),
    authority,
  });
  const grant = JSON.stringify({
    version: 2,
    runId,
    manifestSha256: authorityHash(manifest),
    readinessSha256: authorityHash(readiness),
    authoritySha256: materialHash(authority),
    resourceSha256: materialHash(resource),
    credentialRef: "offline:unresolvable",
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 60000).toISOString(),
    teardownDeadline: authority.host.teardownDeadline,
  });
  const guard = () => {
    const guard = new StackV2Authority(
      manifest,
      grant,
      readiness,
      join(root, "result"),
      () => clock,
    );
    opened.push(guard);
    return guard;
  };
  return {
    guard,
    req,
    root,
    file,
    manifest,
    grant,
    readiness,
    expire: () => {
      clock = now + 60000;
    },
  };
}

test("v2 refuses mismatched independent grant before host or credential effects", async () => {
  const f = await fixture();
  assert.throws(
    () =>
      new StackV2Authority(
        f.manifest,
        f.grant.replace('"version":2', '"version":1'),
        f.readiness,
        join(f.root, "result"),
      ),
  );
});

test("v2 reserves real credential lookups separately and never resets exhausted counters", async () => {
  const f = await fixture(),
    g = f.guard();
  await g.open();
  await g.beforeCredential(f.req);
  await g.beforeCredentialLookup();
  assert.equal(g.snapshot().counts.credentials, 1);
  await assert.rejects(g.beforeCredentialLookup(), /v2-budget/);
  await assert.rejects(g.beforeDispatch(f.req), /v2-authority-closed/);
});

test("v2 request mismatch refuses before spending credential allowance", async () => {
  const f = await fixture(),
    g = f.guard();
  await g.open();
  await assert.rejects(
    g.beforeCredential({
      ...f.req,
      method: "GET",
      version: "2022-11-28",
      url: "https://api.github.com/user?extra=1",
    }),
    /v2-unlisted-request/,
  );
  assert.equal(g.snapshot().counts.credentials, undefined);
});

test("v2 dispatch count is durable before dispatch and cannot be reset by reopening", async () => {
  const f = await fixture(),
    g = f.guard();
  await g.open();
  await g.beforeDispatch({ ...f.req, method: "GET", version: "2022-11-28" });
  assert.equal(g.snapshot().counts.reads, 1);
  await assert.rejects(f.guard().open(), /EEXIST/);
  await assert.rejects(
    g.beforeDispatch({ ...f.req, method: "GET", version: "2022-11-28" }),
    /v2-budget/,
  );
});

test("v2 changed source pin and expired grants stop effects", async () => {
  const f = await fixture(),
    g = f.guard();
  await g.open();
  await writeFile(f.file, "changed");
  await assert.rejects(
    g.reserve("service.refresh", { projectId: "offline" }, "refresh"),
    /v2-source-pin/,
  );
  const h = await fixture(),
    expired = h.guard();
  await expired.open();
  h.expire();
  await assert.rejects(
    expired.beforeCredential({
      ...h.req,
      method: "GET",
      version: "2022-11-28",
    }),
    /v2-authority-closed/,
  );
});

test("v2 refuses direct Git before credential or child effects when material differs", async () => {
  const f = await fixture(),
    g = f.guard();
  await g.open();
  await assert.rejects(
    g.beforeGit("prove", {
      host: "github.com",
      nameWithOwner: "other/repository",
    }),
    /v2-git-material/,
  );
  assert.equal(g.snapshot().counts.credentials, undefined);
});
