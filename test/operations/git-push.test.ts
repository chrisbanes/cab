import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
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
import {
  pushCredentialHelper,
  pushTaskCommit,
} from "../../src/standalone/git-push.js";

const token = "ghp_push_credential_0123456789abcdef";
const realGit = spawnSync("which", ["git"], { encoding: "utf8" }).stdout.trim();

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" },
  }).trim();
}

/** A source repository with one commit and a detached task worktree on it. */
function repository(t: TestContext, prefix = "cab-git-push-") {
  const root = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, "source");
  mkdirSync(source);
  git(source, "init", "-q", "-b", "main");
  git(source, "config", "user.name", "T");
  git(source, "config", "user.email", "t@example.com");
  writeFileSync(join(source, "a.txt"), "a\n");
  git(source, "add", ".");
  git(source, "commit", "-q", "-m", "a");
  const workspace = join(root, "workspace");
  git(source, "worktree", "add", "-q", "--detach", workspace);
  writeFileSync(join(workspace, "b.txt"), "b\n");
  git(workspace, "add", ".");
  git(
    workspace,
    "-c",
    "user.name=T",
    "-c",
    "user.email=t@e.com",
    "commit",
    "-q",
    "-m",
    "b",
  );
  return { root, source, workspace, sha: git(workspace, "rev-parse", "HEAD") };
}

/**
 * A `git` shim: everything but `push` runs the real Git. A push records its argv, selected
 * environment and cwd, and what the push would see (effective configuration and whether the commit
 * resolves), then prints the canned report and exits as scripted.
 */
function shim(
  t: TestContext,
  behaviour: { stdout?: string; exit?: number; sleep?: boolean } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), "cab-git-push-shim-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const executable = join(directory, "git");
  const record = join(directory, "record.json");
  const started = join(directory, "started");
  writeFileSync(
    executable,
    `#!${process.execPath}
const { spawnSync } = require("node:child_process");
const { writeFileSync, readFileSync } = require("node:fs");
const args = process.argv.slice(2);
if (!args.includes("push")) {
  const r = spawnSync(${JSON.stringify(realGit)}, args, { stdio: "inherit" });
  process.exit(r.status ?? 1);
}
const real = (a) => spawnSync(${JSON.stringify(realGit)}, a, { encoding: "utf8" });
const refspec = args[args.length - 1];
const sha = refspec.split(":")[0];
writeFileSync(${JSON.stringify(record)}, JSON.stringify({
  args,
  cwd: process.cwd(),
  env: Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(GIT_|CAB_|HOME$)/.test(k))),
  config: real([...args.slice(0, args.indexOf("push")), "config", "--list", "--show-origin"]).stdout,
  scratchConfig: readFileSync(process.env.GIT_DIR + "/config", "utf8"),
  resolves: real(["rev-parse", "--verify", sha + "^{commit}"]).stdout.trim(),
}));
writeFileSync(${JSON.stringify(started)}, "1");
${behaviour.sleep ? "setTimeout(() => {}, 60000);" : `process.stdout.write(${JSON.stringify(behaviour.stdout ?? "")}); process.exit(${behaviour.exit ?? 0});`}
`,
  );
  chmodSync(executable, 0o755);
  return {
    executable,
    started,
    recorded: () =>
      JSON.parse(readFileSync(record, "utf8")) as {
        args: string[];
        cwd: string;
        env: Record<string, string>;
        config: string;
        scratchConfig: string;
        resolves: string;
      },
  };
}

const request = (repo: ReturnType<typeof repository>, executable: string) => ({
  workspacePath: repo.workspace,
  host: "github.com",
  nameWithOwner: "octo/fixture",
  commitSha: repo.sha,
  branch: "cab/abcd1234-task",
  token,
  executable,
  lease: null as string | null,
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

test("the token reaches only the push child's environment, never argv, configuration or files", async (t) => {
  const repo = repository(t);
  const fake = shim(t);
  assert.equal(await pushTaskCommit(request(repo, fake.executable)), "pushed");
  const seen = fake.recorded();
  assert.equal(seen.env.CAB_PUSH_TOKEN, token);
  assert.equal(
    seen.args.some((a) => a.includes(token)),
    false,
  );
  assert.equal(seen.config.includes(token), false);
  assert.equal(seen.scratchConfig.includes(token), false);
  assert.deepEqual(filesContaining(repo.root, token), []);
  assert.equal(
    existsSync(seen.env.GIT_DIR ?? ""),
    false,
    "scratch repository removed",
  );
  assert.ok(seen.args.includes("--no-verify"));
  assert.deepEqual(seen.args.slice(-3), [
    "--force-with-lease=refs/heads/cab/abcd1234-task:",
    "https://github.com/octo/fixture.git",
    `${repo.sha}:refs/heads/cab/abcd1234-task`,
  ]);
  // Even a first push is leased: the branch must not exist yet.
  assert.ok(
    seen.args.includes("--force-with-lease=refs/heads/cab/abcd1234-task:"),
  );
  assert.equal(seen.env.GIT_ALLOW_PROTOCOL, "https");
  assert.equal(
    seen.resolves,
    repo.sha,
    "the commit resolves through the worktree's objects",
  );
  assert.notEqual(seen.cwd, repo.workspace);
});

test("a checkout path containing a colon still resolves the commit through quoted alternates", async (t) => {
  const repo = repository(t, "cab-git-push-a:b-");
  const fake = shim(t);
  assert.equal(await pushTaskCommit(request(repo, fake.executable)), "pushed");
  const seen = fake.recorded();
  assert.equal(seen.resolves, repo.sha);
  assert.equal(
    seen.env.GIT_ALTERNATE_OBJECT_DIRECTORIES,
    JSON.stringify(
      join(git(repo.workspace, "rev-parse", "--git-common-dir"), "objects"),
    ),
  );
});

test("repository-local, user and system configuration cannot redirect the push or its credential", async (t) => {
  const repo = repository(t);
  const home = join(repo.root, "home");
  mkdirSync(home);
  const hostile = [
    '[url "https://evil.example/"]\n\tinsteadOf = https://github.com/\n',
    "[http]\n\tproxy = http://evil.example:3128\n\textraHeader = X-Evil: 1\n",
    "[credential]\n\thelper = !echo password=stolen\n",
    "[core]\n\tsshCommand = evil\n\thooksPath = /tmp/evil-hooks\n",
  ].join("");
  writeFileSync(join(home, ".gitconfig"), hostile);
  writeFileSync(join(repo.root, "include.cfg"), hostile);
  git(repo.workspace, "config", "include.path", join(repo.root, "include.cfg"));
  git(
    repo.workspace,
    "config",
    "url.https://evil.example/.insteadOf",
    "https://github.com/",
  );
  git(
    repo.workspace,
    "config",
    "remote.origin.pushurl",
    "https://evil.example/o/r.git",
  );
  git(repo.workspace, "config", "credential.helper", "!echo password=stolen");
  git(repo.workspace, "config", "http.proxy", "http://evil.example:3128");
  const priorHome = process.env.HOME;
  process.env.HOME = home;
  t.after(() => {
    if (priorHome === undefined) delete process.env.HOME;
    else process.env.HOME = priorHome;
  });
  const fake = shim(t);
  assert.equal(await pushTaskCommit(request(repo, fake.executable)), "pushed");
  const config = fake.recorded().config.trim().split("\n");
  // Every effective entry comes from the explicit command line.
  assert.deepEqual(
    config.filter((line) => !line.startsWith("command line:")),
    [],
  );
  const joined = config.join("\n");
  assert.match(joined, /protocol\.allow=never/);
  assert.match(joined, /protocol\.https\.allow=always/);
  assert.match(joined, /http\.followredirects=false/);
  assert.match(joined, /http\.proxy=(\n|$)/);
  assert.match(joined, /credential\.usehttppath=true/);
  assert.equal(joined.includes("evil"), false);
});

test("the credential helper answers only for https github.com and the exact repository path", () => {
  const ask = (input: string) =>
    spawnSync("sh", ["-c", `${pushCredentialHelper.slice(1)} get`], {
      input,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        CAB_PUSH_TOKEN: token,
        CAB_PUSH_HOST: "github.com",
        CAB_PUSH_PATH: "octo/fixture.git",
      },
    }).stdout;
  const good = "protocol=https\nhost=github.com\npath=octo/fixture.git\n";
  assert.equal(ask(good), `username=x-access-token\npassword=${token}\n`);
  for (const bad of [
    good.replace("github.com", "evil.example"),
    good.replace("github.com", "github.com.evil.example"),
    good.replace("https", "http"),
    good.replace("octo/fixture.git", "octo/other.git"),
    "protocol=https\nhost=github.com\n",
    "",
  ])
    assert.equal(ask(bad), "", bad);
  assert.equal(
    spawnSync("sh", ["-c", `${pushCredentialHelper.slice(1)} store`], {
      input: good,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        CAB_PUSH_TOKEN: token,
        CAB_PUSH_HOST: "github.com",
        CAB_PUSH_PATH: "octo/fixture.git",
      },
    }).stdout,
    "",
  );
});

test("the credential helper answers only for the configured host", () => {
  const ask = (host: string, input: string) =>
    spawnSync("sh", ["-c", `${pushCredentialHelper.slice(1)} get`], {
      input,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        CAB_PUSH_TOKEN: token,
        CAB_PUSH_HOST: host,
        CAB_PUSH_PATH: "group/repo.git",
      },
    }).stdout;
  const good = "protocol=https\nhost=gitlab.example.com\npath=group/repo.git\n";
  assert.equal(
    ask("gitlab.example.com", good),
    `username=x-access-token\npassword=${token}\n`,
  );
  for (const bad of [
    good.replace("gitlab.example.com", "github.com"),
    good.replace("gitlab.example.com", "gitlab.example.com.evil.example"),
    good.replace("https", "http"),
    good.replace("group/repo.git", "group/other.git"),
  ])
    assert.equal(ask("gitlab.example.com", bad), "", bad);
  // An unset host never matches an empty `host=` line.
  assert.equal(ask("", "protocol=https\nhost=\npath=group/repo.git\n"), "");
});

test("a push to a non-GitHub host targets that host", async (t) => {
  const repo = repository(t);
  const fake = shim(t);
  assert.equal(
    await pushTaskCommit({
      ...request(repo, fake.executable),
      host: "gitlab.example.com",
    }),
    "pushed",
  );
  const seen = fake.recorded();
  assert.equal(seen.env.CAB_PUSH_HOST, "gitlab.example.com");
  assert.deepEqual(seen.args.slice(-2), [
    "https://gitlab.example.com/octo/fixture.git",
    `${repo.sha}:refs/heads/cab/abcd1234-task`,
  ]);
});

test("a GitLab push uses the oauth2 username and a nested project path", async (t) => {
  const repo = repository(t);
  const fake = shim(t);
  assert.equal(
    await pushTaskCommit({
      ...request(repo, fake.executable),
      host: "gitlab.example.com",
      codeHost: "gitlab",
      nameWithOwner: "group/sub/app",
    }),
    "pushed",
  );
  const seen = fake.recorded();
  assert.equal(seen.env.CAB_PUSH_HOST, "gitlab.example.com");
  assert.equal(seen.env.CAB_PUSH_PATH, "group/sub/app.git");
  assert.equal(seen.env.CAB_PUSH_USERNAME, "oauth2");
  assert.deepEqual(seen.args.slice(-2), [
    "https://gitlab.example.com/group/sub/app.git",
    `${repo.sha}:refs/heads/cab/abcd1234-task`,
  ]);
  assert.equal(seen.args.join("\n").includes(token), false);
  assert.equal(seen.config.includes(token), false);
  assert.deepEqual(filesContaining(repo.root, token), []);
});

test("the credential helper sends the configured username and only to the exact GitLab path", () => {
  const ask = (path: string) =>
    spawnSync("sh", ["-c", `${pushCredentialHelper.slice(1)} get`], {
      input: `protocol=https\nhost=gitlab.example.com\npath=${path}\n`,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        CAB_PUSH_TOKEN: token,
        CAB_PUSH_HOST: "gitlab.example.com",
        CAB_PUSH_PATH: "group/sub/app.git",
        CAB_PUSH_USERNAME: "oauth2",
      },
    }).stdout;
  assert.equal(
    ask("group/sub/app.git"),
    `username=oauth2\npassword=${token}\n`,
  );
  assert.equal(ask("group/sub/other.git"), "");
  assert.equal(ask("group/sub/app/extra.git"), "");
});

test("a GitLab push rejects paths GitLab and Git would read differently", async (t) => {
  const repo = repository(t);
  const never = shim(t);
  for (const nameWithOwner of [
    "app",
    "group/../app",
    "group/./app",
    "group/app.git",
    "group//app",
    "group/app; rm",
  ])
    assert.equal(
      await pushTaskCommit({
        ...request(repo, never.executable),
        host: "gitlab.example.com",
        codeHost: "gitlab",
        nameWithOwner,
      }),
      "not-attempted",
      nameWithOwner,
    );
  // A self-managed host may be a single label, as repository links allow.
  assert.equal(
    await pushTaskCommit({
      ...request(repo, shim(t).executable),
      host: "gitlab",
      codeHost: "gitlab",
      nameWithOwner: "group/sub/app",
    }),
    "pushed",
  );
  // GitHub keeps its two-segment rule when no code host is given.
  assert.equal(
    await pushTaskCommit({
      ...request(repo, never.executable),
      nameWithOwner: "group/sub/app",
    }),
    "not-attempted",
  );
  assert.equal(existsSync(never.started), false);
});

test("a lease push names the lease commit and the refusal reports map to outcomes", async (t) => {
  const repo = repository(t);
  const lease = "1".repeat(40);
  const cases: Array<[string, number, string]> = [
    ["", 0, "pushed"],
    ["=\tx:y\t[up to date]\n", 0, "up-to-date"],
    ["!\tx:y\t[rejected] (non-fast-forward)\n", 1, "rejected-non-fast-forward"],
    ["!\tx:y\t[rejected] (fetch first)\n", 1, "rejected-non-fast-forward"],
    ["!\tx:y\t[rejected] (stale info)\n", 1, "rejected-lease"],
    [
      "!\tx:y\t[remote rejected] (protected branch hook declined)\n",
      1,
      "rejected-remote",
    ],
    ["", 128, "uncertain"],
  ];
  for (const [stdout, exit, expected] of cases) {
    const fake = shim(t, { stdout, exit });
    assert.equal(
      await pushTaskCommit({ ...request(repo, fake.executable), lease }),
      expected,
      stdout,
    );
    assert.ok(
      fake
        .recorded()
        .args.includes(
          `--force-with-lease=refs/heads/cab/abcd1234-task:${lease}`,
        ),
    );
  }
});

test("a cancelled push is uncertain and an invalid request never starts Git", async (t) => {
  const repo = repository(t);
  const sleeper = shim(t, { sleep: true });
  const controller = new AbortController();
  const pending = pushTaskCommit({
    ...request(repo, sleeper.executable),
    signal: controller.signal,
  });
  const deadline = Date.now() + 5000;
  while (!existsSync(sleeper.started) && Date.now() < deadline)
    await new Promise<void>((r) => setTimeout(r, 10));
  controller.abort();
  assert.equal(await pending, "uncertain");

  const never = shim(t);
  for (const bad of [
    { token: "" },
    { branch: "-x" },
    { branch: "a..b" },
    { nameWithOwner: "octo/fixture; rm" },
    { commitSha: "HEAD" },
    { lease: "main" },
    ...["GitHub.com", "github.com:443", "evil/x", "", "a..b"].map((host) => ({
      host,
    })),
  ])
    assert.equal(
      await pushTaskCommit({ ...request(repo, never.executable), ...bad }),
      "not-attempted",
    );
  assert.equal(existsSync(never.started), false);
  assert.equal(
    await pushTaskCommit({
      ...request(repo, never.executable),
      workspacePath: join(repo.root, "missing"),
    }),
    "not-attempted",
  );
});

test("every push carries an exact lease, and Git enforces it against a head that moved", (t) => {
  const root = mkdtempSync(join(tmpdir(), "cab-git-lease-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const remote = join(root, "remote");
  git(root, "init", "-q", "--bare", remote);
  const source = join(root, "source");
  mkdirSync(source);
  git(source, "init", "-q", "-b", "main");
  const commit = (name: string) => {
    writeFileSync(join(source, name), `${name}\n`);
    git(source, "add", ".");
    git(
      source,
      "-c",
      "user.name=T",
      "-c",
      "user.email=t@e.com",
      "commit",
      "-q",
      "-m",
      name,
    );
    return git(source, "rev-parse", "HEAD");
  };
  const a = commit("a"),
    b = commit("b"),
    c = commit("c");
  // The exact arguments pushTaskCommit builds, against a local remote.
  const push = (sha: string, lease: string | null) => {
    try {
      git(
        source,
        "push",
        "--porcelain",
        "--no-verify",
        `--force-with-lease=refs/heads/x:${lease ?? ""}`,
        remote,
        `${sha}:refs/heads/x`,
      );
      return "pushed";
    } catch (error) {
      return /stale info/.test(String((error as { stdout?: string }).stdout))
        ? "stale"
        : "other";
    }
  };
  const head = () => git(remote, "rev-parse", "refs/heads/x");
  // Creation expects absence: an outsider who created the branch first is not overwritten, even
  // by a commit that is a fast-forward of what they pushed.
  assert.equal(push(a, null), "pushed");
  git(remote, "update-ref", "-d", "refs/heads/x");
  git(source, "push", "-q", remote, `${a}:refs/heads/x`);
  assert.equal(push(b, null), "stale");
  assert.equal(head(), a);
  // An advance leased against the observed head rejects when the head moved to an ancestor of the
  // new commit; a plain fast-forward would have succeeded.
  git(source, "push", "-q", remote, `${b}:refs/heads/x`);
  assert.equal(push(c, a), "stale");
  assert.equal(head(), b);
  assert.equal(push(c, b), "pushed");
  assert.equal(head(), c);
});
