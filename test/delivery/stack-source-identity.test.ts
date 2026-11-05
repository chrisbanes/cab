import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { git } from "../fixtures/publication.js";
import { tmpdir } from "../fixtures/temp.js";
import { assertNoPackedSourceShadow } from "./github-qualification/stack-authority.js";
import {
  captureSourceReferencePaths,
  sourceReferenceMatches,
} from "./github-qualification/stack-resource-preflight.js";

const commit = "a".repeat(40);
const branch = "cb/fixture";
const head = `ref: refs/heads/${branch}\n`;

test("source identity accepts exact loose and packed branch representations", () => {
  assert.equal(
    sourceReferenceMatches(branch, head, `${commit}\n`, commit, false),
    true,
  );
  assert.equal(
    sourceReferenceMatches(
      branch,
      head,
      `# pack-refs with: peeled fully-peeled sorted\n${"b".repeat(40)} refs/heads/other\n${commit} refs/heads/${branch}\n`,
      commit,
      true,
    ),
    true,
  );
  for (const ref of [
    `${"b".repeat(40)} refs/heads/${branch}`,
    `${commit} refs/heads/other`,
    `${commit} refs/heads/${branch}\n${commit} refs/heads/${branch}`,
    `malformed refs/heads/${branch}`,
  ])
    assert.equal(
      sourceReferenceMatches(branch, head, ref, commit, true),
      false,
    );
  assert.equal(
    sourceReferenceMatches(
      branch,
      "ref: refs/heads/other",
      commit,
      commit,
      false,
    ),
    false,
  );
  assert.equal(
    sourceReferenceMatches(branch, head, "b".repeat(40), commit, false),
    false,
  );
});

test("source identity accepts an explicitly pinned detached HEAD, refusing branch or commit drift", () => {
  assert.equal(
    sourceReferenceMatches("HEAD", `${commit}\n`, `${commit}\n`, commit, false),
    true,
  );
  assert.equal(
    sourceReferenceMatches("HEAD", head, commit, commit, false),
    false,
  );
  assert.equal(
    sourceReferenceMatches("HEAD", commit, "b".repeat(40), commit, false),
    false,
  );
  assert.equal(
    sourceReferenceMatches("HEAD", commit, commit, commit, true),
    false,
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

test("captured source identity follows real loose, packed and detached Git metadata", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cab-source-storage-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, "init", "-q", "-b", branch);
  git(root, "commit", "--allow-empty", "-q", "-m", "synthetic source identity");
  const expected = git(root, "rev-parse", "HEAD");
  const capture = () =>
    captureSourceReferencePaths(root, (...args) => git(root, ...args));
  let identity = await capture();
  assert.equal(identity.sourceBranch, branch);
  assert.equal(
    sourceReferenceMatches(
      identity.sourceBranch,
      await readFile(identity.sourceHeadFile, "utf8"),
      await readFile(identity.sourceRefFile, "utf8"),
      expected,
      false,
    ),
    true,
  );
  git(root, "pack-refs", "--all");
  identity = await capture();
  assert.ok(identity.sourceRefFile.endsWith("/packed-refs"));
  assert.equal(
    sourceReferenceMatches(
      identity.sourceBranch,
      await readFile(identity.sourceHeadFile, "utf8"),
      await readFile(identity.sourceRefFile, "utf8"),
      expected,
      true,
    ),
    true,
  );
  await assertNoPackedSourceShadow(identity);
  git(root, "checkout", "--detach", "-q", "HEAD");
  identity = await capture();
  assert.equal(identity.sourceBranch, "HEAD");
  assert.equal(identity.sourceRefFile, identity.sourceHeadFile);
  assert.equal(git(root, "rev-parse", "--symbolic-full-name", "HEAD"), "HEAD");
  assert.equal(
    sourceReferenceMatches(
      identity.sourceBranch,
      await readFile(identity.sourceHeadFile, "utf8"),
      await readFile(identity.sourceRefFile, "utf8"),
      expected,
      false,
    ),
    true,
  );
});
