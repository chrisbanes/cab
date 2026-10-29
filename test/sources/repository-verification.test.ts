import assert from "node:assert/strict";
import { mkdir, realpath, symlink } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { parseGitLabOrigin } from "../../src/core/github-source.js";
import {
  checkoutOrigin,
  verifiedRepository,
} from "../../src/standalone/repository-verification.js";
import {
  gitEnvironmentProbe,
  hardenedGitEnvironment,
  withHostileGitEnvironment,
} from "../fixtures/git-environment.js";
import { checkout, createSetupHome, git } from "../fixtures/setup-home.js";

const link = (path: string, ref = "main") => ({
  repositoryId: "R",
  path,
  ref,
});
const reason = (p: Promise<unknown>) =>
  p.then(
    () => "verified",
    (e: { reason?: string; actual?: string }) =>
      `${e.reason}${e.actual ? `:${e.actual}` : ""}`,
  );

test("the verifier reports typed reasons and keeps the no-origin path for configured links", async (t) => {
  const home = await createSetupHome();
  t.after(() => home.close());
  const src = join(home.home, "src");
  const expected = { owner: "acme", name: "atlas" };
  assert.equal(
    await reason(verifiedRepository(link(join(src, "relay")), expected)),
    "origin-mismatch:acme/relay",
  );
  assert.equal(
    await reason(
      verifiedRepository(link(join(src, "atlas"), "nope"), expected),
    ),
    "ref-unavailable",
  );
  // Mismatch is reported ahead of a missing ref.
  assert.equal(
    await reason(
      verifiedRepository(link(join(src, "relay"), "nope"), expected),
    ),
    "origin-mismatch:acme/relay",
  );
  assert.equal(
    await reason(verifiedRepository(link(join(src, "gitlab")), expected)),
    "origin-provider",
  );
  // Without an expected origin the remote is not consulted (github.configure and admission).
  assert.equal(
    await reason(verifiedRepository(link(join(src, "gitlab")))),
    "verified",
  );
  await git(join(src, "atlas"), "remote", "remove", "origin");
  assert.equal(
    await reason(verifiedRepository(link(join(src, "atlas")))),
    "verified",
  );
  assert.equal(
    await reason(verifiedRepository(link(join(src, "atlas")), expected)),
    "origin-missing",
  );
});

test("the verifier reports unusable paths and returns canonical ones", async (t) => {
  const home = await createSetupHome();
  t.after(() => home.close());
  const src = join(home.home, "src");
  assert.equal(
    await reason(verifiedRepository(link("src/atlas"))),
    "path-invalid",
  );
  assert.equal(
    await reason(verifiedRepository(link(join(src, "missing")))),
    "path-invalid",
  );
  assert.equal(
    await reason(verifiedRepository(link(join(src, "design-notes")))),
    "not-checkout",
  );
  const alias = join(home.home, "alias");
  await symlink(join(src, "atlas"), alias);
  const verified = await verifiedRepository(link(alias));
  assert.equal(verified.path, await realpath(join(src, "atlas")));
});

test("the verifier keeps a linked worktree's shared Git common directory", async (t) => {
  const home = await createSetupHome();
  t.after(() => home.close());
  const main = join(home.home, "src", "atlas");
  const extra = join(home.home, "worktrees", "atlas-two");
  await mkdir(join(home.home, "worktrees"), { recursive: true });
  await git(main, "worktree", "add", "-q", "-b", "two", extra);
  const [primary, secondary] = await Promise.all([
    verifiedRepository(link(main)),
    verifiedRepository(link(extra, "two")),
  ]);
  assert.equal(secondary.gitCommonDirectory, primary.gitCommonDirectory);
});

test("repository verification ignores inherited GIT_* overrides", async (t) => {
  const home = await createSetupHome();
  const probe = gitEnvironmentProbe();
  t.after(() => {
    home.close();
    probe.close();
  });
  const path = await realpath(join(home.home, "src", "atlas"));
  const commonDirectory = await realpath(
    (
      await git(path, "rev-parse", "--path-format=absolute", "--git-common-dir")
    ).stdout.trim(),
  );
  const hadGitDirectory = "GIT_DIR" in process.env;

  const [verified, origin] = await withHostileGitEnvironment(() =>
    probe.withPath(async () => [
      await verifiedRepository(
        { repositoryId: "R", path, ref: "main" },
        { owner: "acme", name: "atlas" },
      ),
      await checkoutOrigin(path),
    ]),
  );

  assert.equal(
    (verified as { gitCommonDirectory: string }).gitCommonDirectory,
    commonDirectory,
  );
  assert.deepEqual(origin, { owner: "acme", name: "atlas" });
  const invocations = probe.invocations();
  assert.ok(invocations.length >= 4, "every verification call is recorded");
  for (const invocation of invocations)
    assert.deepEqual(invocation.env, hardenedGitEnvironment, invocation.args);
  assert.equal("GIT_DIR" in process.env, hadGitDirectory);
});

test("checkoutOrigin reports a missing origin as a verification reason", async (t) => {
  const home = await createSetupHome();
  t.after(() => home.close());
  const bare = join(home.home, "src", "plain");
  await checkout(bare);
  await assert.rejects(
    checkoutOrigin(bare),
    (e: { reason?: string }) => e.reason === "origin-missing",
  );
});

test("a GitLab link verifies the origin's host and full project path", async (t) => {
  const home = await createSetupHome();
  t.after(() => home.close());
  const expected = {
    codeHost: "gitlab",
    host: "gitlab.example.com",
    projectPath: "Group/Sub/Atlas",
  } as const;
  const origins: Record<string, string> = {
    https: "https://gitlab.example.com/group/sub/atlas.git",
    userinfo: "https://oauth2@GitLab.Example.com/Group/Sub/Atlas/",
    ssh: "ssh://git@gitlab.example.com:2222/group/sub/atlas.git",
    scp: "git@gitlab.example.com:group/sub/atlas",
    other: "https://gitlab.example.com/group/sub/other.git",
    dotcom: "https://gitlab.com/group/sub/atlas.git",
    port: "https://gitlab.example.com:8443/group/sub/atlas.git",
    single: "https://gitlab.example.com/atlas.git",
  };
  const dirs: Record<string, string> = {};
  for (const [name, origin] of Object.entries(origins)) {
    dirs[name] = join(home.home, "gitlab", name);
    await checkout(dirs[name], origin);
  }
  for (const name of ["https", "userinfo", "ssh", "scp"])
    assert.equal(
      await reason(verifiedRepository(link(dirs[name] as string), expected)),
      "verified",
      name,
    );
  assert.equal(
    await reason(verifiedRepository(link(dirs.other as string), expected)),
    "origin-mismatch:group/sub/other",
  );
  for (const name of ["dotcom", "port", "single"])
    assert.equal(
      await reason(verifiedRepository(link(dirs[name] as string), expected)),
      "origin-provider",
      name,
    );
  assert.equal(
    await reason(
      verifiedRepository(link(dirs.https as string, "nope"), expected),
    ),
    "ref-unavailable",
  );
  await git(dirs.https as string, "remote", "remove", "origin");
  assert.equal(
    await reason(verifiedRepository(link(dirs.https as string), expected)),
    "origin-missing",
  );
});

test("parseGitLabOrigin accepts project URLs on its host and nothing else", () => {
  const host = "gitlab.example.com";
  for (const url of [
    "https://gitlab.example.com/a/b/c.git",
    "https://user@GITLAB.example.com/a/b/c/",
    "ssh://git@gitlab.example.com:22/a/b/c.git",
    "git@gitlab.example.com:a/b/c",
  ])
    assert.equal(parseGitLabOrigin(url, host), "a/b/c", url);
  for (const url of [
    "http://gitlab.example.com/a/b",
    "file:///gitlab.example.com/a/b",
    "https://gitlab.example.com/a/../b",
    "https://gitlab.example.com/a/.git",
    "https://gitlab.example.com/a/b.git.git",
    "https://gitlab.example.com/a/%zz",
    "https://gitlab.example.com:8443/a/b",
    "https://other.example.com/a/b",
    "not a url",
  ])
    assert.equal(parseGitLabOrigin(url, host), null, url);
});
