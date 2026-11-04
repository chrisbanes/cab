import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  symlink,
  writeFile,
} from "node:fs/promises";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import type { TestContext } from "node:test";
import type { z } from "zod";
import { stackedDeliveryFixture } from "../../fixtures/stacked-delivery.js";
import { git } from "../../fixtures/publication.js";
import { STANDALONE_MARKER_NAME } from "../../../src/standalone/data-directory.js";
import { codexHomeFor } from "../../../src/standalone/codex-home.js";
import { StandaloneService } from "../../../src/standalone/service.js";
import { materialDigest } from "../../../src/core/delivery.js";
import {
  GitHubHttpDeliveryProvider,
  deliveryDocuments,
} from "../../../src/standalone/github-delivery.js";
import { capturePreparedStackDatabase } from "./stack-resource-preflight.js";
import {
  StackV2Authority,
  authorityHash,
  materialHash,
  type stackAuthoritySchema,
} from "./stack-authority.js";
import { prepareStackV2Manifest } from "./stack-builders.js";

/** Entirely disposable, in-process HTTP/service qualification. Its env reference is never populated. */
export async function offlineStackResources(t: TestContext) {
  const f = await stackedDeliveryFixture(t),
    [lowerTask, upperTask] = f.tasks as [string, string];
  await f.waitTurn(lowerTask);
  const lowerHead = await f.commit(lowerTask, "offline-lower");
  await f.push(lowerTask, lowerHead);
  await f.showPr(lowerTask);
  await f.waitTurn(upperTask);
  const upperHead = await f.commit(upperTask, "offline-upper");
  await f.push(upperTask, upperHead);
  await f.showPr(upperTask, {
    baseRef: f.branchOf(lowerTask)!.branch,
    baseSha: lowerHead,
  });
  f.run({
    type: "project.configure",
    projectId: f.projectId,
    expectedVersion: Number(f.service.domain().project(f.projectId).version),
    paused: true,
  });
  for (const task of [lowerTask, upperTask]) {
    assert.equal(
      (
        await f.call(task, "cab_report_result", {
          summary: "offline preparation",
        })
      ).success,
      true,
    );
    await f.complete(task);
  }
  const lowerWorkspace = await f.workspaceOf(lowerTask),
    upperWorkspace = await f.workspaceOf(upperTask);
  const resource = {
    projectId: f.projectId,
    repository: "fixture/private",
    repositoryNodeId: "R1",
    visibility: "private" as const,
    repositoryDefaultBranch: "main",
    mergeCapabilities: {
      allow_merge_commit: true,
      allow_squash_merge: true,
      allow_rebase_merge: true,
    },
    actor: "offline",
    actorNodeId: "OFFLINE_ACTOR",
    lowerTask,
    upperTask,
    lowerPr: 1,
    upperPr: 2,
    lowerPrId: `PR-${lowerTask}`,
    upperPrId: `PR-${upperTask}`,
    lowerRef: f.branchOf(lowerTask)!.branch,
    upperRef: f.branchOf(upperTask)!.branch,
    lowerHead,
    upperHead,
    base: "main",
    baseSha: f.base,
    stackNumber: 7,
    stackId: "7",
    operationKey: randomUUID(),
    unstackCommandSha256: materialHash(null),
  };
  f.run({ type: "runtime.configure", harness: "codex", enabled: false });
  await f.service.stop();
  const data = join(f.root, "data"),
    database = join(data, "standalone.sqlite");
  const credentialRef = `env:CAB_OFFLINE_UNRESOLVABLE_${randomUUID().replaceAll("-", "").toUpperCase()}`;
  const repo = "/repos/fixture/private";
  let unstacked = false,
    retargeted = false;
  const graph = (n: number) => {
    const lower = n === 1,
      head = lower ? lowerHead : upperHead,
      base = lower || retargeted ? f.base : lowerHead;
    return {
      id: lower ? resource.lowerPrId : resource.upperPrId,
      number: n,
      repository: { id: "R1", nameWithOwner: resource.repository },
      baseRefName: lower || retargeted ? "main" : resource.lowerRef,
      headRefName: lower ? resource.lowerRef : resource.upperRef,
      headRefOid: head,
      baseRefOid: base,
      state: "OPEN",
      isDraft: true,
      merged: false,
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
      reviewDecision: null,
      isMergeQueueEnabled: false,
      closingIssuesReferences: {
        nodes: [],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
      baseRef: { target: { oid: base }, branchProtectionRule: null },
      reviewThreads: {
        nodes: [],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    };
  };
  const transport: typeof fetch = async (url, init) => {
    const u = new URL(String(url));
    assert.equal(u.origin, "https://api.github.com");
    const json = (body: unknown) => Response.json(body);
    if (init?.method === "POST" && u.pathname === `${repo}/stacks/7/unstack`) {
      assert.equal(init.body, undefined);
      unstacked = true;
      return new Response(null, { status: 204 });
    }
    if (init?.method === "PATCH" && u.pathname === `${repo}/pulls/2`) {
      assert.equal(unstacked, true);
      assert.equal(init.body, JSON.stringify({ base: "main" }));
      retargeted = true;
      return new Response(null, { status: 204 });
    }
    if (u.pathname === "/user")
      return json({ login: "offline", node_id: "OFFLINE_ACTOR" });
    if (u.pathname === "/graphql") {
      const body = JSON.parse(String(init?.body));
      return json({
        data: {
          node:
            body.query === deliveryDocuments.CabDeliveryRepository
              ? { id: "R1", nameWithOwner: resource.repository }
              : graph(body.variables.id === resource.lowerPrId ? 1 : 2),
        },
      });
    }
    if (u.pathname === repo)
      return json({
        node_id: "R1",
        full_name: resource.repository,
        visibility: "private",
        default_branch: "main",
        ...resource.mergeCapabilities,
      });
    for (const n of [1, 2])
      if (u.pathname === `${repo}/pulls/${n}`) {
        const p = graph(n);
        return json({
          node_id: p.id,
          number: n,
          state: "open",
          body: "offline",
          draft: true,
          merged: false,
          stack: unstacked
            ? null
            : {
                id: 7,
                number: 7,
                position: n,
                size: 2,
                base: { ref: "main", sha: f.base },
              },
          head: {
            sha: p.headRefOid,
            ref: p.headRefName,
            repo: { node_id: "R1" },
          },
          base: {
            sha: p.baseRefOid,
            ref: p.baseRefName,
            repo: { node_id: "R1" },
          },
        });
      }
    if (u.pathname === `${repo}/stacks/7`)
      return json({
        id: 7,
        number: 7,
        base: { ref: "main", sha: f.base },
        pull_requests: (unstacked ? [] : [1, 2]).map((n) => {
          const p = graph(n);
          return {
            node_id: p.id,
            number: n,
            state: "open",
            merged_at: null,
            head: { ref: p.headRefName, sha: p.headRefOid },
          };
        }),
      });
    if (u.pathname.includes("/git/ref/heads/")) {
      const ref = decodeURIComponent(u.pathname.split("/git/ref/heads/")[1]!);
      return json({
        ref: `refs/heads/${ref}`,
        object: {
          sha:
            ref === "main"
              ? f.base
              : ref === resource.lowerRef
                ? lowerHead
                : upperHead,
        },
      });
    }
    if (u.pathname.endsWith("/check-runs"))
      return json({ total_count: 0, check_runs: [] });
    if (u.pathname.includes("/protection"))
      return new Response(null, { status: 404 });
    if (
      ["/statuses", "/comments", "/reviews"].some((suffix) =>
        u.pathname.endsWith(suffix),
      ) ||
      u.pathname.includes("/rules/branches/")
    )
      return json([]);
    throw Error("offline-unexpected-request");
  };
  const db = new DatabaseSync(database);
  try {
    // Synthetic immutable-revision bytes are prepared before any grant or new service exists.
    const settings = JSON.stringify({
      harness: "codex",
      model: "offline-model",
      reasoningEffort: "medium",
    });
    db.prepare("UPDATE profiles SET runtime=?").run(settings);
    db.prepare("UPDATE profile_revisions SET runtime=?").run(settings);
    const row = db
      .prepare("SELECT policyJson FROM delivery_policies WHERE projectId=?")
      .get(f.projectId)!;
    const policy = JSON.parse(String(row.policyJson));
    policy.credentialRef = credentialRef;
    db.prepare(
      "UPDATE delivery_policies SET policyJson=? WHERE projectId=?",
    ).run(JSON.stringify(policy), f.projectId);
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    db.close();
  }
  // Prepare the exact API preview with the same actual provider and only in-process HTTP.
  // Runtime creation is absent and every transport response is synthetic.
  const preparationProvider = () =>
    new GitHubHttpDeliveryProvider(
      async () => "offline-preparation-marker",
      transport,
    );
  const preparation = new StandaloneService(
    data,
    () => {
      throw Error("offline-runtime-disabled");
    },
    undefined,
    {
      runtimeHarnesses: [],
      routingClient: null,
      power: { enabled: false },
      delivery: {
        providerFactories: { github: preparationProvider },
        issueTrackerFactories: { github: preparationProvider },
      },
      issueTrackers: {
        readerFactories: {
          github: () => {
            throw Error("offline-source-denied");
          },
        },
        intervalMs: 3600000,
      },
    },
  );
  let command!: {
    type: "task.unstack";
    key: string;
    taskId: string;
    expectedVersion: number;
    materialHash: string;
  };
  try {
    await preparation.start();
    const identity = await preparation.previewTaskUnstack(upperTask);
    command = {
      type: "task.unstack",
      key: resource.operationKey,
      taskId: upperTask,
      expectedVersion: identity.taskVersion,
      materialHash: materialDigest(identity),
    };
  } finally {
    await preparation.stop();
  }
  resource.unstackCommandSha256 = materialHash(command);
  const observed = capturePreparedStackDatabase(database);
  const sourceRoot = await realpath(
    fileURLToPath(new URL("../../../../", import.meta.url)),
  );
  const pin = async (path: string) => ({
    path,
    sha256: authorityHash(await readFile(path)),
  });
  const scratch = join(f.root, "scratch");
  await mkdir(scratch);
  const fakeExecutable = join(f.root, "INERT-NOT-A-RUNTIME");
  await writeFile(fakeExecutable, "offline-inert-file-never-executed");
  await chmod(fakeExecutable, 0o700);
  const fakeLogin = join(f.root, "offline-login");
  await mkdir(fakeLogin);
  const authTarget = join(fakeLogin, "auth.json");
  await writeFile(authTarget, "{}");
  const home = codexHomeFor(data);
  await mkdir(home.home, { recursive: true });
  await mkdir(home.userHome, { recursive: true });
  await symlink(authTarget, join(home.home, "auth.json"));
  const auth = await lstat(authTarget),
    common = await realpath(join(f.source, ".git"));
  await mkdir(join(common, "refs", "cab", "adopted"), { recursive: true });
  const gitExecutable = await pin(await realpath("/usr/bin/git")),
    runtimeExecutable = await pin(fakeExecutable);
  const sourceHeadFile = resolve(
    sourceRoot,
    git(sourceRoot, "rev-parse", "--git-path", "HEAD"),
  );
  const sourceBranch = git(sourceRoot, "symbolic-ref", "--short", "HEAD");
  const sourceRefFile = resolve(
    sourceRoot,
    git(sourceRoot, "rev-parse", "--git-path", `refs/heads/${sourceBranch}`),
  );
  const source = await Promise.all(
    (
      await readdir(join(sourceRoot, "src"), {
        recursive: true,
        withFileTypes: true,
      })
    )
      .filter((file) => file.isFile() && file.name.endsWith(".ts"))
      .map((file) =>
        pin(
          join(
            sourceRoot,
            "dist",
            "src",
            file.parentPath.slice(join(sourceRoot, "src").length),
            file.name.replace(/\.ts$/, ".js"),
          ),
        ),
      ),
  );
  for (const name of [
    "stack-authority",
    "stack-runtime",
    "stack-files",
    "stack-real-adapter",
    "stack-resource-preflight",
    "stack-real-journey",
    "stack-audit",
  ])
    source.push(
      await pin(
        join(
          sourceRoot,
          "dist/test/delivery/github-qualification",
          `${name}.js`,
        ),
      ),
    );
  source.push(
    await pin(
      join(sourceRoot, "test/delivery/github-qualification/live-stack.mjs"),
    ),
    await pin(sourceHeadFile),
    await pin(sourceRefFile),
  );
  const directories = await Promise.all(
    [
      f.root,
      data,
      scratch,
      common,
      lowerWorkspace.root,
      upperWorkspace.root,
      upperWorkspace.path,
    ].map(async (path) => {
      const info = await lstat(path);
      return { path, dev: info.dev, ino: info.ino };
    }),
  );
  const now = Date.now(),
    runId = randomUUID(),
    result = join(f.root, "v2-result.json");
  const request = (path: string, version = "2022-11-28", body = "") => ({
    url: `https://api.github.com${path}`,
    method: body ? ("POST" as const) : ("GET" as const),
    body,
    version: version as "2022-11-28" | "2026-03-10",
  });
  const reads: z.input<typeof stackAuthoritySchema>["reads"] = [];
  const add = (q: ReturnType<typeof request>, maxCalls = 16) =>
    reads.push({ id: `offline:${reads.length}`, request: q, maxCalls });
  add(request("/user"));
  add(request(repo));
  add(
    request(
      "/graphql",
      "2022-11-28",
      JSON.stringify({
        query: deliveryDocuments.CabDeliveryRepository,
        variables: { id: "R1" },
      }),
    ),
  );
  for (const [n, id] of [
    [1, resource.lowerPrId],
    [2, resource.upperPrId],
  ] as const) {
    add(request(`${repo}/pulls/${n}`, "2026-03-10"));
    add(
      request(
        "/graphql",
        "2022-11-28",
        JSON.stringify({
          query: deliveryDocuments.CabDeliveryPr,
          variables: { id, after: null },
        }),
      ),
    );
    for (const path of [
      `/issues/${n}/comments`,
      `/pulls/${n}/reviews`,
      `/pulls/${n}/comments`,
    ])
      add(request(`${repo}${path}?per_page=100`));
  }
  add(request(`${repo}/stacks/7`, "2026-03-10"));
  for (const ref of [resource.base, resource.lowerRef, resource.upperRef])
    add(
      request(
        `${repo}/git/ref/heads/${ref.split("/").map(encodeURIComponent).join("/")}`,
      ),
    );
  for (const ref of [resource.base, resource.lowerRef]) {
    add(request(`${repo}/rules/branches/${encodeURIComponent(ref)}`));
    add(request(`${repo}/branches/${encodeURIComponent(ref)}/protection`));
  }
  for (const sha of [lowerHead, upperHead]) {
    add(
      request(`${repo}/commits/${sha}/check-runs?per_page=100&filter=latest`),
    );
    add(request(`${repo}/commits/${sha}/statuses?per_page=100`));
  }
  const call = (
    id: z.input<typeof stackAuthoritySchema>["serviceCalls"][number]["id"],
    material: unknown,
    maxCalls = 1,
  ) => ({ id, materialSha256: materialHash(material), maxCalls });
  const authority: z.input<typeof stackAuthoritySchema> = {
    reads,
    writes: [
      {
        id: "offline:unstack",
        request: {
          url: `https://api.github.com${repo}/stacks/7/unstack`,
          method: "POST",
          body: "",
          version: "2026-03-10",
        },
        maxCalls: 1,
      },
      {
        id: "offline:retarget",
        request: {
          url: `https://api.github.com${repo}/pulls/2`,
          method: "PATCH",
          body: JSON.stringify({ base: "main" }),
          version: "2026-03-10",
        },
        maxCalls: 1,
      },
    ],
    captures: { mergeRuleId: null, maxFreshHeads: 1, maxFreshBases: 1 },
    serviceCalls: [
      call("host.source", {
        root: sourceRoot,
        branch: sourceBranch,
        commit: git(sourceRoot, "rev-parse", "HEAD"),
        tree: git(sourceRoot, "rev-parse", "HEAD^{tree}"),
      }),
      call("service.start", {
        dataDirectory: data,
        configSha256: observed.configSha256,
      }),
      call("service.stop", { dataDirectory: data }),
      call("service.unstack.preview", { taskId: upperTask }),
      call("service.unstack.execute", command),
      call("service.unstack.reconcile", {
        operationKey: resource.operationKey,
      }),
      call("service.operation.read", {
        scope: `task:${upperTask}`,
        type: "task.unstack",
        key: resource.operationKey,
      }),
      call(
        "service.observe",
        { taskId: upperTask, operationKey: resource.operationKey },
        2,
      ),
    ],
    host: {
      runRoot: f.root,
      resultPath: result,
      sourceRoot,
      sourceBranch,
      sourceHeadFile,
      sourceRefFile,
      toolchain: {
        nodeExecutable: await pin(await realpath(process.execPath)),
        nodeVersion: process.versions.node,
        nvmrc: await pin(join(sourceRoot, ".nvmrc")),
        packageJson: await pin(join(sourceRoot, "package.json")),
        lockfile: await pin(join(sourceRoot, "package-lock.json")),
        packageManager: "npm@12.2.1",
      },
      dataDirectory: data,
      scratchParent: scratch,
      files: [runtimeExecutable, await pin(join(data, STANDALONE_MARKER_NAME))],
      directories,
      gitExecutable,
      runtimeExecutable,
      runtimeCredential: { ...home, authTarget, dev: auth.dev, ino: auth.ino },
      runtimeVersion: "offline-inert-runtime-disabled",
      settingsSha256: materialHash(observed.runtimeSettings),
      configSha256: observed.configSha256,
      databaseFiles: [await pin(database)],
      schemaFingerprint: observed.schemaFingerprint,
      writes: [
        data,
        scratch,
        join(common, "objects"),
        join(common, "refs", "cab", "adopted"),
        authTarget,
      ],
      workspaceImage: { maxFiles: 100, maxBytes: 1048576 },
      teardownDeadline: new Date(now + 120000).toISOString(),
    },
    gitFetch: {
      repositoryUrl: "https://github.com/fixture/private.git",
      workspace: upperWorkspace.path,
      commonDirectory: common,
      executable: gitExecutable,
      scratchParent: scratch,
      commits: [lowerHead, upperHead, f.base],
      branch: resource.upperRef,
      maxFetches: 0,
      maxChildren: 32,
      maxObjectBytes: 1048576,
      maxElapsedMs: 1000,
    },
    runtime: observed.assignments.map((assignment) => {
      const settings = observed.runtimeSettings.find(
          (value) => value.assignmentId === assignment.id,
        )!,
        lead = observed.leads.find(
          (value) => value.assignmentId === assignment.id,
        )!;
      return {
        taskId: assignment.taskId,
        assignmentId: assignment.id,
        threadId: null,
        workspace:
          assignment.taskId === lowerTask
            ? lowerWorkspace.root
            : upperWorkspace.root,
        model: "offline-model",
        effort: "medium",
        settingsSha256: settings.settingsSha256,
        policySha256: materialHash({ networkAccess: false }),
        taskVersions: [
          observed.tasks.find((task) => task.id === assignment.taskId)!.version,
        ],
        assignmentVersions: [assignment.version],
        instructionsRevision: lead.instructionsRevision,
        profileRevision: lead.profileRevision,
        maxPromptBytes: 1024,
        maxTurns: 0,
        maxCallbacks: 0,
      };
    }),
    limits: {
      reads: 128,
      writes: 2,
      credentials: 8,
      credentialCallbacks: 128,
      callbacks: 0,
      turns: 0,
      firstEffects: 8,
      serviceCalls: 12,
      gitFetches: 0,
    },
  };
  const prepared = prepareStackV2Manifest(
    {
      version: 2,
      runId,
      scenario: "unstack-healthy",
      resource,
      credentialRef,
      authority,
      unstackCommand: command,
      journey: { maxObservations: 1, settlePolls: 1, pollIntervalMs: 250 },
    },
    {
      version: 2,
      runId,
      observedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 60000).toISOString(),
      source,
      sourceCommit: git(sourceRoot, "rev-parse", "HEAD"),
      sourceTree: git(sourceRoot, "rev-parse", "HEAD^{tree}"),
      configSha256: observed.configSha256,
      settingsSha256: authority.host.settingsSha256,
      runtimeVersion: authority.host.runtimeVersion,
      runtimeCredentialRef: `codex-login:${authTarget}`,
      credentialRef,
      hostId: hostname(),
    },
  );
  const grant = JSON.stringify({
    ...prepared.grantBindings,
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 60000).toISOString(),
    teardownDeadline: authority.host.teardownDeadline,
  });
  const paths = {
    manifest: join(f.root, "OFFLINE-manifest"),
    grant: join(f.root, "OFFLINE-grant"),
    readiness: join(f.root, "OFFLINE-readiness"),
  };
  await writeFile(paths.manifest, prepared.manifest);
  await writeFile(paths.grant, grant);
  await writeFile(paths.readiness, prepared.readiness);
  const guard = new StackV2Authority(
    prepared.manifest,
    grant,
    prepared.readiness,
    result,
    Date.now,
    paths,
  );
  return {
    guard,
    resource,
    credentialRef,
    fakeLogin,
    transport,
    paths,
    result,
    command,
    preparedSummary: {
      schemaFingerprint: observed.schemaFingerprint,
      configMatches: observed.configSha256 === authority.host.configSha256,
      projects: observed.projects.length,
      tasks: observed.tasks.length,
      assignments: observed.assignments.length,
      leads: observed.leads.length,
      unsafeExecutions: observed.unsafeExecutions,
      holds: observed.holds,
      sources: observed.sources,
    },
  };
}
