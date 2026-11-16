import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { WorkspaceLifecycleStore } from "../../src/core/workspace-lifecycle.js";
import { claudeTemporaryBase } from "../../src/standalone/claude.js";
import type { PushOutcome } from "../../src/standalone/git-push.js";
import {
  GitHubHttpDeliveryProvider,
  type PushFunction,
} from "../../src/standalone/github-delivery.js";
import type { TaskWorkspaceBinding } from "../../src/standalone/workspaces.js";
import { localBranchFetch } from "../fixtures/branch-fetch.js";
import { linkBindingRepositories } from "../fixtures/workspace-removal.js";
import { captureNativeResult } from "../fixtures/native-result.js";
import { createOperatorFixture } from "../fixtures/operator-web.js";
import { startedOf } from "../fixtures/service-internals.js";
import { OperatorApi } from "../../src/standalone/operator-api.js";
import { tmpdir } from "../fixtures/temp.js";

const git = (cwd: string, ...args: string[]) =>
  execFileSync(
    "git",
    [
      "-C",
      cwd,
      "-c",
      "user.name=Removal",
      "-c",
      "user.email=removal@example.invalid",
      ...args,
    ],
    {
      encoding: "utf8",
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" },
    },
  ).trim();

/** The commit at `ref` in a bare remote, or null when the branch does not exist. */
const remoteRef = (remote: string, branch: string): string | null => {
  const read = spawnSync(
    "git",
    [
      "--git-dir",
      remote,
      "rev-parse",
      "--verify",
      "-q",
      `refs/heads/${branch}`,
    ],
    { encoding: "utf8" },
  );
  return read.status === 0 ? read.stdout.trim() : null;
};

const commitFile = (worktree: string, name: string, text = `${name}\n`) => {
  writeFileSync(join(worktree, name), text);
  git(worktree, "add", name);
  git(worktree, "commit", "--quiet", "-m", name);
  return git(worktree, "rev-parse", "HEAD");
};

/** The fake transport's hook: return an outcome to replace the real push. */
type PushHook = (
  request: Parameters<PushFunction>[0],
) => PushOutcome | undefined | Promise<PushOutcome | undefined>;

/**
 * A service with local tasks over real managed repositories, each with a disposable bare remote
 * standing in for the code host: the real GitHub provider reads refs from it through a fake API
 * and pushes to it with real Git.
 */
async function world(t: TestContext, repositoryCount = 1) {
  const root = mkdtempSync(join(tmpdir(), "cab-workspace-removal-"));
  const repositories = Array.from({ length: repositoryCount }, (_, index) => {
    const id = `R${index + 1}`;
    const source = join(root, `source-${index + 1}`);
    mkdirSync(source);
    git(source, "init", "--quiet", "--initial-branch=main");
    writeFileSync(join(source, ".gitignore"), "node_modules/\ndist\n");
    writeFileSync(join(source, "README.md"), `${id}\n`);
    git(source, "add", ".");
    git(source, "commit", "--quiet", "-m", "base");
    const remote = join(root, `remote-${index + 1}.git`);
    execFileSync("git", ["init", "--quiet", "--bare", remote]);
    return { id, name: `org/${id.toLowerCase()}`, source, remote };
  });
  const byName = new Map(repositories.map((r) => [r.name, r]));
  const byId = new Map(repositories.map((r) => [r.id, r]));
  const pushes: Array<{ repositoryId: string; commitSha: string }> = [];
  let hook: PushHook | undefined;
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/graphql") {
      const { variables } = JSON.parse(String(init?.body)) as {
        variables: { id: string };
      };
      const repository = byId.get(variables.id);
      return Response.json({
        data: {
          node: repository && {
            id: repository.id,
            nameWithOwner: repository.name,
          },
        },
      });
    }
    const match = /^\/repos\/(org\/[^/]+)(?:\/git\/ref\/heads\/(.+))?$/.exec(
      url.pathname,
    );
    const repository = match && byName.get(match[1]!);
    if (!repository) throw new Error(`unexpected route ${url.pathname}`);
    if (match[2] === undefined)
      return Response.json({
        node_id: repository.id,
        full_name: repository.name,
        allow_merge_commit: true,
        allow_squash_merge: true,
        allow_rebase_merge: false,
      });
    const branch = decodeURIComponent(match[2]);
    const head = remoteRef(repository.remote, branch);
    return head
      ? Response.json({ ref: `refs/heads/${branch}`, object: { sha: head } })
      : Response.json({ message: "Not Found" }, { status: 404 });
  };
  const push: PushFunction = async (request) => {
    const repository = byName.get(request.nameWithOwner);
    if (!repository) return "not-attempted";
    pushes.push({ repositoryId: repository.id, commitSha: request.commitSha });
    const replaced = await hook?.(request);
    if (replaced) return replaced;
    const head = remoteRef(repository.remote, request.branch);
    if (head === request.commitSha) return "up-to-date";
    if (head !== request.lease) return "rejected-lease";
    git(
      request.workspacePath,
      "push",
      "--quiet",
      repository.remote,
      `${request.commitSha}:refs/heads/${request.branch}`,
    );
    return "pushed";
  };
  // Each repository's target branch is its source checkout's `main`; a task branch is read
  // from the bare remote it was pushed to.
  const targets = new Map(
    repositories.map((r) => [
      r.name,
      {
        source: localBranchFetch(r.source).fetchBranch,
        remote: localBranchFetch(r.remote).fetchBranch,
      },
    ]),
  );
  const taskBranchFetches: Array<{ repository: string; branch: string }> = [];
  const provider = new GitHubHttpDeliveryProvider(
    "token",
    fetcher,
    push,
    undefined,
    "github.com",
    undefined,
    (request) => {
      const target = targets.get(request.nameWithOwner)!;
      if (!request.branch?.startsWith("cab/")) return target.source(request);
      taskBranchFetches.push({
        repository: request.nameWithOwner,
        branch: request.branch,
      });
      return target.remote(request);
    },
  );
  const f = await createOperatorFixture(null, undefined, {
    providerFactories: { github: () => provider },
  });
  t.after(async () => {
    await f.close();
    rmSync(root, { recursive: true, force: true });
  });
  const domain = f.service.domain();
  const projectId = randomUUID();
  domain.execute({
    type: "project.create",
    actor: "operator",
    key: randomUUID(),
    projectId,
    name: "Removal",
    leadProfileId: null,
  });
  const grant = (
    grants: Array<{ repositoryId: string; mode: "allow" | "approval" }>,
  ) =>
    domain.execute({
      type: "delivery.configure",
      actor: "operator",
      key: randomUUID(),
      projectId,
      expectedVersion: f.service.delivery().configuration(projectId).version,
      mode: "reviewable-pr",
      credentialRef: null,
      grants: grants.map((g) => ({ action: "branch.push", ...g })),
      requiredChecks: [],
    } as never);
  grant(repositories.map((r) => ({ repositoryId: r.id, mode: "allow" })));
  const finish = (taskId: string, state: "done" | "cancelled" = "done") =>
    domain.execute({
      type: "task.configure",
      actor: "operator",
      key: randomUUID(),
      projectId,
      taskId,
      expectedVersion: Number(domain.task(taskId).version),
      state,
    });
  /** A local task with a ready workspace over every repository (or none). */
  const task = async (
    options: { title?: string; repositories?: boolean } = {},
  ) => {
    const taskId = randomUUID();
    domain.execute({
      type: "task.create",
      actor: "operator",
      key: randomUUID(),
      projectId,
      taskId,
      title: options.title ?? "Remove workspace",
      outcome: "O",
    });
    const binding: TaskWorkspaceBinding = await f.service.provisionTask(
      taskId,
      options.repositories === false
        ? []
        : repositories.map((r) => ({
            repositoryId: r.id,
            path: r.source,
            ref: "main",
          })),
    );
    assert.equal(binding.state, "ready", binding.reason ?? "");
    const worktree = (index = 0) => binding.repositories[index]!.workspacePath;
    return { taskId, binding, worktree };
  };
  const branchOf = (taskId: string, repositoryId = "R1") =>
    f.service.delivery().taskBranch(taskId, repositoryId);
  const lifecycle = () =>
    new WorkspaceLifecycleStore(
      // biome-ignore lint/complexity/useLiteralKeys: the service's own database
      f.service["cache"]!,
    );
  const operations = (binding: TaskWorkspaceBinding) =>
    lifecycle().operations(binding);
  const archivalHeld = (taskId: string) =>
    f.service[
      // biome-ignore lint/complexity/useLiteralKeys: the service's own database
      "cache"
    ]!.prepare("SELECT 1 FROM task_archival_holds WHERE taskId=?").get(
      taskId,
    ) !== undefined;
  return {
    f,
    root,
    domain,
    projectId,
    repositories,
    pushes,
    taskBranchFetches,
    setPushHook: (next: PushHook | undefined) => {
      hook = next;
    },
    grant,
    finish,
    task,
    branchOf,
    lifecycle,
    operations,
    archivalHeld,
    /** Links the project to exactly `binding`'s repositories (or none). */
    link: (binding: Pick<TaskWorkspaceBinding, "repositories">) =>
      linkBindingRepositories(f, projectId, binding),
    remove: (taskId: string) => f.service.removeTaskWorkspace(taskId, "manual"),
  };
}

const gone = (binding: TaskWorkspaceBinding) => {
  assert.equal(existsSync(binding.path), false);
  for (const repository of binding.repositories) {
    assert.equal(existsSync(repository.workspacePath), false);
    assert.equal(
      git(repository.gitCommonDir!, "worktree", "list", "--porcelain").includes(
        repository.workspacePath,
      ),
      false,
    );
  }
};

test("a done or cancelled task's clean workspace is removed with its Claude base, once", async (t) => {
  const w = await world(t);
  for (const state of ["done", "cancelled"] as const) {
    const { taskId, binding } = await w.task();
    const base = claudeTemporaryBase(binding.path);
    mkdirSync(base, { mode: 0o700 });
    writeFileSync(join(binding.path, "evidence.txt"), "root file\n");
    w.finish(taskId, state);
    const removed = await w.remove(taskId);
    assert.equal(removed.outcome, "cleaned", JSON.stringify(removed));
    if (removed.outcome !== "cleaned") return;
    assert.equal(removed.binding.state, "archived");
    gone(binding);
    assert.equal(existsSync(base), false);
    assert.equal(removed.operation.trigger, "manual");
    assert.deepEqual(removed.operation.repositories, [
      {
        kind: "base",
        repositoryId: "R1",
        branch: "main",
        commit: binding.repositories[0]!.commit,
        noTaskCommits: true,
      },
    ]);
    assert.deepEqual(
      removed.operation.effects.map((e) => [e.target.kind, e.outcome]),
      [
        ["repository", "succeeded"],
        ["root", "succeeded"],
        ["claude-base", "succeeded"],
      ],
    );
    assert.equal(w.archivalHeld(taskId), false);
    assert.equal(w.pushes.length, 0);
    // A response lost after completion: the replay returns the original record and touches nothing.
    const replay = await w.remove(taskId);
    assert.deepEqual(replay, removed);
  }
});

test("a repository-free workspace is removed with its root files", async (t) => {
  const w = await world(t);
  const { taskId, binding } = await w.task({ repositories: false });
  writeFileSync(join(binding.path, "summary.md"), "result\n");
  w.finish(taskId, "cancelled");
  const removed = await w.remove(taskId);
  assert.equal(removed.outcome, "cleaned", JSON.stringify(removed));
  assert.equal(existsSync(binding.path), false);
  assert.deepEqual(
    removed.outcome === "cleaned" && removed.operation.repositories,
    [],
  );
});

test("ignored build output alone does not block removal", async (t) => {
  const w = await world(t);
  const { taskId, binding, worktree } = await w.task();
  mkdirSync(join(worktree(), "node_modules", "pkg"), { recursive: true });
  writeFileSync(join(worktree(), "node_modules", "pkg", "index.js"), "x\n");
  writeFileSync(join(worktree(), "dist"), "build\n");
  writeFileSync(join(binding.path, "scratch", "cache.bin"), "cache\n");
  w.finish(taskId);
  const removed = await w.remove(taskId);
  assert.equal(removed.outcome, "cleaned", JSON.stringify(removed));
  gone(binding);
});

test("each unsafe state refuses removal by name and deletes nothing", async (t) => {
  const w = await world(t);
  const refused = async (
    prepare: (task: Awaited<ReturnType<typeof w.task>>) => void | Promise<void>,
    reason: RegExp,
    terminal = true,
  ) => {
    const task = await w.task();
    if (terminal) w.finish(task.taskId);
    await prepare(task);
    const result = await w.remove(task.taskId);
    assert.equal(result.outcome, "retained");
    assert.match(result.outcome === "retained" ? result.reason : "", reason);
    assert.equal(existsSync(task.worktree()), true);
    assert.equal(result.binding.state, "ready");
    assert.equal(w.archivalHeld(task.taskId), false);
    return task;
  };
  await refused(() => {}, /Only a done or cancelled task/, false);
  await refused(
    ({ taskId }) =>
      w.f.seedPersistedState((db) =>
        db
          .prepare(
            "INSERT INTO task_writer_holds (taskId, reason) VALUES (?, ?)",
          )
          .run(taskId, "writer"),
      ),
    /Task execution is not settled/,
  );
  await refused(
    ({ worktree }) => writeFileSync(join(worktree(), "README.md"), "edited\n"),
    /Uncommitted work remains in R1/,
  );
  await refused(({ worktree }) => {
    writeFileSync(join(worktree(), "README.md"), "staged\n");
    git(worktree(), "add", "README.md");
  }, /Uncommitted work remains in R1/);
  await refused(
    ({ worktree }) => rmSync(join(worktree(), "README.md")),
    /Uncommitted work remains in R1/,
  );
  await refused(
    ({ worktree }) => writeFileSync(join(worktree(), "notes.txt"), "new\n"),
    /Uncommitted work remains in R1/,
  );
  // Committed work whose push the policy refuses stays, with the delivery's reason.
  w.grant([]);
  const unpushed = await refused(
    ({ worktree }) => void commitFile(worktree(), "work.txt"),
    /Pushing R1 to its task branch was refused: External action denied by project policy/,
  );
  assert.equal(w.pushes.length, 0);
  assert.equal(
    w
      .operations(unpushed.binding)
      .map((o) => o.state)
      .join(),
    "refused",
  );
});

test("a recorded dirty result refuses removal until its work is committed", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const native = await captureNativeResult(f, { repository: true });
  rmSync(native.textPath);
  const domain = f.service.domain();
  domain.execute({
    type: "task.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: native.seeded.projectId,
    taskId: native.seeded.taskId,
    expectedVersion: Number(domain.task(native.seeded.taskId).version),
    state: "done",
  });
  const result = await f.service.removeTaskWorkspace(
    native.seeded.taskId,
    "manual",
  );
  assert.equal(
    result.outcome === "retained" && result.reason,
    `Result ${native.resultId} recorded uncommitted changes in R1 that are neither committed nor delivered; commit or deliver them, or reset the task to discard them`,
  );
  assert.equal(existsSync(native.worktree), true);
});

test("committed work is pushed to the task branch before the workspace is removed", async (t) => {
  const w = await world(t);
  const { taskId, binding, worktree } = await w.task();
  const head = commitFile(worktree(), "work.txt");
  w.finish(taskId);
  const removed = await w.remove(taskId);
  assert.equal(removed.outcome, "cleaned", JSON.stringify(removed));
  const branch = w.branchOf(taskId)!;
  assert.equal(remoteRef(w.repositories[0]!.remote, branch.branch), head);
  assert.equal(branch.lastPushedSha, head);
  assert.deepEqual(w.pushes, [{ repositoryId: "R1", commitSha: head }]);
  assert.deepEqual(
    removed.outcome === "cleaned" && removed.operation.repositories,
    [
      {
        kind: "pushed",
        repositoryId: "R1",
        branch: branch.branch,
        commit: head,
      },
    ],
  );
  gone(binding);
  // The push is the removal's: it is recorded without restarting the delivered clock.
  const generation = w.lifecycle().get(binding.workspaceId)!;
  assert.equal(generation.lastPushAt, null);
  assert.equal(generation.repositoryClocks[0]!.pushedCommit, head);
  // The delivery read names the push as the service's.
  assert.equal(
    w.f.service
      .delivery()
      .actions(taskId)
      .every((a) => a.state === "confirmed-success"),
    true,
  );
});

test("the operator command pushes first and its receipt and task read name the pushed branch", async (t) => {
  const w = await world(t);
  const { taskId, binding, worktree } = await w.task();
  const head = commitFile(worktree(), "work.txt");
  w.finish(taskId);
  const api = new OperatorApi(w.f.service, [w.f.directory]);
  const key = randomUUID();
  const receipt = await api.execute({
    type: "task.workspace.remove",
    key,
    taskId,
    workspaceId: binding.workspaceId,
  });
  assert.equal(receipt.kind, "workspace-remove");
  assert.deepEqual(
    receipt.kind === "workspace-remove" && receipt.repositories,
    [{ repositoryId: "R1", kind: "pushed", commit: head }],
  );
  gone(binding);
  const branch = w.branchOf(taskId)!.branch;
  assert.equal(remoteRef(w.repositories[0]!.remote, branch), head);
  const read = await api.readTask(taskId);
  assert.deepEqual(read.data.workspace?.removal?.repositories, [
    { repositoryId: "R1", kind: "pushed", branch, commit: head },
  ]);
  // A branch name the exclusions would change is withheld whole, never partly redacted.
  const withheld = new OperatorApi(w.f.service, [w.f.directory]);
  const exclusions = (
    withheld as unknown as {
      exclusions(
        projectId: string,
        taskId: string,
      ): Promise<string[] | undefined>;
    }
  ).exclusions.bind(withheld);
  Object.assign(withheld, {
    exclusions: async (projectId: string, id: string) => [
      ...((await exclusions(projectId, id)) ?? []),
      branch.slice(-12),
    ],
  });
  assert.deepEqual(
    (await withheld.readTask(taskId)).data.workspace?.removal?.repositories,
    [{ repositoryId: "R1", kind: "pushed", branch: null, commit: head }],
  );
});

test("a branch changed outside cab refuses the push and every later removal", async (t) => {
  const w = await world(t);
  const { taskId, worktree } = await w.task({ title: "Outside" });
  commitFile(worktree(), "work.txt");
  w.finish(taskId);
  const branch = `cab/${taskId.replaceAll("-", "").slice(0, 8)}-outside`;
  const outside = git(w.repositories[0]!.source, "rev-parse", "HEAD");
  git(
    w.repositories[0]!.source,
    "push",
    "--quiet",
    w.repositories[0]!.remote,
    `${outside}:refs/heads/${branch}`,
  );
  const first = await w.remove(taskId);
  assert.match(
    first.outcome === "retained" ? first.reason : "",
    /Pushing R1 to its task branch was refused: branch-outside-change/,
  );
  assert.equal(remoteRef(w.repositories[0]!.remote, branch), outside);
  const again = await w.remove(taskId);
  assert.match(
    again.outcome === "retained" ? again.reason : "",
    /The task branch of R1 changed outside cab/,
  );
  assert.equal(existsSync(worktree()), true);
});

test("removal never widens delivery authority: approval grants and target conflicts refuse", async (t) => {
  const w = await world(t);
  w.grant([{ repositoryId: "R1", mode: "approval" }]);
  const gated = await w.task();
  commitFile(gated.worktree(), "work.txt");
  w.finish(gated.taskId);
  const approval = await w.remove(gated.taskId);
  assert.match(
    approval.outcome === "retained" ? approval.reason : "",
    /Pushing R1 to its task branch was refused: Exact material approval required/,
  );
  assert.equal(w.pushes.length, 0);
  assert.equal(existsSync(gated.worktree()), true);

  w.grant([{ repositoryId: "R1", mode: "allow" }]);
  const conflicted = await w.task();
  commitFile(conflicted.worktree(), "README.md", "task side\n");
  commitFile(w.repositories[0]!.source, "README.md", "target side\n");
  w.finish(conflicted.taskId);
  const conflict = await w.remove(conflicted.taskId);
  assert.match(
    conflict.outcome === "retained" ? conflict.reason : "",
    /Pushing R1 to its task branch was refused: publication-target-conflict/,
  );
  assert.equal(w.pushes.length, 0);
  assert.equal(
    remoteRef(w.repositories[0]!.remote, w.branchOf(conflicted.taskId)!.branch),
    null,
  );
  assert.equal(existsSync(conflicted.worktree()), true);
});

test("a partial multi-repository push keeps both worktrees and is not pushed again", async (t) => {
  const w = await world(t, 2);
  w.grant([{ repositoryId: "R1", mode: "allow" }]);
  const { taskId, binding, worktree } = await w.task();
  const first = commitFile(worktree(0), "one.txt");
  const second = commitFile(worktree(1), "two.txt");
  w.finish(taskId);
  const partial = await w.remove(taskId);
  assert.match(
    partial.outcome === "retained" ? partial.reason : "",
    /Pushing R2 to its task branch was refused/,
  );
  assert.equal(existsSync(worktree(0)), true);
  assert.equal(existsSync(worktree(1)), true);
  assert.equal(
    remoteRef(w.repositories[0]!.remote, w.branchOf(taskId, "R1")!.branch),
    first,
  );
  const [attempt] = w.operations(binding);
  assert.equal(attempt?.state, "refused");
  assert.equal(
    w.lifecycle().get(binding.workspaceId)!.repositoryClocks[0]!.pushedCommit,
    first,
  );

  w.grant([
    { repositoryId: "R1", mode: "allow" },
    { repositoryId: "R2", mode: "allow" },
  ]);
  const replay = await w.remove(taskId);
  assert.equal(replay.outcome, "cleaned", JSON.stringify(replay));
  assert.deepEqual(w.pushes, [
    { repositoryId: "R1", commitSha: first },
    { repositoryId: "R2", commitSha: second },
  ]);
  gone(binding);
});

test("removal proves ancestry from commit objects, not from refs or a forged graph", async (t) => {
  const w = await world(t);
  /** Records `commit` as the task branch's last push, as a prior delivery would have. */
  const pushedBefore = (taskId: string, commit: string) => {
    const branch = `cab/${randomUUID()}`;
    w.f.seedPersistedState((db) =>
      db
        .prepare(
          "INSERT INTO delivery_task_branches (taskId,repositoryId,branch,lastPushedSha,outsideHeadSha,assignedAt) VALUES (?,?,?,?,NULL,1)",
        )
        .run(taskId, "R1", branch, commit),
    );
    return branch;
  };

  // HEAD moved back to an ancestor of the last push: everything is already on the branch.
  const behind = await w.task();
  const older = commitFile(behind.worktree(), "a.txt");
  const newer = commitFile(behind.worktree(), "b.txt");
  const branch = pushedBefore(behind.taskId, newer);
  git(behind.worktree(), "reset", "--quiet", "--hard", older);
  w.finish(behind.taskId);
  const removed = await w.remove(behind.taskId);
  assert.deepEqual(
    removed.outcome === "cleaned" && removed.operation.repositories,
    [{ kind: "pushed", repositoryId: "R1", branch, commit: newer }],
  );
  assert.equal(w.pushes.length, 0);

  // A rewritten commit has diverged from the last push.
  const diverged = await w.task();
  const pushed = commitFile(diverged.worktree(), "a.txt");
  pushedBefore(diverged.taskId, pushed);
  git(diverged.worktree(), "commit", "--quiet", "--amend", "-m", "rewritten");
  w.finish(diverged.taskId);
  const divergent = await w.remove(diverged.taskId);
  assert.match(
    divergent.outcome === "retained" ? divergent.reason : "",
    /The history of R1 does not provably follow its last push or provisioned base/,
  );

  // A graft that makes HEAD look like an ancestor of the last push proves nothing.
  const forged = await w.task();
  const claimed = commitFile(forged.worktree(), "a.txt");
  pushedBefore(forged.taskId, claimed);
  git(forged.worktree(), "reset", "--quiet", "--hard", "HEAD~1");
  const real = commitFile(forged.worktree(), "other.txt");
  git(forged.worktree(), "replace", "--graft", claimed, real);
  git(forged.worktree(), "merge-base", "--is-ancestor", real, claimed);
  w.finish(forged.taskId);
  const refused = await w.remove(forged.taskId);
  assert.match(
    refused.outcome === "retained" ? refused.reason : "",
    /The history of R1 does not provably follow/,
  );
  assert.equal(existsSync(forged.worktree()), true);
  assert.equal(w.pushes.length, 0);
});

test("a writer or a replaced root found at the final check keeps the workspace", async (t) => {
  const w = await world(t);
  const writer = await w.task();
  commitFile(writer.worktree(), "work.txt");
  w.finish(writer.taskId);
  w.setPushHook(() => {
    w.f.seedPersistedState((db) =>
      db
        .prepare("INSERT INTO task_writer_holds (taskId, reason) VALUES (?, ?)")
        .run(writer.taskId, "late writer"),
    );
    return undefined;
  });
  const late = await w.remove(writer.taskId);
  assert.match(
    late.outcome === "retained" ? late.reason : "",
    /Task execution is not settled/,
  );
  assert.equal(existsSync(writer.worktree()), true);
  assert.equal(w.operations(writer.binding).at(-1)?.state, "refused");

  const replaced = await w.task();
  commitFile(replaced.worktree(), "work.txt");
  w.finish(replaced.taskId);
  const moved = join(w.root, "moved-root");
  w.setPushHook(() => {
    renameSync(replaced.binding.path, moved);
    symlinkSync(moved, replaced.binding.path);
    return undefined;
  });
  const swapped = await w.remove(replaced.taskId);
  w.setPushHook(undefined);
  assert.equal(swapped.outcome, "retained");
  assert.equal(existsSync(join(moved, "repo-1", "work.txt")), true);
  assert.equal(existsSync(join(moved, "scratch")), true);
});

test("a partly removed workspace stays held with its journal across a restart", async (t) => {
  const w = await world(t, 2);
  const { taskId, binding, worktree } = await w.task();
  // Git refuses to remove a locked worktree without --force, which removal never passes.
  git(binding.repositories[1]!.gitCommonDir!, "worktree", "lock", worktree(1));
  w.finish(taskId);
  const held = await w.remove(taskId);
  assert.equal(held.outcome, "retained");
  assert.equal(held.binding.state, "held");
  assert.equal(existsSync(worktree(0)), false);
  assert.equal(existsSync(worktree(1)), true);
  const [operation] = w.operations(binding);
  assert.equal(operation?.state, "held");
  assert.deepEqual(
    operation?.effects.map((e) => e.outcome),
    ["succeeded", "failed"],
  );
  assert.equal(w.archivalHeld(taskId), true);

  await w.f.reopen();
  assert.equal(w.archivalHeld(taskId), true);
  const again = await w.remove(taskId);
  assert.equal(again.outcome, "retained");
  assert.equal(existsSync(worktree(1)), true);
  assert.equal(w.operations(binding).length, 1);
});

test("a Claude base that cannot be released holds the removal after the root is gone", async (t) => {
  const w = await world(t);
  const { taskId, binding } = await w.task();
  const base = claudeTemporaryBase(binding.path);
  mkdirSync(base);
  chmodSync(base, 0o755);
  t.after(() => rmSync(base, { recursive: true, force: true }));
  w.finish(taskId);
  const held = await w.remove(taskId);
  assert.equal(held.outcome, "retained");
  assert.match(
    held.outcome === "retained" ? held.reason : "",
    /claude-base is still present/,
  );
  assert.equal(existsSync(binding.path), false);
  assert.equal(existsSync(base), true);
  assert.equal(held.binding.state, "held");
  const [operation] = w.operations(binding);
  assert.equal(operation?.state, "held");
  assert.equal(operation?.completedAt, null);
  assert.equal(w.archivalHeld(taskId), true);
});

test("an interrupted removal journal is held after restart and nothing more is deleted", async (t) => {
  const w = await world(t);
  const { taskId, binding, worktree } = await w.task();
  w.finish(taskId);
  const operationId = randomUUID();
  // A crash after the first destructive effect was journaled but before it settled.
  w.f.seedPersistedState((db) => {
    const lifecycle = new WorkspaceLifecycleStore(db as never);
    const owner = { taskId, workspaceId: binding.workspaceId };
    lifecycle.beginOperation(owner, {
      operationId,
      kind: "remove",
      trigger: "manual",
      startedAt: Date.now(),
    });
    lifecycle.startEffect(owner, operationId, {
      effectId: randomUUID(),
      target: { kind: "repository", repositoryId: "R1" },
      startedAt: Date.now(),
    });
    db.prepare(
      "UPDATE task_workspace_bindings SET state='archiving' WHERE taskId=?",
    ).run(taskId);
    db.prepare(
      "INSERT INTO task_archival_holds (taskId, reason, ownerToken) VALUES (?, 'Task archival in progress', ?)",
    ).run(taskId, operationId);
  });
  await w.f.reopen();
  const [operation] = w.operations(binding);
  assert.equal(operation?.state, "held");
  assert.equal(operation?.effects[0]?.settledAt, null);
  assert.equal(w.archivalHeld(taskId), true);
  const again = await w.remove(taskId);
  assert.equal(again.outcome, "retained");
  assert.equal(again.binding.state, "held");
  assert.equal(existsSync(worktree()), true);
  assert.equal(w.operations(binding).length, 1);
});

test("a tokenless archival hold from an earlier build stays held and refuses removal", async (t) => {
  const w = await world(t);
  const { taskId, worktree } = await w.task();
  w.finish(taskId);
  w.f.seedPersistedState((db) =>
    db
      .prepare("INSERT INTO task_archival_holds (taskId, reason) VALUES (?, ?)")
      .run(taskId, "Task archival in progress"),
  );
  const refused = await w.remove(taskId);
  assert.match(
    refused.outcome === "retained" ? refused.reason : "",
    /Task execution is not settled or its workspace is held/,
  );
  assert.equal(w.archivalHeld(taskId), true);
  // A restart cannot prove who owns it either, so it stays.
  await w.f.reopen();
  assert.equal(w.archivalHeld(taskId), true);
  const again = await w.remove(taskId);
  assert.equal(again.outcome, "retained");
  assert.equal(existsSync(worktree()), true);
});

test("a removal interrupted before any deletion is refused at restart and releases its hold", async (t) => {
  const w = await world(t);
  const { taskId, binding } = await w.task();
  w.finish(taskId);
  const operationId = randomUUID();
  // A crash during the push window: the operation began, nothing was deleted.
  w.f.seedPersistedState((db) => {
    new WorkspaceLifecycleStore(db as never).beginOperation(
      { taskId, workspaceId: binding.workspaceId },
      {
        operationId,
        kind: "remove",
        trigger: "manual",
        startedAt: Date.now(),
      },
    );
    db.prepare(
      "INSERT INTO task_archival_holds (taskId, reason, ownerToken) VALUES (?, 'Task archival in progress', ?)",
    ).run(taskId, operationId);
  });
  await w.f.reopen();
  const [operation] = w.operations(binding);
  assert.equal(operation?.state, "refused");
  assert.match(operation?.reason ?? "", /interrupted before any deletion/);
  assert.equal(w.archivalHeld(taskId), false);
  assert.equal(w.f.service.taskHold(taskId), undefined);
  const removed = await w.remove(taskId);
  assert.equal(removed.outcome, "cleaned", JSON.stringify(removed));
});

test("a push with an unknown outcome refuses removal until delivery settles it", async (t) => {
  const w = await world(t);
  const { taskId, binding, worktree } = await w.task();
  commitFile(worktree(), "work.txt");
  w.finish(taskId);
  w.setPushHook(() => "uncertain");
  const first = await w.remove(taskId);
  w.setPushHook(undefined);
  assert.match(
    first.outcome === "retained" ? first.reason : "",
    /Pushing R1 to its task branch was refused/,
  );
  assert.equal(w.operations(binding).at(-1)?.state, "refused");
  assert.equal(w.archivalHeld(taskId), false);
  const second = await w.remove(taskId);
  assert.match(
    second.outcome === "retained" ? second.reason : "",
    /delivery actions whose outcome is not settled/,
  );
  assert.equal(w.pushes.length, 1);
  assert.equal(existsSync(worktree()), true);
});

test("a repository whose status Git cannot read refuses removal and deletes nothing", async (t) => {
  const w = await world(t);
  const { taskId, binding, worktree } = await w.task();
  w.finish(taskId);
  writeFileSync(
    join(binding.repositories[0]!.gitDirectory!, "index"),
    "not an index",
  );
  const refused = await w.remove(taskId);
  assert.equal(refused.outcome, "retained", JSON.stringify(refused));
  assert.equal(
    refused.outcome === "retained" && refused.reason,
    "Git could not read the status or HEAD of R1",
  );
  assert.equal(existsSync(worktree()), true);
  assert.equal(existsSync(join(worktree(), "README.md")), true);
  assert.equal(w.operations(binding).length, 0);
});

/** The task's repositories as `world` provisioned them, optionally in reverse order. */
const inputs = (w: Awaited<ReturnType<typeof world>>, reversed = false) => {
  const all = w.repositories.map((r) => ({
    repositoryId: r.id,
    path: r.source,
    ref: "main",
  }));
  return reversed ? all.reverse() : all;
};

/** Deletes a loose object, as if it had been lost from the managed repository. */
const loseObject = (repository: string, commit: string) =>
  rmSync(join(repository, "objects", commit.slice(0, 2), commit.slice(2)));

test("a removed workspace is provisioned again at each repository's last push or base", async (t) => {
  const w = await world(t, 2);
  const { taskId, binding, worktree } = await w.task();
  const pushed = commitFile(worktree(0), "work.txt");
  const base = binding.repositories[1]!.commit!;
  w.finish(taskId);
  const removed = await w.remove(taskId);
  assert.equal(removed.outcome, "cleaned", JSON.stringify(removed));
  gone(binding);
  // Automatic GC is off, so the managed repository still holds the removed worktree's commit.
  const managed = binding.repositories[0]!.gitCommonDir!;
  assert.equal(git(managed, "config", "gc.auto"), "0");
  assert.equal(git(managed, "cat-file", "-t", pushed), "commit");

  w.link(binding);
  // Inputs in another order bind the same repositories to the same repo-N paths.
  const again = await w.f.service.provisionTask(taskId, inputs(w, true));
  assert.equal(again.state, "ready", again.reason ?? "");
  assert.notEqual(again.workspaceId, binding.workspaceId);
  assert.notEqual(again.path, binding.path);
  assert.deepEqual(
    again.repositories.map((r) => [
      r.repositoryId,
      r.workspacePath,
      git(r.workspacePath, "rev-parse", "HEAD"),
    ]),
    [
      ["R1", join(again.path, "repo-1"), pushed],
      ["R2", join(again.path, "repo-2"), base],
    ],
  );
  assert.equal(existsSync(join(again.path, "scratch")), true);
  assert.equal(w.taskBranchFetches.length, 0);
  // The old generation and its removal record are kept beside the new one.
  assert.deepEqual(
    w.lifecycle().removal(binding)?.repositories,
    removed.outcome === "cleaned" ? removed.operation.repositories : null,
  );
  assert.deepEqual(
    w
      .lifecycle()
      .forTask(taskId)
      .map((g) => g.workspaceId)
      .sort(),
    [binding.workspaceId, again.workspaceId].sort(),
  );
  assert.equal(w.lifecycle().current(taskId)?.workspaceId, again.workspaceId);
  assert.equal(existsSync(binding.path), false);
});

test("concurrent provisioning after removal creates exactly one new workspace", async (t) => {
  const w = await world(t);
  const { taskId, binding } = await w.task();
  w.finish(taskId);
  assert.equal((await w.remove(taskId)).outcome, "cleaned");
  w.link(binding);
  const results = await Promise.all([
    w.f.service.provisionTask(taskId, inputs(w)),
    w.f.service.provisionTask(taskId, inputs(w)),
    w.f.service.provisionTask(taskId, inputs(w)),
  ]);
  assert.equal(new Set(results.map((r) => r.workspaceId)).size, 1);
  assert.notEqual(results[0]!.workspaceId, binding.workspaceId);
  assert.equal(w.lifecycle().forTask(taskId).length, 2);
  assert.deepEqual(readdirSync(join(binding.path, "..")).sort(), [
    results[0]!.workspaceId,
  ]);
});

test("a missing, held or unrecorded archived workspace is never provisioned again", async (t) => {
  const w = await world(t);
  const missing = await w.task();
  rmSync(missing.binding.path, { recursive: true, force: true });
  const kept = await w.f.service.provisionTask(missing.taskId, inputs(w));
  assert.equal(kept.workspaceId, missing.binding.workspaceId);
  assert.equal(kept.state, "held");

  for (const state of ["held", "archived"] as const) {
    const { taskId, binding } = await w.task();
    w.f.seedPersistedState((db) =>
      db
        .prepare(
          "UPDATE task_workspace_bindings SET state=?, reason='kept' WHERE taskId=?",
        )
        .run(state, taskId),
    );
    const same = await w.f.service.provisionTask(taskId, inputs(w));
    assert.equal(same.workspaceId, binding.workspaceId);
    assert.equal(same.state, state);
    assert.equal(w.lifecycle().forTask(taskId).length, 1);
  }
});

test("a commit lost from the managed repository is fetched from its task branch only at the recorded commit", async (t) => {
  const w = await world(t);
  const fetched = await w.task();
  const head = commitFile(fetched.worktree(), "work.txt");
  w.finish(fetched.taskId);
  assert.equal((await w.remove(fetched.taskId)).outcome, "cleaned");
  loseObject(fetched.binding.repositories[0]!.gitCommonDir!, head);
  w.link(fetched.binding);
  const again = await w.f.service.provisionTask(fetched.taskId, inputs(w));
  assert.equal(again.state, "ready", again.reason ?? "");
  assert.equal(
    git(again.repositories[0]!.workspacePath, "rev-parse", "HEAD"),
    head,
  );
  const branch = w.branchOf(fetched.taskId)!.branch;
  assert.deepEqual(w.taskBranchFetches, [{ repository: "org/r1", branch }]);

  // The task branch moved after removal: the fetch does not return the recorded commit.
  const moved = await w.task();
  // Distinct content: an identical file, parent and second-resolution timestamp would make this
  // the first task's commit, whose loss would break the refs that still name it.
  const recorded = commitFile(moved.worktree(), "moved.txt");
  assert.notEqual(recorded, head);
  w.finish(moved.taskId);
  assert.equal((await w.remove(moved.taskId)).outcome, "cleaned");
  const remote = w.repositories[0]!.remote;
  const movedBranch = w.branchOf(moved.taskId)!.branch;
  const outside = git(w.repositories[0]!.source, "rev-parse", "HEAD");
  git(
    w.repositories[0]!.source,
    "push",
    "--quiet",
    "--force",
    remote,
    `${outside}:refs/heads/${movedBranch}`,
  );
  loseObject(moved.binding.repositories[0]!.gitCommonDir!, recorded);
  w.link(moved.binding);
  await assert.rejects(
    w.f.service.provisionTask(moved.taskId, inputs(w)),
    /is no longer at its recorded commit/,
  );
  const waiting = (await w.f.service.taskWorkspace(moved.taskId))!;
  assert.equal(waiting.state, "archived");
  assert.equal(waiting.workspaceId, moved.binding.workspaceId);
  assert.equal(w.lifecycle().forTask(moved.taskId).length, 1);
});

test("a removed workspace is provisioned again only from repositories the project still links", async (t) => {
  const w = await world(t);
  const reprovision = (taskId: string) =>
    // biome-ignore lint/complexity/useLiteralKeys: the admission route's own entry point
    w.f.service["reprovisionTaskWorkspace"](taskId);
  for (const imported of [false, true]) {
    const { taskId, binding } = await w.task();
    if (imported) w.domain.markImportedTask(taskId, `I_${randomUUID()}`, "R1");
    w.finish(taskId);
    assert.equal((await w.remove(taskId)).outcome, "cleaned");
    // The project unlinked the repository after removal.
    w.link({ repositories: [] });
    if (!imported)
      await assert.rejects(
        w.f.service.provisionTask(taskId, inputs(w)),
        /The project no longer links R1/,
      );
    await assert.rejects(reprovision(taskId), /The project no longer links R1/);
    const kept = (await w.f.service.taskWorkspace(taskId))!;
    assert.equal(kept.state, "archived");
    assert.equal(kept.workspaceId, binding.workspaceId);
    assert.equal(w.lifecycle().forTask(taskId).length, 1);
    // Linked again exactly, the same removed workspace is provisioned.
    w.link(binding);
    const again = (await reprovision(taskId))!;
    assert.equal(again.state, "ready", again.reason ?? "");
    assert.notEqual(again.workspaceId, binding.workspaceId);
  }
});

test("an unattributed result never resolves to a replacement that is still provisioning", async (t) => {
  const w = await world(t);
  const { taskId, binding } = await w.task();
  w.finish(taskId);
  assert.equal((await w.remove(taskId)).outcome, "cleaned");
  assert.equal(
    w.f.service.resultWorkspace(taskId, null)?.workspaceId,
    binding.workspaceId,
  );
  // The window between replacing the binding and the new generation being ready.
  const next = randomUUID();
  const path = join(binding.path, "..", next);
  startedOf(w.f.service).workspaceBindings.replaceRemoved(
    taskId,
    binding.workspaceId,
    { workspaceId: next, path },
    binding.repositories.map(({ gitDirectory: _, ...r }) => ({
      ...r,
      workspacePath: join(path, "repo-1"),
    })),
  );
  assert.equal(
    (await w.f.service.taskWorkspace(taskId))?.state,
    "provisioning",
  );
  assert.equal(w.f.service.resultWorkspace(taskId, null), undefined);
  assert.equal(w.f.service.resultWorkspace(taskId, randomUUID()), undefined);
});
