import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import type { TaskWorkspaceRepository } from "../../src/standalone/workspaces.js";
import { createOperatorFixture } from "../fixtures/operator-web.js";
import { until } from "../fixtures/questions.js";
import { startedOf } from "../fixtures/service-internals.js";
import { checkout, git } from "../fixtures/setup-home.js";
import { localBranchFetch } from "../fixtures/branch-fetch.js";
import type { StandaloneServiceOptions } from "../../src/standalone/service.js";
import type { CodeHostDeliveryProvider } from "../../src/standalone/code-host.js";
import type {
  BranchFetch,
  FetchBranchRequest,
} from "../../src/standalone/git-fetch.js";

async function world(delivery?: StandaloneServiceOptions["delivery"]) {
  const f = await createOperatorFixture(null, undefined, delivery);
  const projectId = randomUUID();
  const run = (body: Record<string, unknown>) =>
    f.service
      .domain()
      .execute({ actor: "operator", key: randomUUID(), ...body } as never);
  const profileId = randomUUID();
  run({
    type: "profile.create",
    profileId,
    name: "Local lead",
    instructions: "Local work",
    capabilities: "local",
  });
  run({
    type: "project.create",
    projectId,
    name: "Linked project",
    leadProfileId: profileId,
  });
  const link = (repositoryId: string, path: string, extra = {}) => ({
    codeHost: "github" as const,
    host: "github.com" as const,
    repositoryId,
    path,
    ref: "main",
    ...extra,
  });
  const configure = async (
    repositories: Record<string, unknown>[],
    expectedVersion = f.service.domain().repositoryLinks(projectId).version,
  ) =>
    f.service.domain().configureRepositories({
      type: "repositories.configure",
      actor: "operator",
      key: randomUUID(),
      projectId,
      expectedVersion,
      repositories,
    } as never);
  const readyTask = () => {
    const taskId = randomUUID();
    run({
      type: "task.create",
      projectId,
      taskId,
      title: "Local",
      outcome: "Work in every linked repository",
      ready: true,
    });
    return taskId;
  };
  const unpause = () =>
    run({
      type: "project.configure",
      projectId,
      expectedVersion: 1,
      paused: false,
    });
  return { f, projectId, link, configure, readyTask, unpause };
}

test("a local task's first workspace holds every linked repository at its ref", async () => {
  const w = await world();
  try {
    const hub = join(w.f.directory, "hub");
    const lab = join(w.f.directory, "lab");
    await checkout(hub, "https://github.com/acme/atlas.git");
    await checkout(lab, "https://gitlab.example.com/group/atlas.git");
    await w.configure([
      w.link("R_hub", hub),
      {
        codeHost: "gitlab",
        host: "gitlab.example.com",
        repositoryId: "4242",
        projectPath: "group/atlas",
        path: lab,
        ref: "main",
      },
    ]);
    const taskId = w.readyTask();
    w.unpause();
    await until(() => w.f.runtime.turns === 1);
    const binding = await w.f.service.taskWorkspace(taskId);
    assert.equal(binding?.state, "ready");
    assert.deepEqual(binding?.repositories.map((r) => r.repositoryId).sort(), [
      "4242",
      "R_hub",
    ]);
    for (const [id, source] of [
      ["R_hub", hub],
      ["4242", lab],
    ] as const) {
      const repository: TaskWorkspaceRepository | undefined =
        binding?.repositories.find((r) => r.repositoryId === id);
      assert.ok(repository, id);
      assert.equal(repository.sourcePath, await realpath(source));
      assert.equal(repository.ref, "main");
      assert.equal(
        (await git(repository.workspacePath, "rev-parse", "HEAD")).stdout,
        (await git(source, "rev-parse", "main")).stdout,
      );
    }
    // A second read finds the same workspace and no second turn starts.
    assert.equal(
      (await w.f.service.taskWorkspace(taskId))?.workspaceId,
      binding?.workspaceId,
    );
    assert.equal(w.f.runtime.turns, 1);
  } finally {
    await w.f.close();
  }
});

test("a local task in a project with only a GitLab link provisions its workspace and runs", async () => {
  const w = await world();
  try {
    const lab = join(w.f.directory, "lab");
    await checkout(lab, "git@gitlab.example.com:group/atlas.git");
    await w.configure([
      {
        codeHost: "gitlab",
        host: "gitlab.example.com",
        repositoryId: "4242",
        projectPath: "group/atlas",
        path: lab,
        ref: "main",
      },
    ]);
    const taskId = w.readyTask();
    w.unpause();
    await until(() => w.f.runtime.turns === 1);
    const binding = await w.f.service.taskWorkspace(taskId);
    assert.equal(binding?.state, "ready");
    assert.deepEqual(
      binding?.repositories.map((r) => r.repositoryId),
      ["4242"],
    );
  } finally {
    await w.f.close();
  }
});

test("a local task waits without a workspace when a linked checkout's identity changed", async () => {
  const w = await world();
  try {
    const hub = join(w.f.directory, "hub");
    await checkout(hub, "https://github.com/acme/atlas.git");
    await w.configure([w.link("R_hub", hub)]);
    // The linked path now resolves to another checkout.
    const other = join(w.f.directory, "other");
    await checkout(other, "https://github.com/acme/atlas.git");
    await rm(hub, { recursive: true });
    await symlink(other, hub);
    const taskId = w.readyTask();
    w.unpause();
    await until(() =>
      startedOf(w.f.service)
        .schedulerStore.forTask(taskId)
        .some((r) => r.reason?.startsWith("Workspace admission waiting:")),
    );
    assert.equal(await w.f.service.taskWorkspace(taskId), undefined);
    assert.equal(w.f.runtime.turns, 0);
  } finally {
    await w.f.close();
  }
});

test("a project with no links still gives a repository-free workspace", async () => {
  const w = await world();
  try {
    const taskId = w.readyTask();
    w.unpause();
    await until(() => w.f.runtime.turns === 1);
    assert.deepEqual(
      (await w.f.service.taskWorkspace(taskId))?.repositories,
      [],
    );
  } finally {
    await w.f.close();
  }
});

/** A commit on `dir`'s current branch; returns its id. */
async function commitIn(dir: string, name: string) {
  await writeFile(join(dir, name), `${name}\n`);
  await git(dir, "add", name);
  await git(
    dir,
    "-c",
    "user.name=T",
    "-c",
    "user.email=t@example.invalid",
    "commit",
    "-qm",
    name,
  );
  return (await git(dir, "rev-parse", "HEAD")).stdout.trim();
}

test("a remote base starts the workspace at the fetched or tracked branch tip, never the local branch, and stays bound", async () => {
  const fetching: { fail?: boolean; credential?: boolean } = {};
  let target: ReturnType<typeof localBranchFetch> | undefined;
  // The code host's verified transport, which reads the fixture's bare remote.
  const w = await world({
    providerFactories: {
      github: () =>
        ({
          fetchBranch: async (_repositoryId: string, request: BranchFetch) => {
            if (fetching.credential)
              throw new Error("provider-credential-unavailable");
            return fetching.fail
              ? { kind: "fetch-failed" as const }
              : target!.fetchBranch(request as FetchBranchRequest);
          },
        }) as unknown as CodeHostDeliveryProvider,
    },
  });
  try {
    // The code host is ahead of the checkout's `origin/main`, which is behind its local `main`.
    const hub = join(w.f.directory, "hub");
    const remote = join(w.f.directory, "remote.git");
    await checkout(hub, "https://github.com/acme/atlas.git");
    await git(w.f.directory, "clone", "-q", "--bare", hub, remote);
    target = localBranchFetch(remote);
    const tracked = (await git(hub, "rev-parse", "HEAD")).stdout.trim();
    await git(hub, "update-ref", "refs/remotes/origin/main", tracked);
    await git(
      hub,
      "symbolic-ref",
      "refs/remotes/origin/HEAD",
      "refs/remotes/origin/main",
    );
    const local = await commitIn(hub, "local.txt");
    const scratch = join(w.f.directory, "upstream");
    await git(w.f.directory, "clone", "-q", remote, scratch);
    const remoteMain = await commitIn(scratch, "remote-main.txt");
    await git(scratch, "push", "-q", "origin", "HEAD:main");
    await git(scratch, "checkout", "-q", "-b", "release");
    const release = await commitIn(scratch, "release.txt");
    await git(scratch, "push", "-q", "origin", "release");
    await git(remote, "symbolic-ref", "HEAD", "refs/heads/release");
    await w.configure([w.link("R_hub", hub)]);
    const checkoutState = async () => [
      (await git(hub, "for-each-ref")).stdout,
      (await git(hub, "rev-parse", "HEAD")).stdout,
      (await git(hub, "status", "--porcelain")).stdout,
      (await readdir(join(hub, ".git", "objects"), { recursive: true })).sort(),
    ];
    const before = await checkoutState();
    const provision = async (repository: Record<string, unknown>) => {
      const taskId = w.readyTask();
      const binding = await w.f.service.provisionTask(taskId, [
        { repositoryId: "R_hub", path: hub, ref: "main", ...repository },
      ]);
      return { taskId, binding, repository: binding.repositories[0]! };
    };
    const head = async (r: TaskWorkspaceRepository) =>
      (await git(r.workspacePath, "rev-parse", "HEAD")).stdout.trim();

    const fetched = await provision({
      base: { mode: "remote-branch", fetch: true },
    });
    assert.equal(
      fetched.binding.state,
      "ready",
      String(fetched.binding.reason),
    );
    assert.equal(await head(fetched.repository), remoteMain);
    assert.equal(fetched.repository.commit, remoteMain);
    assert.equal(fetched.repository.baseBranch, "main");
    assert.equal(
      (
        await git(
          String(fetched.repository.gitCommonDir),
          "rev-parse",
          "refs/cab/remote/main",
        )
      ).stdout.trim(),
      remoteMain,
    );
    const byDefault = await provision({
      base: { mode: "remote-default", fetch: true },
    });
    assert.equal(await head(byDefault.repository), release);
    assert.equal(byDefault.repository.baseBranch, "release");
    const tracking = await provision({
      base: { mode: "remote-branch", fetch: false },
    });
    assert.equal(await head(tracking.repository), tracked);
    const explicit = await provision({});
    assert.equal(await head(explicit.repository), local);
    assert.equal(explicit.repository.baseBranch, undefined);
    // A stacked dependent's requested commit wins: nothing is fetched for it.
    const requests = target.requests.length;
    const stacked = await provision({
      commit: tracked,
      base: { mode: "remote-branch", fetch: true },
    });
    assert.equal(await head(stacked.repository), tracked);
    assert.equal(target.requests.length, requests);

    // A failed fetch holds provisioning visibly and never falls back.
    fetching.fail = true;
    const failed = await provision({
      base: { mode: "remote-branch", fetch: true },
    });
    assert.equal(failed.binding.state, "provisioning");
    assert.match(String(failed.binding.reason), /remote base fetch failed/);
    assert.equal(failed.repository.commit, null);
    fetching.fail = false;
    fetching.credential = true;
    const unauthenticated = await provision({
      base: { mode: "remote-default", fetch: true },
    });
    assert.match(
      String(unauthenticated.binding.reason),
      /remote base credential unavailable/,
    );
    fetching.credential = false;

    // The bound base never moves when the remote advances or the link changes.
    await commitIn(scratch, "later.txt");
    await git(scratch, "push", "-q", "origin", "HEAD:main");
    assert.equal(
      (await w.f.service.taskWorkspace(fetched.taskId))?.repositories[0]
        ?.commit,
      remoteMain,
    );
    assert.deepEqual(await checkoutState(), before);
  } finally {
    await w.f.close();
  }
});
