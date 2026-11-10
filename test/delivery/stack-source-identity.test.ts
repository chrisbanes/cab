import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { git } from "../fixtures/publication.js";
import { tmpdir } from "../fixtures/temp.js";
import { assertNoPackedSourceShadow } from "./github-qualification/stack-authority.js";
import {
  captureSourceReferencePaths,
  readSourceReference,
  sourceReferenceMatches,
} from "./github-qualification/stack-resource-preflight.js";

const commit = "a".repeat(40);
const branch = "cb/fixture";

test("source identity accepts the exact branch or detached HEAD Git reports", () => {
  assert.equal(
    sourceReferenceMatches(
      branch,
      `refs/heads/${branch}\n`,
      `${commit}\n`,
      commit,
    ),
    true,
  );
  assert.equal(sourceReferenceMatches("HEAD", "HEAD\n", commit, commit), true);
  for (const [expected, symbolic, head] of [
    [branch, "refs/heads/other", commit],
    [branch, "HEAD", commit],
    [branch, `refs/heads/${branch}`, "b".repeat(40)],
    ["HEAD", `refs/heads/${branch}`, commit],
    ["HEAD", "HEAD", "b".repeat(40)],
  ] as const)
    assert.equal(
      sourceReferenceMatches(expected, symbolic, head, commit),
      false,
      `${expected} ${symbolic} ${head}`,
    );
});

test("a new loose override invalidates a captured packed branch even at the same SHA", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cab-source-ref-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const packed = join(root, "packed-refs");
  await writeFile(packed, `${commit} refs/heads/${branch}\n`);
  const host = { sourceBranch: branch, sourceRefFile: packed };
  await assertNoPackedSourceShadow(host);
  await mkdir(join(root, "refs/heads/cb"), { recursive: true });
  await writeFile(join(root, "refs/heads", branch), `${commit}\n`);
  await assert.rejects(
    assertNoPackedSourceShadow(host),
    /v2-source-ref-storage-changed/,
  );
  await assertNoPackedSourceShadow({
    sourceBranch: "HEAD",
    sourceRefFile: join(root, "HEAD"),
  });
});

async function matches(root: string, branchName: string, expected: string) {
  const { symbolic, head } = await readSourceReference("git", root);
  return sourceReferenceMatches(branchName, symbolic, head, expected);
}

for (const format of ["files", "reftable"] as const)
  test(`captured source identity follows real ${format} Git metadata through branch, ref and detached changes`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), `cab-source-${format}-`));
    t.after(() => rm(root, { recursive: true, force: true }));
    git(root, "init", "-q", `--ref-format=${format}`, "-b", branch);
    git(root, "commit", "--allow-empty", "-q", "-m", "synthetic source");
    const expected = git(root, "rev-parse", "HEAD");
    const capture = () =>
      captureSourceReferencePaths(root, (...args) => git(root, ...args));
    let identity = await capture();
    assert.equal(identity.sourceBranch, branch);
    if (format === "reftable") {
      assert.ok(identity.sourceRefFile.endsWith("/reftable/tables.list"));
      assert.equal(identity.sourceRefFile, identity.sourceHeadFile);
    } else assert.ok(identity.sourceRefFile.endsWith(`/refs/heads/${branch}`));
    assert.equal(await matches(root, branch, expected), true);
    const before = await readFile(identity.sourceRefFile);

    git(root, "commit", "--allow-empty", "-q", "-m", "moved");
    assert.equal(await matches(root, branch, expected), false);
    assert.notDeepEqual(await readFile(identity.sourceRefFile), before);
    git(root, "reset", "-q", "--hard", expected);

    git(root, "checkout", "-q", "-b", "other");
    assert.equal(await matches(root, branch, expected), false);
    git(root, "checkout", "-q", branch);

    if (format === "files") {
      git(root, "pack-refs", "--all");
      identity = await capture();
      assert.ok(identity.sourceRefFile.endsWith("/packed-refs"));
      assert.equal(await matches(root, branch, expected), true);
      await assertNoPackedSourceShadow(identity);
    }

    git(root, "checkout", "--detach", "-q", "HEAD");
    identity = await capture();
    assert.equal(identity.sourceBranch, "HEAD");
    assert.equal(identity.sourceRefFile, identity.sourceHeadFile);
    assert.equal(await matches(root, "HEAD", expected), true);
    assert.equal(await matches(root, branch, expected), false);
  });

test("a cab-managed reftable worktree pins its own HEAD stack and branches in the common stack", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cab-source-managed-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "source"),
    managed = join(root, "managed"),
    workspace = join(root, "workspace", "repo-1");
  await mkdir(source);
  git(source, "init", "-q", "--ref-format=files");
  git(source, "commit", "--allow-empty", "-q", "-m", "synthetic source");
  const expected = git(source, "rev-parse", "HEAD");
  git(
    root,
    "init",
    "-q",
    "--bare",
    "--template=",
    "--ref-format=reftable",
    managed,
  );
  await writeFile(
    join(managed, "objects", "info", "alternates"),
    `${join(source, ".git", "objects")}\n`,
  );
  git(managed, "worktree", "add", "-q", "--detach", workspace, expected);
  assert.equal(git(workspace, "rev-parse", "--show-ref-format"), "reftable");
  const capture = () =>
    captureSourceReferencePaths(workspace, (...args) =>
      git(workspace, ...args),
    );

  let identity = await capture();
  assert.equal(identity.sourceBranch, "HEAD");
  assert.equal(
    identity.sourceHeadFile,
    join(managed, "worktrees", "repo-1", "reftable", "tables.list"),
  );
  assert.equal(identity.sourceRefFile, identity.sourceHeadFile);
  assert.equal(await matches(workspace, "HEAD", expected), true);

  git(workspace, "switch", "-q", "-c", branch);
  identity = await capture();
  assert.equal(identity.sourceBranch, branch);
  assert.equal(
    identity.sourceRefFile,
    join(managed, "reftable", "tables.list"),
  );
  assert.equal(await matches(workspace, branch, expected), true);
  const before = await readFile(identity.sourceRefFile);
  git(workspace, "commit", "--allow-empty", "-q", "-m", "moved");
  assert.notDeepEqual(await readFile(identity.sourceRefFile), before);
  assert.equal(await matches(workspace, branch, expected), false);
});
