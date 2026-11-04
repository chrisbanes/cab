import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

const opened: StackV2Authority[] = [];
after(async () => {
  for (const guard of opened) await guard.close();
});

import {
  authorityHash,
  materialHash,
  StackV2Authority,
} from "./github-qualification/stack-authority.js";

async function fixture(
  feedback = false,
  runtimeEnabled = false,
  gitEnabled = false,
  mergeScenario = false,
) {
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
  const credentialStamp = await stat(file);
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
      resultPath: join(root, "result"),
      sourceRoot: root,
      sourceBranch: "cb/offline",
      sourceHeadFile: file,
      sourceRefFile: file,
      toolchain: {
        nodeExecutable: pin,
        nodeVersion: "offline",
        nvmrc: pin,
        packageJson: pin,
        lockfile: pin,
        packageManager: "npm@12.2.1",
      },
      dataDirectory: data,
      scratchParent: scratch,
      files: [pin],
      directories: [{ path: root, dev: stamp.dev, ino: stamp.ino }],
      gitExecutable: pin,
      runtimeExecutable: pin,
      runtimeCredential: {
        home: root,
        userHome: root,
        authTarget: file,
        dev: credentialStamp.dev,
        ino: credentialStamp.ino,
      },
      runtimeVersion: "offline",
      settingsSha256: materialHash(null),
      configSha256: materialHash(null),
      databaseFiles: [],
      schemaFingerprint: materialHash(null),
      writes: [join(root, "result")],
      workspaceImage: { maxFiles: 100, maxBytes: 1048576 },
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
      maxChildren: 0,
      maxObjectBytes: 1024,
      maxElapsedMs: 1000,
    },
    runtime: [taskA, taskB].map((taskId) => ({
      taskId,
      assignmentId: randomUUID(),
      threadId: null,
      workspace,
      model: "offline",
      effort: "medium",
      settingsSha256: materialHash(null),
      policySha256: materialHash({ networkAccess: false }),
      taskVersions: [1],
      assignmentVersions: [1],
      instructionsRevision: 1,
      profileRevision: 1,
      maxPromptBytes: 65536,
      maxTurns: 0,
      maxCallbacks: 0,
    })),
    limits: {
      reads: 1,
      writes: 0,
      credentials: 1,
      credentialCallbacks: 2,
      callbacks: 0,
      turns: 0,
      firstEffects: 0,
      serviceCalls: 1,
      gitFetches: 0,
    },
  };
  if (runtimeEnabled) {
    const scope = authority.runtime[0]!;
    scope.maxTurns = 2;
    scope.maxCallbacks = 2;
    authority.runtime[1]!.workspace = join(root, "other-workspace");
    await mkdir(authority.runtime[1]!.workspace);
    const lifecycle = {
      executable: authority.host.runtimeExecutable,
      version: authority.host.runtimeVersion,
    };
    authority.serviceCalls = [
      {
        id: "runtime.start",
        materialSha256: materialHash(lifecycle),
        maxCalls: 1,
      },
      {
        id: "runtime.stop",
        materialSha256: materialHash(lifecycle),
        maxCalls: 1,
      },
      {
        id: "runtime.thread.start",
        materialSha256: materialHash({
          ...scope,
          toolsSha256: materialHash([]),
        }),
        maxCalls: 1,
      },
      {
        id: "runtime.thread.resume",
        materialSha256: materialHash({
          ...scope,
          toolsSha256: materialHash([]),
        }),
        maxCalls: 1,
      },
      {
        id: "runtime.turn",
        materialSha256: materialHash({
          taskId: scope.taskId,
          assignmentId: scope.assignmentId,
          workspace: scope.workspace,
          settingsSha256: scope.settingsSha256,
          policySha256: scope.policySha256,
        }),
        maxCalls: 2,
      },
      {
        id: "runtime.wait",
        materialSha256: materialHash({
          taskId: scope.taskId,
          assignmentId: scope.assignmentId,
        }),
        maxCalls: 2,
      },
    ];
    authority.limits.turns = 2;
    authority.limits.callbacks = 2;
    authority.limits.serviceCalls = 12;
    authority.limits.firstEffects = 12;
  }
  const resource = {
    projectId: randomUUID(),
    repository: "offline/inert",
    repositoryNodeId: "OFFLINE_REPOSITORY",
    visibility: "private",
    repositoryDefaultBranch: "main",
    mergeCapabilities: {
      allow_merge_commit: true,
      allow_squash_merge: true,
      allow_rebase_merge: true,
    },
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
    stackId: "1",
    operationKey: randomUUID(),
    unstackCommandSha256: materialHash(null),
  };
  const gitMaterial = {
    host: "github.com",
    repositoryId: resource.repositoryNodeId,
    workspacePath: workspace,
    branch: resource.upperRef,
    oldBase: resource.lowerHead,
    oldHead: resource.upperHead,
    newBase: resource.baseSha,
    newHead: resource.upperHead,
  };
  if (gitEnabled) {
    authority.serviceCalls.push({
      id: "git.prove",
      materialSha256: materialHash({
        repositoryId: resource.repositoryNodeId,
        repositoryUrl: authority.gitFetch.repositoryUrl,
        workspacePath: workspace,
        commonDirectory: common,
        branch: resource.upperRef,
        commits: authority.gitFetch.commits,
      }),
      maxCalls: 1,
    });
    authority.gitFetch.maxFetches = 1;
    authority.gitFetch.maxChildren = 1;
    authority.limits.gitFetches = 1;
    authority.limits.firstEffects = 3;
    authority.limits.serviceCalls = 2;
  }
  if (feedback) {
    authority.reads = [1, 2].flatMap((n) =>
      [
        `/issues/${n}/comments`,
        `/pulls/${n}/reviews`,
        `/pulls/${n}/comments`,
      ].map((path, index) => ({
        id: `feedback:${n}:${index}`,
        request: {
          ...req,
          url: `https://api.github.com/repos/offline/inert${path}?per_page=100`,
        },
        maxCalls: 1,
      })),
    );
    authority.limits.reads = 6;
  }
  const readiness = JSON.stringify({
    version: 2,
    runId,
    observedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 60000).toISOString(),
    resourceSha256: materialHash(resource),
    authoritySha256: materialHash(authority),
    source: [pin],
    sourceCommit: "1".repeat(40),
    sourceTree: "1".repeat(40),
    configSha256: authority.host.configSha256,
    settingsSha256: authority.host.settingsSha256,
    runtimeVersion: "offline",
    runtimeCredentialRef: "offline:inert",
    credentialRef: "offline:unresolvable",
    hostId: "offline",
  });
  const manifest = JSON.stringify({
    version: 2,
    runId,
    scenario: mergeScenario ? "merge-adoption" : "unstack-healthy",
    journey: { maxObservations: 1, settlePolls: 1, pollIntervalMs: 250 },
    unstackCommand: null,
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
  const inputPaths = {
    manifest: join(root, "manifest.json"),
    grant: join(root, "grant.json"),
    readiness: join(root, "readiness.json"),
  };
  const guard = (bindInputs = false) => {
    if (bindInputs) {
      writeFileSync(inputPaths.manifest, manifest);
      writeFileSync(inputPaths.grant, grant);
      writeFileSync(inputPaths.readiness, readiness);
    }
    const guard = new StackV2Authority(
      manifest,
      grant,
      readiness,
      join(root, "result"),
      () => clock,
      bindInputs ? inputPaths : undefined,
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
    inputPaths,
    requests: authority.reads.map((rule) => rule.request),
    gitMaterial,
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
  await g.beforeCredential({ ...f.req, method: "GET", version: "2022-11-28" });
  await g.beforeDispatch({ ...f.req, method: "GET", version: "2022-11-28" });
  assert.equal(g.snapshot().counts.reads, 1);
  await assert.rejects(f.guard().open(), /EEXIST/);
  await assert.rejects(
    g.beforeDispatch({ ...f.req, method: "GET", version: "2022-11-28" }),
    /v2-dispatch-without-request-reservation/,
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

test("v2 admits exactly six separately reserved captured PR feedback reads", async () => {
  const f = await fixture(true),
    guard = f.guard();
  await guard.open();
  assert.equal(f.requests.length, 6);
  for (const request of f.requests) {
    await guard.beforeCredential(request);
    await guard.beforeDispatch(request);
    await guard.transportInvoked(request);
    await guard.afterResponse(request, new Response("[]"));
  }
  assert.equal(guard.snapshot().counts.reads, 6);
  assert.equal(guard.snapshot().counts.readTransportInvocations, 6);
  assert.equal(
    guard
      .snapshot()
      .httpRequests.filter((ticket) => ticket.phase === "responded").length,
    6,
  );
  assert.equal(guard.snapshot().counts.credentials, undefined);
  await assert.rejects(guard.beforeCredential(f.requests[0]!), /v2-budget/);
});

for (const [name, change] of [
  [
    "number",
    {
      url: "https://api.github.com/repos/offline/inert/issues/3/comments?per_page=100",
    },
  ],
  [
    "query",
    {
      url: "https://api.github.com/repos/offline/inert/issues/1/comments?per_page=100&extra=1",
    },
  ],
  [
    "page",
    {
      url: "https://api.github.com/repos/offline/inert/issues/1/comments?per_page=100&page=2",
    },
  ],
  ["body", { body: "{}" }],
  ["version", { version: "2026-03-10" }],
] as const)
  test(`v2 feedback changed ${name} refuses before credential lookup`, async () => {
    const f = await fixture(true),
      guard = f.guard();
    await guard.open();
    await assert.rejects(
      guard.beforeCredential({ ...f.requests[0]!, ...change }),
      /v2-unlisted-request/,
    );
    assert.equal(guard.snapshot().counts.credentials, undefined);
    assert.equal(guard.snapshot().httpRequests.length, 0);
  });

test("v2 feedback pagination refuses after one counted transport without capturing text", async () => {
  const f = await fixture(true),
    guard = f.guard();
  await guard.open();
  const request = f.requests[0]!;
  await guard.beforeCredential(request);
  await guard.beforeDispatch(request);
  await guard.transportInvoked(request);
  await assert.rejects(
    guard.afterResponse(
      request,
      new Response("[]", {
        headers: { link: '<https://api.github.com/next>; rel="next"' },
      }),
    ),
    /v2-response-page-or-redirect/,
  );
  assert.equal(guard.snapshot().counts.readTransportInvocations, 1);
  assert.deepEqual(guard.snapshot().captures, {});
});

import type {
  Runtime,
  RuntimeToolCall,
  RuntimeToolResult,
} from "../../src/standalone/codex.js";
import {
  bindStackRuntime,
  type StackRuntimeService,
} from "./github-qualification/stack-runtime.js";

async function runtimeFixture(
  options: {
    deferStart?: boolean;
    startFailure?: boolean;
    exitProof?: boolean;
    nullIdentity?: boolean;
    boundInputs?: boolean;
    mergeScenario?: boolean;
  } = {},
) {
  const f = await fixture(false, true, false, options.mergeScenario),
    guard = f.guard(options.boundInputs);
  await guard.open();
  const scope = guard.manifest.authority.runtime[0]!;
  const identity = {
    processId: "12345",
    processStartedAt: "offline-birth",
    bootId: "offline-boot",
  };
  const calls = { starts: 0, turns: 0, stops: 0, callbacks: 0 };
  let listener:
    | ((call: RuntimeToolCall) => Promise<RuntimeToolResult>)
    | undefined;
  let turnPause: (() => Promise<void>) | undefined;
  let identityHook: (() => void) | undefined;
  let intent: ReturnType<StackRuntimeService["list"]>[number] = {
    workId: "offline-work-1",
    state: "submitting",
    threadId: "offline-thread",
    turnId: null,
    workspace: scope.workspace,
    prompt: "offline-private-prompt",
  };
  let sequence = 1;
  const port: StackRuntimeService = {
    list: () => [intent],
    turnRequest: (workId) =>
      workId !== intent.workId
        ? undefined
        : {
            taskId: scope.taskId,
            assignmentId: scope.assignmentId,
            projectId: guard.manifest.resource.projectId,
            workspace: scope.workspace,
            prompt: intent.prompt,
            taskVersion: 1,
            assignmentVersion: 1,
            instructionsRevision: 1,
            profileRevision: 1,
            sequence,
          },
  };
  const fake: Runtime = {
    start: async () => {
      calls.starts++;
      if (options.startFailure) throw Error("offline-unknown-start");
    },
    stop: async () => {
      calls.stops++;
    },
    processIdentity: () => {
      identityHook?.();
      return options.nullIdentity ? null : identity;
    },
    startThread: async () => "offline-thread",
    resumeThread: async () => {},
    startTurn: async () => {
      calls.turns++;
      await turnPause?.();
      return `offline-turn-${calls.turns}`;
    },
    waitForTurn: async () => "completed",
    interruptTurn: async () => {},
    onUnexpectedRequest: () => {},
    onToolCall: (value) => {
      listener = value;
    },
  };
  const runtime = bindStackRuntime(fake, guard, () => port, {
    verify: async (processIdentity) =>
      options.exitProof === false
        ? { kind: "unknown", reason: "offline-exit-unproved" }
        : {
            kind: "verified",
            processIdentity,
            verifiedAt: new Date().toISOString(),
            method: "mac-pid-absent-same-boot",
          },
  });
  runtime.onToolCall!(async () => {
    calls.callbacks++;
    return { success: true, text: "offline" };
  });
  if (!options.deferStart) {
    await runtime.start();
    await runtime.startThread(scope.workspace);
  }
  return {
    ...f,
    guard,
    runtime,
    scope,
    calls,
    pause: (value: () => Promise<void>) => {
      turnPause = value;
    },
    onIdentity: (value: () => void) => {
      identityHook = value;
    },
    continuation: () => {
      sequence++;
      intent = {
        ...intent,
        workId: `offline-work-${sequence}`,
        state: "submitting",
        turnId: null,
      };
    },
    running: (turnId: string) => {
      intent = { ...intent, state: "running", turnId };
    },
    invoke: (call: RuntimeToolCall) => listener!(call),
    turn: () =>
      runtime.startTurn(
        "offline-thread",
        scope.workspace,
        intent.prompt,
        undefined,
        { networkAccess: false },
      ),
  };
}

test("real runtime boundary gates every continuation and denies a third turn before fake runtime effect", async () => {
  const f = await runtimeFixture();
  assert.equal(await f.turn(), "offline-turn-1");
  await f.runtime.waitForTurn("offline-thread", "offline-turn-1");
  f.continuation();
  await f.runtime.resumeThread(
    "offline-thread",
    [],
    undefined,
    f.scope.workspace,
  );
  assert.equal(
    f.guard.snapshot().effects[`runtime:resume:${f.scope.assignmentId}:0`]
      ?.boundaryIntentSha256,
    materialHash({
      threadId: "offline-thread",
      workspace: f.scope.workspace,
      assignmentId: f.scope.assignmentId,
    }),
  );
  await assert.rejects(
    f.runtime.resumeThread("foreign-thread", [], undefined, f.scope.workspace),
    /v2-uncaptured-thread-refused/,
  );
  assert.equal(await f.turn(), "offline-turn-2");
  f.continuation();
  await assert.rejects(f.turn(), /v2-budget/);
  assert.equal(f.calls.turns, 2);
  assert.equal(f.guard.snapshot().runtimeBindings.length, 2);
  assert.equal(f.guard.snapshot().counts.turns, 2);
  await f.runtime.stop();
  assert.equal(f.calls.stops, 1);
  assert.equal(f.guard.snapshot().processExit, true);
});

test("returned turn after authority expiry remains unbound and original process still has scoped teardown", async () => {
  const f = await runtimeFixture();
  f.pause(async () => f.expire());
  await assert.rejects(f.turn(), /v2-authority-closed/);
  assert.equal(f.calls.turns, 1);
  assert.equal(f.guard.snapshot().runtimeBindings.length, 0);
  assert.equal(
    f.guard.snapshot().effects["runtime:turn:offline-work-1"]?.state,
    "reserved",
  );
  await f.runtime.stop();
  assert.equal(f.guard.snapshot().processExit, true);
});

test("runtime callbacks require exact current turn and permitted prepared callback before service effect", async () => {
  const f = await runtimeFixture();
  const turnId = await f.turn();
  f.running(turnId);
  const call = {
    threadId: "offline-thread",
    turnId,
    callId: "offline-call",
    tool: "cab_report_result",
    arguments: { summary: "offline result" },
  };
  await assert.rejects(
    f.invoke({ ...call, turnId: "historical-turn" }),
    /v2-callback-current-execution/,
  );
  await assert.rejects(
    f.invoke({ ...call, tool: "cab_external_action" }),
    /v2-cab-callback-not-granted/,
  );
  assert.equal(f.calls.callbacks, 0);
  await f.invoke(call);
  assert.equal(f.calls.callbacks, 1);
  assert.equal(f.guard.snapshot().callbacks[0]?.state, "ended");
  assert.ok(
    !JSON.stringify(f.guard.snapshot()).includes("offline-private-prompt"),
  );
  assert.ok(!JSON.stringify(f.guard.snapshot()).includes("offline result"));
  await assert.rejects(f.invoke(call), /v2-callback-already-attempted/);
  await f.runtime.stop();
});

test("source revocation blocks a new turn but leaves original owned process stop available", async () => {
  const f = await runtimeFixture();
  await writeFile(f.file, "revoked-source");
  await assert.rejects(f.turn(), /v2-source-pin/);
  assert.equal(f.calls.turns, 0);
  await f.runtime.stop();
  assert.equal(f.calls.stops, 1);
  assert.equal(f.guard.snapshot().processExit, true);
});

test("merge runtime registers its exact existing PR before reporting", async () => {
  const f = await runtimeFixture({ mergeScenario: true });
  const turnId = await f.turn();
  f.running(turnId);
  const r = f.guard.manifest.resource;
  await f.invoke({
    threadId: "offline-thread",
    turnId,
    callId: "initial-register",
    tool: "cab_register_pr",
    arguments: {
      repositoryId: r.repositoryNodeId,
      prNumber: r.lowerPr,
      expectedPrNodeId: r.lowerPrId,
      expectedHeadSha: r.lowerHead,
    },
  });
  await f.invoke({
    threadId: "offline-thread",
    turnId,
    callId: "initial-report",
    tool: "cab_report_result",
    arguments: { summary: "initial result" },
  });
  assert.equal(f.calls.callbacks, 2);
  assert.equal(f.guard.snapshot().callbacks.length, 2);
  await f.runtime.stop();
});

for (const refusal of [
  "report-before-registration",
  "repeat-registration",
] as const)
  test(`merge runtime refuses ${refusal} before its service mutation`, async () => {
    const f = await runtimeFixture({ mergeScenario: true });
    const turnId = await f.turn();
    f.running(turnId);
    const r = f.guard.manifest.resource;
    const register = {
      threadId: "offline-thread",
      turnId,
      callId: "initial-register",
      tool: "cab_register_pr",
      arguments: {
        repositoryId: r.repositoryNodeId,
        prNumber: r.lowerPr,
        expectedPrNodeId: r.lowerPrId,
        expectedHeadSha: r.lowerHead,
      },
    };
    if (refusal === "repeat-registration") await f.invoke(register);
    await assert.rejects(
      f.invoke(
        refusal === "repeat-registration"
          ? { ...register, callId: "second-register" }
          : {
              threadId: "offline-thread",
              turnId,
              callId: "initial-report",
              tool: "cab_report_result",
              arguments: { summary: "initial result" },
            },
      ),
      refusal === "repeat-registration"
        ? /v2-registration-already-attempted/
        : /v2-initial-registration-required/,
    );
    assert.equal(f.calls.callbacks, refusal === "repeat-registration" ? 1 : 0);
    await f.runtime.stop();
  });

for (const revoked of ["source", "grant", "readiness"] as const) {
  test(`revoked ${revoked} refuses a new result callback before service mutation`, async () => {
    const f = await runtimeFixture({ boundInputs: true });
    const turnId = await f.turn();
    f.running(turnId);
    const path = revoked === "source" ? f.file : f.inputPaths[revoked];
    await writeFile(path, "revoked-bound-input");
    await assert.rejects(
      f.invoke({
        threadId: "offline-thread",
        turnId,
        callId: "revoked-result",
        tool: "cab_report_result",
        arguments: { summary: "must not reach the service" },
      }),
      /v2-source-pin/,
    );
    assert.equal(f.calls.callbacks, 0);
    assert.equal(f.guard.snapshot().callbacks.length, 0);
    await f.runtime.stop();
    assert.equal(f.calls.stops, 1);
    assert.equal(f.guard.snapshot().processExit, true);
  });
}

test("source revoked after callback reservation cannot reach its listener, but completion evidence settles", async () => {
  const f = await runtimeFixture();
  const turnId = await f.turn();
  f.running(turnId);
  let revoked = false;
  f.onIdentity(() => {
    if (!revoked && f.guard.snapshot().callbacks.length === 1) {
      revoked = true;
      writeFileSync(f.file, "revoked-after-reservation");
    }
  });
  await assert.rejects(
    f.invoke({
      threadId: "offline-thread",
      turnId,
      callId: "reserved-result",
      tool: "cab_report_result",
      arguments: { summary: "must not reach the service" },
    }),
    /v2-source-pin/,
  );
  assert.equal(f.calls.callbacks, 0);
  assert.equal(f.guard.snapshot().callbacks.length, 1);
  assert.equal(f.guard.snapshot().callbacks[0]?.state, "ended");
  assert.equal(f.guard.snapshot().callbacks[0]?.invoked, false);
  assert.equal(f.guard.snapshot().callbacks[0]?.succeeded, false);
  await f.runtime.stop();
  assert.equal(f.guard.snapshot().processExit, true);
});

test("runtime records assembled and request prompts separately with the service default network-off policy", async () => {
  const f = await runtimeFixture();
  await f.runtime.startTurn(
    "offline-thread",
    f.scope.workspace,
    "assembled private instructions",
    undefined,
    undefined,
  );
  const detail =
    f.guard.snapshot().effects["runtime:turn:offline-work-1"]!.runtimeIntent!;
  assert.equal(
    detail.promptSha256,
    authorityHash("assembled private instructions"),
  );
  assert.equal(
    detail.requestPromptSha256,
    authorityHash("offline-private-prompt"),
  );
  assert.equal(detail.argumentsPolicySha256, materialHash(null));
  assert.equal(f.guard.snapshot().counts["invocations:runtime.turn"], 1);
  await f.runtime.stop();
});

test("a callback emitted during start waits for exact durable turn and service handback", async () => {
  const f = await runtimeFixture();
  let callback: Promise<RuntimeToolResult> | undefined;
  f.pause(async () => {
    callback = f.invoke({
      threadId: "offline-thread",
      turnId: "offline-turn-1",
      callId: "early-offline-call",
      tool: "cab_report_result",
      arguments: { summary: "offline early result" },
    });
    void callback.catch(() => {});
  });
  const turn = await f.turn();
  f.running(turn);
  assert.ok(callback);
  await callback;
  assert.equal(f.calls.callbacks, 1);
  assert.equal(f.guard.snapshot().counts.callbackInvocations, 1);
  assert.equal(f.guard.snapshot().callbacks[0]?.state, "ended");
  await f.runtime.stop();
});

test("post-reservation request drift cannot release a native turn", async () => {
  const f = await runtimeFixture();
  f.onIdentity(() => f.continuation());
  await assert.rejects(f.turn(), /v2-turn-intent-changed/);
  assert.equal(f.calls.turns, 0);
  assert.equal(
    f.guard.snapshot().counts["invocations:runtime.turn"],
    undefined,
  );
  await f.runtime.stop();
});

test("an unknown start retains its original attempt and permits only owned-process teardown", async () => {
  const f = await runtimeFixture({ deferStart: true, startFailure: true });
  await assert.rejects(f.runtime.start(), /offline-unknown-start/);
  assert.equal(f.calls.starts, 1);
  assert.equal(f.guard.snapshot().effects["runtime:start"]?.invoked, true);
  await assert.rejects(f.runtime.start(), /v2-call-unlisted-or-spent/);
  assert.equal(f.calls.starts, 1);
  await f.runtime.stop();
  assert.equal(f.calls.stops, 1);
  assert.equal(f.guard.snapshot().processExit, true);
});

for (const startFailure of [false, true])
  test(`null startup identity permits exact runtime-owned cleanup without exit proof (start failure: ${startFailure})`, async () => {
    const f = await runtimeFixture({
      deferStart: true,
      nullIdentity: true,
      startFailure,
    });
    await assert.rejects(
      f.runtime.start(),
      startFailure ? /offline-unknown-start/ : /v2-runtime-process-unproved/,
    );
    assert.equal(f.calls.starts, 1);
    await assert.rejects(f.runtime.stop(), /v2-stop-process-unproved/);
    assert.equal(f.calls.stops, 1);
    assert.equal(f.guard.snapshot().effects["runtime:stop"]?.invoked, true);
    assert.equal(f.guard.snapshot().effects["runtime:stop"]?.state, "reserved");
    assert.equal(f.guard.snapshot().processExit, false);
    assert.equal(f.guard.snapshot().process, null);
    assert.throws(() => f.guard.current(), /v2-authority-closed/);
    await assert.rejects(f.runtime.stop(), /v2-call-unlisted-or-spent/);
    assert.equal(f.calls.stops, 1);
  });

test("unproved process exit never becomes a receipt or a repeated stop", async () => {
  const f = await runtimeFixture({ exitProof: false });
  await assert.rejects(f.runtime.stop(), /v2-process-exit-unproved/);
  assert.equal(f.guard.snapshot().processExit, false);
  assert.equal(f.calls.stops, 1);
  await assert.rejects(f.runtime.stop(), /v2-call-unlisted-or-spent/);
  assert.equal(f.calls.stops, 1);
});

test("static direct Git grant accepts only response-captured future SHAs before any fetch", async () => {
  const f = await fixture(false, false, true),
    manifest = stackV2ManifestSchema.parse(JSON.parse(f.manifest)),
    r = manifest.resource;
  const repo = `https://api.github.com/repos/${r.repository}`;
  const requests = [
    {
      url: `${repo}/pulls/${r.upperPr}`,
      method: "GET" as const,
      body: "",
      version: "2026-03-10" as const,
    },
    {
      url: "https://api.github.com/graphql",
      method: "POST" as const,
      version: "2022-11-28" as const,
      body: JSON.stringify({
        query: deliveryDocuments.CabDeliveryPr,
        variables: { id: r.upperPrId, after: null },
      }),
    },
    ...[r.upperRef, r.base].map((ref) => ({
      url: `${repo}/git/ref/heads/${ref.split("/").map(encodeURIComponent).join("/")}`,
      method: "GET" as const,
      body: "",
      version: "2022-11-28" as const,
    })),
  ];
  requests.forEach((request, i) => {
    manifest.authority.reads.push({ id: `fresh-${i}`, request, maxCalls: 1 });
  });
  manifest.authority.limits.reads = 5;
  const ready = stackV2ReadinessSchema.parse(JSON.parse(f.readiness));
  ready.authoritySha256 = materialHash(manifest.authority);
  const readiness = JSON.stringify(ready);
  manifest.readinessSha256 = authorityHash(readiness);
  const raw = JSON.stringify(manifest),
    grant = stackV2GrantSchema.parse(JSON.parse(f.grant));
  grant.manifestSha256 = authorityHash(raw);
  grant.readinessSha256 = authorityHash(readiness);
  grant.authoritySha256 = ready.authoritySha256;
  const guard = new StackV2Authority(
    raw,
    JSON.stringify(grant),
    readiness,
    join(f.root, "result"),
  );
  opened.push(guard);
  await guard.open();
  const request = {
    ...f.gitMaterial,
    newBase: "4".repeat(40),
    newHead: "3".repeat(40),
  };
  await assert.rejects(guard.beforeGit("prove", request), /v2-git-material/);
  const bodies = [
    {
      node_id: r.upperPrId,
      number: r.upperPr,
      stack: null,
      head: {
        ref: r.upperRef,
        sha: request.newHead,
        repo: { node_id: r.repositoryNodeId },
      },
      base: {
        ref: r.base,
        sha: request.newBase,
        repo: { node_id: r.repositoryNodeId },
      },
    },
    {
      data: {
        node: {
          id: r.upperPrId,
          repository: { id: r.repositoryNodeId },
          headRefName: r.upperRef,
          baseRefName: r.base,
          headRefOid: request.newHead,
          baseRefOid: request.newBase,
          closingIssuesReferences: {
            nodes: [],
            pageInfo: { hasNextPage: false },
          },
          reviewThreads: { pageInfo: { hasNextPage: false } },
        },
      },
    },
    { ref: `refs/heads/${r.upperRef}`, object: { sha: request.newHead } },
    { ref: `refs/heads/${r.base}`, object: { sha: request.newBase } },
  ];
  for (let i = 0; i < requests.length; i++) {
    const read = requests[i]!;
    await guard.beforeCredential(read);
    await guard.beforeDispatch(read);
    await guard.transportInvoked(read);
    await guard.afterResponse(read, Response.json(bodies[i]));
  }
  assert.equal(guard.snapshot().captures.upperHead, request.newHead);
  assert.equal(guard.snapshot().captures.baseSha, request.newBase);
  await assert.rejects(
    guard.beforeGit("prove", { ...request, newHead: "5".repeat(40) }),
    /v2-git-material/,
  );
  await guard.beforeGit("prove", request);
  assert.equal(
    guard.snapshot().effects[`git:prove:${materialHash(request)}`]
      ?.boundaryIntentSha256,
    materialHash(request),
  );
  assert.equal(guard.snapshot().counts.credentials, undefined);
  assert.equal(guard.snapshot().gitChildren.length, 0);
});

test("unknown direct Git child retains its original intent and refuses teardown before cleanup", async () => {
  const f = await fixture(false, false, true),
    guard = f.guard();
  await guard.open();
  const scope = await guard.beforeGit("prove", f.gitMaterial);
  assert.equal(
    guard.snapshot().effects[`git:prove:${materialHash(f.gitMaterial)}`]
      ?.boundaryIntentSha256,
    materialHash(f.gitMaterial),
  );
  await scope.fixtureBoundary.beforeEffect("locate");
  const sequence = await scope.fixtureBoundary.beforeChild();
  await assert.rejects(
    scope.fixtureBoundary.afterChild(sequence, {
      status: "interrupted",
      kind: "timed-out",
      spawned: true,
      childExitObserved: false,
      childExitSignal: null,
    }),
    /v2-git-child-exit-unproved/,
  );
  assert.equal(guard.snapshot().gitChildren[0]?.state, "unknown");
  await assert.rejects(
    scope.fixtureBoundary.beforeEffect("teardown"),
    /v2-git-teardown-unproved/,
  );
  await assert.rejects(guard.beforeCredential(f.req), /v2-authority-closed/);
  assert.equal(guard.snapshot().counts.credentials, undefined);
});

test("counter persistence failure refuses before credentials and preserves original atomic artifact", async () => {
  const f = await fixture(),
    guard = f.guard();
  await guard.open();
  const artifact = join(f.root, "result.tmp");
  await writeFile(artifact, "original-unfinished-artifact");
  await assert.rejects(guard.beforeCredential(f.req), /EEXIST/);
  assert.equal(guard.snapshot().counts.credentials, undefined);
  await assert.rejects(guard.beforeCredentialLookup(), /v2-authority-closed/);
  const closing = guard.close();
  assert.strictEqual(guard.close(), closing);
  await assert.rejects(closing, /EEXIST/);
  opened.splice(opened.indexOf(guard), 1); // The expected failed close is already asserted; never retry it.
  assert.equal(
    await readFile(artifact, "utf8"),
    "original-unfinished-artifact",
  );
});

import { materialDigest } from "../../src/core/delivery.js";
import { unstackRecordSchema } from "../../src/core/unstack.js";
import { operationReadSchema } from "../../src/operator/contracts.js";
import { deliveryDocuments } from "../../src/standalone/github-delivery.js";
import {
  type auditPreparedStack,
  fullUnstackProof,
} from "./github-qualification/stack-audit.js";
import {
  stackV2GrantSchema,
  stackV2ManifestSchema,
  stackV2ReadinessSchema,
} from "./github-qualification/stack-authority.js";
import { stackV2Schemas } from "./github-qualification/stack-builders.js";
import type { createRealStackAdapter } from "./github-qualification/stack-real-adapter.js";
import { runRealStackJourney } from "./github-qualification/stack-real-journey.js";

for (const field of ["manifest", "grant", "readiness"] as const)
  test(`v2 missing ${field} refuses before any owned effect`, async () => {
    const f = await fixture();
    assert.throws(
      () =>
        new StackV2Authority(
          field === "manifest" ? "{}" : f.manifest,
          field === "grant" ? "{}" : f.grant,
          field === "readiness" ? "{}" : f.readiness,
          join(f.root, "result"),
        ),
    );
  });

test("queued actual invocation evidence is persisted before close while new effects refuse", async () => {
  const f = await fixture(),
    guard = f.guard();
  await guard.open();
  await guard.beforeCredential(f.req);
  await guard.beforeDispatch(f.req);
  const observation = guard.transportInvoked(f.req),
    closing = guard.close();
  await observation;
  await closing;
  const disk = JSON.parse(await readFile(join(f.root, "result"), "utf8"));
  assert.equal(disk.closed, true);
  assert.equal(disk.counts.readTransportInvocations, 1);
  assert.equal(disk.httpRequests[0].phase, "invoked");
  await assert.rejects(guard.beforeCredentialLookup(), /v2-authority-closed/);
});

test("v2 input schemas are machine readable without issuing a grant", () => {
  const schemas = stackV2Schemas();
  for (const schema of Object.values(schemas))
    assert.equal(schema.type, "object");
  assert.ok(schemas.manifest.required?.includes("readinessSha256"));
  assert.ok(schemas.grant.required?.includes("authoritySha256"));
});

async function originalJourney(wrongReceipt = false) {
  const f = await fixture(),
    guard = f.guard(),
    r = guard.manifest.resource;
  const identity = {
    projectId: r.projectId,
    taskId: r.upperTask,
    projectVersion: 1,
    taskVersion: 1,
    policyVersion: 1,
    deliveryRevision: 1,
    authorityDigest: "a".repeat(64),
    repositoryId: r.repositoryNodeId,
    repositoryPath: `/repos/${r.repository}`,
    pr: {
      nodeId: r.upperPrId,
      number: r.upperPr,
      headRef: r.upperRef,
      headSha: r.upperHead,
      baseRef: r.lowerRef,
    },
    targetBaseRef: r.base,
    edge: {
      blockerTaskId: r.lowerTask,
      repositoryId: r.repositoryNodeId,
      parentHead: r.lowerHead,
      settledHead: null,
      restack: "current",
      restackFromSha: null,
      restackSeq: 0,
      recordedAt: 0,
      seq: 1,
    },
    stack: {
      id: Number(r.stackId),
      number: r.stackNumber,
      baseRef: r.base,
      members: [
        {
          nodeId: r.lowerPrId,
          number: r.lowerPr,
          headRef: r.lowerRef,
          headSha: r.lowerHead,
          state: "OPEN",
        },
        {
          nodeId: r.upperPrId,
          number: r.upperPr,
          headRef: r.upperRef,
          headSha: r.upperHead,
          state: "OPEN",
        },
      ],
    },
  };
  const record = unstackRecordSchema.parse({
    operationId: r.operationKey,
    command: {
      key: r.operationKey,
      taskId: r.upperTask,
      expectedVersion: 1,
      materialHash: materialDigest(identity),
    },
    identity,
    phase: "unstack-attempting",
    revision: 1,
    reason: "readback-required",
    removed: false,
    retargetRejected: false,
    newBaseSha: null,
    noEffect: null,
    createdAt: 0,
    updatedAt: 0,
  });
  const audit: ReturnType<typeof auditPreparedStack> = {
    taskId: r.upperTask,
    targetBaseRef: r.base,
    acceptedBaseRef: r.lowerRef,
    headSha: r.upperHead,
    baseSha: r.lowerHead,
    proofs: [],
    branch: null,
    edge: {
      blockerTaskId: r.lowerTask,
      repositoryId: r.repositoryNodeId,
      parentHead: r.lowerHead,
      restackSeq: 0,
      restack: "current",
    },
    selectedSequence: 1,
    selectedEdgeActive: true,
    selectedRetired: false,
    eventCount: 0,
    writerHolds: 0,
    unfinished: 0,
    operation: {
      operationId: r.operationKey,
      phase: record.phase,
      removed: false,
      newBaseSha: null,
      originalSequence: 1,
      originalRestackSequence: 0,
    },
  };
  const calls = {
    start: 0,
    stop: 0,
    preview: 0,
    execute: 0,
    reconciles: [] as string[],
    receipts: 0,
  };
  const denied = async (): Promise<never> => {
    throw Error("offline-ungranted-path");
  };
  const factory: typeof createRealStackAdapter = async (authority) => {
    await authority.open();
    return {
      authority,
      image: async () => ({
        head: r.upperHead,
        index: "a".repeat(64),
        files: "b".repeat(64),
      }),
      observeProvider: denied,
      mergeLower: denied,
      pollMerge: denied,
      executions: () => [],
      refresh: denied,
      preview: async () => {
        calls.preview++;
        return denied();
      },
      unstack: async () => {
        calls.execute++;
        return denied();
      },
      reconcile: async (key) => {
        calls.reconciles.push(key);
        return record;
      },
      receipt: async () => {
        calls.receipts++;
        return operationReadSchema.parse({
          data: {
            state: "recorded",
            receipt: {
              kind: "task-unstack",
              key: wrongReceipt ? randomUUID() : r.operationKey,
              taskId: r.upperTask,
              recorded: true,
              expectedVersion: 1,
              materialHash: record.command.materialHash,
              phase: "unstack-attempting",
              revision: 1,
              reason: "readback-required",
            },
          },
          observedAt: 0,
        });
      },
      audit: async () => audit,
      start: async () => {
        calls.start++;
      },
      stop: async () => {
        calls.stop++;
      },
    };
  };
  return {
    guard,
    audit,
    calls,
    run: () =>
      runRealStackJourney({
        authority: guard,
        credential: async () => {
          throw Error("offline-no-credential");
        },
        factory,
      }),
  };
}

test("actual journey preserves an original partial journal without preview, reexecution, rekey or invented success", async () => {
  const f = await originalJourney();
  const result = await f.run();
  assert.equal(result.mode, "offline-injected");
  assert.equal(result.disposition, "held");
  assert.equal(f.calls.preview, 0);
  assert.equal(f.calls.execute, 0);
  assert.deepEqual(f.calls.reconciles, [
    f.guard.manifest.resource.operationKey,
  ]);
  assert.equal(f.calls.receipts, 1);
  assert.equal(f.calls.stop, 1);
  assert.equal(f.audit.selectedEdgeActive, true);
  assert.equal(f.audit.eventCount, 0);
  assert.equal(f.guard.snapshot().closed, true);
});

test("actual journey refuses another receipt identity and still performs its owned teardown", async () => {
  const f = await originalJourney(true);
  await assert.rejects(f.run(), /v2-original-receipt-binding/);
  assert.equal(f.calls.execute, 0);
  assert.equal(f.calls.stop, 1);
  assert.equal(f.guard.snapshot().closed, true);
});

test("a confirmed receipt cannot substitute for exact generation, base and one-event restack proof", async () => {
  const f = await originalJourney();
  const complete = {
    ...f.audit,
    acceptedBaseRef: f.audit.targetBaseRef,
    baseSha: f.guard.manifest.resource.baseSha,
    selectedEdgeActive: false,
    selectedRetired: true,
    eventCount: 1,
    edge: {
      ...f.audit.edge!,
      parentHead: f.guard.manifest.resource.baseSha,
      restackSeq: 1,
    },
    operation: {
      ...f.audit.operation!,
      phase: "confirmed" as const,
      removed: true,
      newBaseSha: f.guard.manifest.resource.baseSha,
    },
  };
  assert.equal(fullUnstackProof(complete), true);
  assert.equal(fullUnstackProof({ ...complete, selectedSequence: 2 }), false);
  assert.equal(fullUnstackProof({ ...complete, eventCount: 2 }), false);
  assert.equal(
    fullUnstackProof({
      ...complete,
      edge: { ...complete.edge, restackSeq: 2 },
    }),
    false,
  );
  assert.equal(
    fullUnstackProof({
      ...complete,
      acceptedBaseRef: f.guard.manifest.resource.lowerRef,
    }),
    false,
  );
});

async function mergeCaptureFixture() {
  const f = await fixture(),
    manifest = stackV2ManifestSchema.parse(JSON.parse(f.manifest)),
    r = manifest.resource;
  manifest.scenario = "merge-adoption";
  manifest.resource.stackId = "1";
  const repo = `https://api.github.com/repos/${r.repository}`;
  const stack = {
    url: `${repo}/stacks/${r.stackNumber}`,
    method: "GET",
    body: "",
    version: "2026-03-10",
  };
  const graph = {
    url: "https://api.github.com/graphql",
    method: "POST",
    version: "2022-11-28",
    body: JSON.stringify({
      query: deliveryDocuments.CabDeliveryPr,
      variables: { id: r.lowerPrId, after: null },
    }),
  };
  const merge = {
    url: `${repo}/pulls/${r.lowerPr}/merge-async`,
    method: "PUT",
    version: "2026-03-10",
    body: JSON.stringify({
      sha: r.lowerHead,
      merge_method: "rebase",
      bypass_rules: false,
      merge_action: "direct_merge",
    }),
  };
  manifest.authority.reads.push(
    {
      id: "initial-stack",
      request: { ...stack, method: "GET", version: "2026-03-10" },
      maxCalls: 1,
    },
    {
      id: "lower-graph",
      request: { ...graph, method: "POST", version: "2022-11-28" },
      maxCalls: 1,
    },
    {
      id: "original-poll",
      request: {
        url: `${merge.url}/__CAB_MERGE_REQUEST__`,
        method: "GET",
        version: "2022-11-28",
        body: "",
      },
      maxCalls: 1,
    },
  );
  manifest.authority.writes.push({
    id: "lower-merge",
    request: { ...merge, method: "PUT", version: "2026-03-10" },
    maxCalls: 1,
  });
  manifest.authority.captures.mergeRuleId = "lower-merge";
  manifest.authority.limits.reads = 4;
  manifest.authority.limits.writes = 1;
  manifest.authority.limits.firstEffects = 1;
  const ready = stackV2ReadinessSchema.parse(JSON.parse(f.readiness));
  ready.resourceSha256 = materialHash(manifest.resource);
  ready.authoritySha256 = materialHash(manifest.authority);
  const readiness = JSON.stringify(ready);
  manifest.readinessSha256 = authorityHash(readiness);
  const raw = JSON.stringify(manifest),
    grant = stackV2GrantSchema.parse(JSON.parse(f.grant));
  grant.resourceSha256 = ready.resourceSha256;
  grant.manifestSha256 = authorityHash(raw);
  grant.readinessSha256 = authorityHash(readiness);
  grant.authoritySha256 = ready.authoritySha256;
  const guard = new StackV2Authority(
    raw,
    JSON.stringify(grant),
    readiness,
    join(f.root, "result"),
  );
  opened.push(guard);
  await guard.open();
  const respond = async (
    request: typeof stack,
    body: unknown,
    status = 200,
  ) => {
    await guard.beforeCredential(request);
    await guard.beforeDispatch(request);
    await guard.transportInvoked(request);
    await guard.afterResponse(request, Response.json(body, { status }));
  };
  await respond(stack, {
    id: 1,
    number: r.stackNumber,
    base: { ref: r.base },
    pull_requests: [r.lowerPr, r.upperPr].map((number) => ({
      node_id: number === r.lowerPr ? r.lowerPrId : r.upperPrId,
      number,
      head: {
        ref: number === r.lowerPr ? r.lowerRef : r.upperRef,
        sha: number === r.lowerPr ? r.lowerHead : r.upperHead,
      },
      state: "open",
      merged_at: null,
    })),
  });
  await respond(graph, {
    data: {
      node: {
        id: r.lowerPrId,
        number: r.lowerPr,
        repository: { id: r.repositoryNodeId },
        headRefName: r.lowerRef,
        baseRefName: r.base,
        headRefOid: r.lowerHead,
        closingIssuesReferences: {
          nodes: [],
          pageInfo: { hasNextPage: false },
        },
        reviewThreads: { pageInfo: { hasNextPage: false } },
      },
    },
  });
  return { guard, merge, respond, root: f.root };
}

for (const status of [202, 409])
  test(`merge UUID capture binds actual ${status} producer and original intent forbids resend`, async () => {
    const f = await mergeCaptureFixture();
    const uuid = "offline-observed-id";
    await f.respond(f.merge, { status: "pending", details: { uuid } }, status);
    assert.equal(f.guard.snapshot().captures.mergeRequest, uuid);
    assert.equal(
      f.guard.snapshot().captureEvidence.mergeRequest?.ruleId,
      "lower-merge",
    );
    const request = {
      url: `${f.merge.url}/${encodeURIComponent(uuid)}`,
      method: "GET",
      version: "2022-11-28",
      body: "",
    };
    await f.guard.beforeCredential(request); // The UUID came from the matching original response.
    await assert.rejects(
      f.guard.beforeCredential(f.merge),
      /v2-original-merge-readback-only/,
    );
    assert.equal(f.guard.snapshot().counts.writeTransportInvocations, 1);
  });

test("a merge without an observed UUID remains original/unknown and cannot invent a poll or resend", async () => {
  const f = await mergeCaptureFixture();
  await assert.rejects(
    f.respond(f.merge, { status: "pending", details: {} }, 202),
  );
  assert.equal(f.guard.snapshot().captures.mergeRequest, undefined);
  assert.equal(f.guard.snapshot().counts.writeTransportInvocations, 1);
  await assert.rejects(
    f.guard.beforeCredential(f.merge),
    /v2-authority-closed/,
  );
});

test("an unresolved UUID template is not a grantable literal provider request", async () => {
  const f = await mergeCaptureFixture();
  await assert.rejects(
    f.guard.beforeCredential({
      url: `${f.merge.url}/__CAB_MERGE_REQUEST__`,
      method: "GET",
      body: "",
      version: "2022-11-28",
    }),
    /v2-unresolved-capture/,
  );
  assert.equal(f.guard.snapshot().counts.credentials, undefined);
  assert.equal(f.guard.snapshot().counts.writeTransportInvocations, undefined);
});
