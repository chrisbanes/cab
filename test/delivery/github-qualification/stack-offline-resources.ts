import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  symlink,
  writeFile,
} from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import type { z } from "zod";
import { materialDigest } from "../../../src/core/delivery.js";
import { codexHomeFor } from "../../../src/standalone/codex-home.js";
import { coordinationTools } from "../../../src/standalone/coordination-tools.js";
import { STANDALONE_MARKER_NAME } from "../../../src/standalone/data-directory.js";
import {
  deliveryDocuments,
  GitHubHttpDeliveryProvider,
} from "../../../src/standalone/github-delivery.js";
import { StandaloneService } from "../../../src/standalone/service.js";
import { git } from "../../fixtures/publication.js";
import { stackedDeliveryFixture } from "../../fixtures/stacked-delivery.js";
import {
  authorityHash,
  materialHash,
  StackV2Authority,
  type stackAuthoritySchema,
} from "./stack-authority.js";
import { prepareStackV2Manifest } from "./stack-builders.js";
import { freshOfflineStack } from "./stack-offline-preparation.js";
import {
  capturePreparedStackDatabase,
  captureSourceReferencePaths,
} from "./stack-resource-preflight.js";

/** Entirely disposable, in-process HTTP/service qualification. Its env reference is never populated. */
export async function offlineStackResources(
  t: TestContext,
  mergeAdoption = false,
  platformRebase: "immediate" | "delayed" | "absent" = "immediate",
  offlineReadBudget = 256,
) {
  const fresh = mergeAdoption ? await freshOfflineStack(t) : undefined;
  const legacy = fresh ? undefined : await stackedDeliveryFixture(t);
  const f = fresh ?? legacy!,
    [lowerTask, upperTask] = f.tasks as [string, string];
  let lowerHead: string, upperHead: string;
  if (fresh) {
    lowerHead = fresh.lowerHead;
    upperHead = fresh.upperHead;
  } else {
    const f = legacy!;
    await f.waitTurn(lowerTask);
    lowerHead = await f.commit(lowerTask, "offline-lower");
    await f.push(lowerTask, lowerHead);
    await f.showPr(lowerTask);
    await f.waitTurn(upperTask);
    upperHead = await f.commit(upperTask, "offline-upper");
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
  if (!fresh)
    f.run({ type: "runtime.configure", harness: "codex", enabled: false });
  await f.service.stop();
  const data = join(f.root, "data"),
    database = join(data, "standalone.sqlite");
  const credentialRef = `env:CAB_OFFLINE_UNRESOLVABLE_${randomUUID().replaceAll("-", "").toUpperCase()}`;
  const repo = "/repos/fixture/private";
  let unstacked = false,
    retargeted = false,
    merged = false,
    rebased = false,
    upperObservations = 0;
  const trace: Array<{ url: string; method: string; body: string }> = [];
  const providerHeads: Array<{
    channel: "rest" | "graph" | "ref";
    head: string;
    merged: boolean;
    rebased: boolean;
    observation: number;
  }> = [];
  const recordUpperHead = (channel: "rest" | "graph" | "ref", head: string) => {
    providerHeads.push({
      channel,
      head,
      merged,
      rebased,
      observation: upperObservations,
    });
  };
  const graph = (n: number) => {
    const lower = n === 1,
      head = lower ? lowerHead : rebased ? fresh!.rebasedHead : upperHead,
      base =
        lower || retargeted || rebased
          ? merged
            ? fresh!.mergedBase
            : f.base
          : lowerHead;
    return {
      id: lower ? resource.lowerPrId : resource.upperPrId,
      number: n,
      repository: { id: "R1", nameWithOwner: resource.repository },
      baseRefName: lower || retargeted || rebased ? "main" : resource.lowerRef,
      headRefName: lower ? resource.lowerRef : resource.upperRef,
      headRefOid: head,
      baseRefOid: base,
      state: lower && merged ? "MERGED" : "OPEN",
      isDraft: false,
      merged: lower && merged,
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
    trace.push({
      url: u.href,
      method: init?.method ?? "GET",
      body: String(init?.body ?? ""),
    });
    assert.equal(u.origin, "https://api.github.com");
    const json = (body: unknown) => Response.json(body);
    if (
      init?.method === "PUT" &&
      u.pathname === `${repo}/pulls/1/merge-async`
    ) {
      assert.equal(mergeAdoption, true);
      assert.equal(
        init.body,
        JSON.stringify({
          sha: lowerHead,
          merge_method: "squash",
          bypass_rules: false,
          merge_action: "direct_merge",
        }),
      );
      merged = true;
      git(f.source, "update-ref", "refs/heads/main", fresh!.mergedBase);
      if (platformRebase === "immediate") {
        rebased = true;
        git(
          f.source,
          "update-ref",
          `refs/heads/${resource.upperRef}`,
          fresh!.rebasedHead,
        );
      }
      return Response.json(
        { status: "pending", details: { uuid: "offline-merge" } },
        { status: 202 },
      );
    }
    if (u.pathname === `${repo}/pulls/2` && merged) {
      upperObservations++;
      if (platformRebase === "delayed" && upperObservations === 2) {
        rebased = true;
        git(
          f.source,
          "update-ref",
          `refs/heads/${resource.upperRef}`,
          fresh!.rebasedHead,
        );
      }
    }
    if (u.pathname === `${repo}/pulls/1/merge-async/offline-merge`)
      return json({ status: "merged", details: { uuid: "offline-merge" } });
    if (
      u.pathname === `${repo}/pulls` &&
      u.searchParams.get("head") === `fixture:${resource.lowerRef}`
    )
      return json([
        {
          node_id: resource.lowerPrId,
          number: 1,
          state: merged ? "closed" : "open",
          merged_at: merged ? "2026-11-04T00:00:00Z" : null,
          head: { ref: resource.lowerRef, repo: { node_id: "R1" } },
          base: { ref: "main" },
        },
      ]);
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
      const node =
        body.query === deliveryDocuments.CabDeliveryRepository
          ? { id: "R1", nameWithOwner: resource.repository }
          : graph(body.variables.id === resource.lowerPrId ? 1 : 2);
      if (body.variables.id === resource.upperPrId && "headRefOid" in node)
        recordUpperHead("graph", node.headRefOid);
      return json({ data: { node } });
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
        if (n === 2) recordUpperHead("rest", p.headRefOid);
        return json({
          node_id: p.id,
          number: n,
          state: n === 1 && merged ? "closed" : "open",
          body: "offline",
          draft: false,
          merged: n === 1 && merged,
          stack: unstacked
            ? null
            : {
                id: 7,
                number: 7,
                position: n,
                size: 2,
                base: { ref: "main", sha: merged ? fresh!.mergedBase : f.base },
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
        base: { ref: "main", sha: merged ? fresh!.mergedBase : f.base },
        pull_requests: (unstacked ? [] : [1, 2]).map((n) => {
          const p = graph(n);
          return {
            node_id: p.id,
            number: n,
            state: n === 1 && merged ? "closed" : "open",
            merged_at: n === 1 && merged ? "2026-11-04T00:00:00Z" : null,
            head: { ref: p.headRefName, sha: p.headRefOid },
          };
        }),
      });
    if (u.pathname.includes("/git/ref/heads/")) {
      const ref = decodeURIComponent(u.pathname.split("/git/ref/heads/")[1]!);
      const refSha =
        ref === "main"
          ? merged
            ? fresh!.mergedBase
            : f.base
          : ref === resource.lowerRef
            ? lowerHead
            : rebased
              ? fresh!.rebasedHead
              : upperHead;
      if (ref === resource.upperRef) recordUpperHead("ref", refSha);
      return json({ ref: `refs/heads/${ref}`, object: { sha: refSha } });
    }
    if (u.pathname.endsWith("/check-runs"))
      return json({
        total_count: fresh ? 1 : 0,
        check_runs: fresh
          ? [
              {
                name: "offline-check",
                node_id: "OFFLINE-CHECK",
                completed_at: "2026-11-04T00:00:00Z",
                started_at: "2026-11-04T00:00:00Z",
                head_sha: u.pathname.split("/commits/")[1]!.split("/")[0],
                status: "completed",
                conclusion: "success",
                app: null,
              },
            ]
          : [],
      });
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
    if (fresh) {
      db.prepare("UPDATE domain_projects SET paused=0").run();
      db.prepare(
        "UPDATE installation_runtimes SET enabled=1 WHERE harness='codex'",
      ).run();
      for (const [n, taskId] of [lowerTask, upperTask].entries()) {
        // Provider-normalized preparation snapshot, not prior runtime or callback evidence.
        const observation = await new GitHubHttpDeliveryProvider(
          async () => "offline-preparation-marker",
          transport,
        ).inspectPr(
          {
            repositoryId: "R1",
            prNumber: n + 1,
            expectedPrNodeId: n === 0 ? resource.lowerPrId : resource.upperPrId,
            expectedHeadSha: n === 0 ? lowerHead : upperHead,
          },
          policy,
        );
        const digest = materialDigest(observation);
        db.prepare("INSERT INTO delivery_pr_bindings VALUES (?,?)").run(
          taskId,
          JSON.stringify({
            taskId,
            projectId: f.projectId,
            leadAssignmentId: String(
              db
                .prepare(
                  "SELECT assignmentId FROM task_lead_bindings WHERE taskId=?",
                )
                .get(taskId)!.assignmentId,
            ),
            registeredWorkId: `synthetic-precondition:offline:${n}`,
            revision: 1,
            mode: "reviewable-pr",
            observationDigest: digest,
            settlement: null,
            observation,
            observedAt: Date.now(),
            readError: null,
          }),
        );
        db.prepare("INSERT INTO delivery_observations VALUES (?,?,?,?)").run(
          taskId,
          digest,
          JSON.stringify(observation),
          Date.now(),
        );
      }
    }
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
  if (!fresh)
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
  else
    command = {
      type: "task.unstack",
      key: resource.operationKey,
      taskId: upperTask,
      expectedVersion: 1,
      materialHash: materialHash(null),
    };
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
    common = await realpath(
      git(
        upperWorkspace.path,
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
      ),
    );
  const offlineGit = join(f.root, "OFFLINE-git.cjs");
  await writeFile(
    offlineGit,
    `#!${process.execPath}
const { spawnSync } = require('node:child_process');
let args = process.argv.slice(2);
let env = {...process.env};
const remote = 'https://github.com/fixture/private.git';
if(args.includes('fetch')) {
  if(!args.includes(remote)) throw Error('offline-git-remote-denied');
  args = ['-c','protocol.file.allow=always',...args.map(x => x === remote ? ${JSON.stringify(f.source)} : x)];
  env.GIT_ALLOW_PROTOCOL = 'file';
  delete env.CAB_PUSH_TOKEN;
}
const r = spawnSync('/usr/bin/git', args, {env,stdio:'inherit'});
process.exit(r.status ?? 1);
`,
  );
  await chmod(offlineGit, 0o700);
  const gitExecutable = await pin(
      fresh ? offlineGit : await realpath("/usr/bin/git"),
    ),
    runtimeExecutable = await pin(fakeExecutable);
  const { sourceHeadFile, sourceBranch, sourceRefFile } =
    await captureSourceReferencePaths(sourceRoot, (...args) =>
      git(sourceRoot, ...args),
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
    ...(sourceRefFile === sourceHeadFile ? [] : [await pin(sourceRefFile)]),
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
  for (const sha of [
    lowerHead,
    upperHead,
    ...(fresh ? ["__CAB_UPPER_HEAD__"] : []),
  ]) {
    add(
      request(`${repo}/commits/${sha}/check-runs?per_page=100&filter=latest`),
    );
    add(request(`${repo}/commits/${sha}/statuses?per_page=100`));
  }
  if (fresh) {
    add(
      request(
        `${repo}/pulls?state=all&head=${encodeURIComponent(`fixture:${resource.lowerRef}`)}&per_page=100`,
      ),
      8,
    );
    add(request(`${repo}/pulls/1/merge-async/__CAB_MERGE_REQUEST__`), 8);
    for (const rule of reads) {
      if (
        rule.request.url === `https://api.github.com${repo}` ||
        rule.request.body.includes("query CabDeliveryRepository")
      )
        rule.maxCalls = 39;
      if (
        rule.request.url.endsWith("/pulls/1") ||
        rule.request.url.endsWith("/pulls/2") ||
        rule.request.url.includes("/git/ref/heads/")
      )
        rule.maxCalls = 24;
      if (/\/(comments|reviews)\?/.test(rule.request.url)) rule.maxCalls = 8;
    }
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
        ...(fresh ? [lowerWorkspace.root, upperWorkspace.root] : []),
        data,
        scratch,
        join(common, "objects"),
        join(common, "reftable"),
        authTarget,
      ],
      workspaceImage: { maxFiles: 100, maxBytes: 1048576 },
      teardownDeadline: new Date(now + 300000).toISOString(),
    },
    gitFetch: {
      repositoryUrl: "https://github.com/fixture/private.git",
      workspace: upperWorkspace.path,
      commonDirectory: common,
      executable: gitExecutable,
      scratchParent: scratch,
      commits: [lowerHead, upperHead, f.base],
      branch: resource.upperRef,
      maxFetches: fresh ? 1 : 0,
      maxChildren: fresh ? 100 : 32,
      maxObjectBytes: 1048576,
      maxElapsedMs: fresh ? 20000 : 1000,
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
        // A task turn carries its managed repository's Git roots.
        policySha256: materialHash({
          networkAccess: false,
          gitWritableRoots: [
            join(common, "objects"),
            join(common, "reftable"),
            git(
              assignment.taskId === lowerTask
                ? lowerWorkspace.path
                : upperWorkspace.path,
              "rev-parse",
              "--absolute-git-dir",
            ),
          ],
        }),
        taskVersions: [
          observed.tasks.find((task) => task.id === assignment.taskId)!.version,
        ],
        assignmentVersions: [assignment.version],
        instructionsRevision: lead.instructionsRevision,
        profileRevision: lead.profileRevision,
        maxPromptBytes: fresh ? 32768 : 1024,
        maxTurns: fresh ? 2 : 0,
        maxCallbacks: fresh ? 3 : 0,
      };
    }),
    limits: {
      reads: fresh ? offlineReadBudget : 128,
      writes: fresh ? 1 : 2,
      credentials: fresh ? 7 : 8,
      credentialCallbacks: fresh ? 256 : 128,
      callbacks: fresh ? 6 : 0,
      turns: fresh ? 4 : 0,
      firstEffects: fresh ? 120 : 8,
      serviceCalls: fresh ? 64 : 12,
      gitFetches: fresh ? 1 : 0,
    },
  };
  if (fresh) {
    authority.writes = [
      {
        id: "offline:merge",
        request: {
          url: `https://api.github.com${repo}/pulls/1/merge-async`,
          method: "PUT",
          body: JSON.stringify({
            sha: lowerHead,
            merge_method: "squash",
            bypass_rules: false,
            merge_action: "direct_merge",
          }),
          version: "2026-03-10",
        },
        maxCalls: 1,
      },
    ];
    authority.captures.mergeRuleId = "offline:merge";
    authority.serviceCalls = authority.serviceCalls.filter(
      (value) =>
        !value.id.includes("unstack") && value.id !== "service.operation.read",
    );
    const lifecycle = {
      executable: runtimeExecutable,
      version: authority.host.runtimeVersion,
    };
    authority.serviceCalls.push(
      call("runtime.start", lifecycle),
      call("runtime.stop", lifecycle),
      call(
        "fixture.observe",
        { repositoryId: "R1", lowerPr: 1, upperPr: 2 },
        8,
      ),
      call(
        "fixture.poll",
        { repositoryId: "R1", number: 1, operationKey: resource.operationKey },
        8,
      ),
      call("fixture.merge", {
        kind: "pr.merge",
        method: "squash",
        reviewedResultIds: [],
        target: {
          repositoryId: "R1",
          number: 1,
          nodeId: resource.lowerPrId,
          headRef: resource.lowerRef,
          baseRef: "main",
          expectedHeadSha: lowerHead,
        },
      }),
      call("service.refresh", { projectId: f.projectId }, 1),
      call("host.workspace.image", { workspace: upperWorkspace.path }, 2),
      call("git.prove", {
        repositoryId: "R1",
        repositoryUrl: authority.gitFetch.repositoryUrl,
        workspacePath: upperWorkspace.path,
        commonDirectory: common,
        branch: resource.upperRef,
        commits: authority.gitFetch.commits,
      }),
    );
    authority.serviceCalls.find(
      (value) => value.id === "service.observe",
    )!.maxCalls = 3;
    for (const scope of authority.runtime) {
      const material = {
        taskId: scope.taskId,
        assignmentId: scope.assignmentId,
        workspace: scope.workspace,
        settingsSha256: scope.settingsSha256,
        policySha256: scope.policySha256,
      };
      authority.serviceCalls.push(
        call("runtime.thread.start", {
          ...scope,
          toolsSha256: materialHash(coordinationTools),
        }),
        call("runtime.thread.resume", {
          ...scope,
          toolsSha256: materialHash(coordinationTools),
        }),
        call("runtime.turn", material, 2),
        call(
          "runtime.wait",
          { taskId: scope.taskId, assignmentId: scope.assignmentId },
          2,
        ),
      );
    }
  }
  const prepared = prepareStackV2Manifest(
    {
      version: 2,
      runId,
      scenario: fresh ? "merge-adoption" : "unstack-healthy",
      resource,
      credentialRef,
      authority,
      unstackCommand: command,
      journey: {
        maxObservations: fresh ? 8 : 1,
        settlePolls: fresh ? 60 : 1,
        pollIntervalMs: 250,
      },
    },
    {
      version: 2,
      runId,
      observedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 240000).toISOString(),
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
    expiresAt: new Date(now + 240000).toISOString(),
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
  const preparationTrace = trace.splice(0);
  return {
    guard,
    offline: {
      mode: "offline-only" as const,
      runtime: () => {
        throw Error("offline-prefix-runtime-not-granted");
      },
      termination: {
        verify: async () => {
          throw Error("offline-prefix-termination-not-granted");
        },
      },
    },
    preparationTrace,
    trace,
    providerHeads,
    fresh,
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
