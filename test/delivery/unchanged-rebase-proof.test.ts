import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  writeFileSync,
  rmSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { proveUnchangedRebase } from "../../src/standalone/rebase-proof.js";
import {
  verifierGit,
  type Git,
} from "../../src/standalone/push-verification.js";
import { forgeCommitGraphParent } from "../fixtures/forged-commit-graph.js";

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "cab-proof-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: root,
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_AUTHOR_NAME: "Test",
        GIT_AUTHOR_EMAIL: "test@example.test",
        GIT_COMMITTER_NAME: "Test",
        GIT_COMMITTER_EMAIL: "test@example.test",
      },
      encoding: "utf8",
    }).trim();
  git("init", "-q");
  const commit = (file: string, value: string, message: string) => {
    writeFileSync(join(root, file), value);
    git("add", file);
    git("commit", "-qm", message);
    return git("rev-parse", "HEAD");
  };
  const base = commit("base", "base\n", "base");
  const first = commit("one", "one\n", "one");
  const head = commit("two", "two\n", "two");
  git("checkout", "-q", "--detach", base);
  const nextBase = commit("trunk", "trunk\n", "trunk");
  git("cherry-pick", first, head);
  const nextHead = git("rev-parse", "HEAD");
  const source = verifierGit(root);
  const proof = (newHead = nextHead, read: Git = source) =>
    proveUnchangedRebase(read, base, head, nextBase, newHead);
  return {
    root,
    git,
    commit,
    base,
    first,
    head,
    nextBase,
    nextHead,
    source,
    proof,
  };
}

test("clean rebase proves ordered patches and exact messages without moving workspace state", async (t) => {
  const f = fixture(t);
  const before = [
    f.git("rev-parse", "HEAD"),
    f.git("status", "--porcelain"),
    readFileSync(join(f.root, ".git/index")),
  ];
  const p = await f.proof();
  assert.equal(p?.pairs.length, 2);
  assert.equal(p?.pairs[0]?.oldCommit, f.first);
  assert.ok(!JSON.stringify(p).includes('"message":'));
  assert.deepEqual(
    [
      f.git("rev-parse", "HEAD"),
      f.git("status", "--porcelain"),
      readFileSync(join(f.root, ".git/index")),
    ],
    before,
  );
  f.git(
    "commit",
    "--amend",
    "--no-edit",
    "--author=Other <other@example.test>",
  );
  assert.ok(await f.proof(f.git("rev-parse", "HEAD")));
});

test("rewording keeps patch id but refuses the proof", async (t) => {
  const f = fixture(t);
  const before = await f.proof();
  f.git("commit", "--amend", "-m", "reworded");
  const rewritten = f.git("rev-parse", "HEAD");
  const patch = (id: string) =>
    execFileSync("git", ["patch-id", "--stable"], {
      cwd: f.root,
      input: execFileSync("git", ["show", "--format=", id], { cwd: f.root }),
      encoding: "utf8",
    }).split(" ")[0];
  assert.equal(patch(rewritten), before?.pairs[1]?.patchId);
  assert.equal(await f.proof(rewritten), null);
});

test("drop, add, reorder, changed resolution, wrong ancestry, empty and nonlinear ranges refuse", async (t) => {
  const f = fixture(t);
  assert.equal(await f.proof(f.git("rev-parse", `${f.nextHead}^`)), null);
  const added = f.commit("extra", "extra", "extra");
  assert.equal(await f.proof(added), null);
  f.git("checkout", "-q", "--detach", f.nextBase);
  f.git("cherry-pick", f.head, f.first);
  assert.equal(await f.proof(f.git("rev-parse", "HEAD")), null);
  f.git("checkout", "-q", "--detach", f.nextHead);
  f.commit("two", "conflict resolution\n", "two");
  f.git("reset", "--soft", "HEAD~2");
  f.git("commit", "-qm", "two");
  assert.equal(await f.proof(f.git("rev-parse", "HEAD")), null);
  assert.equal(
    await proveUnchangedRebase(
      f.source,
      f.base,
      f.head,
      f.nextHead,
      f.nextBase,
    ),
    null,
  );
  assert.equal(
    await proveUnchangedRebase(
      f.source,
      f.base,
      f.base,
      f.nextBase,
      f.nextBase,
    ),
    null,
  );
  f.git("checkout", "-q", "--detach", f.nextHead);
  f.git("commit", "--allow-empty", "-qm", "empty");
  assert.equal(await f.proof(f.git("rev-parse", "HEAD")), null);
  f.git("merge", "--no-ff", "-m", "merge", added);
  assert.equal(await f.proof(f.git("rev-parse", "HEAD")), null);
});

test("squash lower layer then restack dependent has the same bounded proof", async (t) => {
  const f = fixture(t);
  f.git("checkout", "-q", "--detach", f.base);
  const lower = f.commit("lower", "lower", "lower");
  const dep = f.commit("dep", "dep", "dependent");
  f.git("checkout", "-q", "--detach", f.nextBase);
  f.git("merge", "--squash", lower);
  f.git("commit", "-qm", "squashed lower");
  const merged = f.git("rev-parse", "HEAD");
  f.git("cherry-pick", dep);
  assert.ok(
    await proveUnchangedRebase(
      f.source,
      lower,
      dep,
      merged,
      f.git("rev-parse", "HEAD"),
    ),
  );
});

test("missing and forged raw commit, tree and blob objects fail closed", async (t) => {
  for (const type of ["commit", "tree", "blob"]) {
    const f = fixture(t);
    const id =
      type === "commit"
        ? f.head
        : type === "tree"
          ? f.git("rev-parse", `${f.head}^{tree}`)
          : f.git("rev-parse", `${f.head}:two`);
    const path = join(f.root, ".git/objects", id.slice(0, 2), id.slice(2));
    const original = readFileSync(path);
    chmodSync(path, 0o644);
    writeFileSync(path, deflateSync(Buffer.from(`${type} 6\0forged`)));
    assert.equal(await f.proof(), null, type);
    writeFileSync(path, original);
    rmSync(path);
    assert.equal(await f.proof(), null, `missing ${type}`);
  }
});

test("forged graph, replace refs and graft cannot manufacture ancestry", async (t) => {
  const f = fixture(t);
  f.git("branch", "old-proof", f.head);
  f.git("branch", "new-proof", f.nextHead);
  f.git("commit-graph", "write", "--reachable");
  forgeCommitGraphParent(
    join(f.root, ".git/objects/info/commit-graph"),
    f.nextBase,
    f.head,
  );
  f.git("replace", f.nextBase, f.head);
  writeFileSync(join(f.root, ".git/info/grafts"), `${f.nextBase} ${f.head}\n`);
  assert.equal(
    await proveUnchangedRebase(f.source, f.head, f.nextBase, f.base, f.head),
    null,
  );
});

test("cancelled and bounded or ambiguous object output never partially proves", async (t) => {
  const f = fixture(t);
  const controller = new AbortController();
  controller.abort();
  assert.equal(
    await proveUnchangedRebase(
      f.source,
      f.base,
      f.head,
      f.nextBase,
      f.nextHead,
      controller.signal,
    ),
    null,
  );
  for (const stdout of [
    Buffer.from(`${f.head} commit 999999999\n`),
    Buffer.from(`${f.head} commit 1\nx\nextra`),
  ]) {
    assert.equal(
      await f.proof(f.nextHead, async () => ({ status: "ok", stdout })),
      null,
    );
  }
});

test("duplicate patch ids stay paired by position, with message equality at every position", async (t) => {
  const f = fixture(t);
  f.git("checkout", "-q", "--detach", f.base);
  f.commit("repeat", "yes\n", "add first");
  f.git("rm", "repeat");
  f.git("commit", "-qm", "remove");
  const duplicateHead = f.commit("repeat", "yes\n", "add second");
  const commits = f
    .git("rev-list", "--reverse", `${f.base}..${duplicateHead}`)
    .split("\n");
  f.git("checkout", "-q", "--detach", f.nextBase);
  f.git("cherry-pick", ...commits);
  const proof = await proveUnchangedRebase(
    f.source,
    f.base,
    duplicateHead,
    f.nextBase,
    f.git("rev-parse", "HEAD"),
  );
  assert.equal(proof?.pairs.length, 3);
  assert.equal(proof?.pairs[0]?.patchId, proof?.pairs[2]?.patchId);
  assert.notEqual(
    proof?.pairs[0]?.messageSha256,
    proof?.pairs[2]?.messageSha256,
  );
});

test("agent attributes, diff drivers and filters never execute in proof", async (t) => {
  const f = fixture(t);
  const marker = join(f.root, "helper-ran");
  writeFileSync(
    join(f.root, ".git/info/attributes"),
    "* diff=hostile filter=hostile\n",
  );
  f.git("config", "diff.hostile.command", `touch ${marker}`);
  f.git("config", "diff.hostile.textconv", `touch ${marker}`);
  f.git("config", "filter.hostile.process", `touch ${marker}`);
  assert.ok(await f.proof());
  assert.throws(() => readFileSync(marker), { code: "ENOENT" });
});
