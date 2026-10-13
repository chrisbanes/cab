import assert from "node:assert/strict";
import { test } from "node:test";
import { ghEnvironment } from "../src/standalone/gh-credential.js";
import {
  envCredentialReference,
  sourceCredentialReference,
} from "../src/core/credential-reference.js";
import { githubConfigurationSchema } from "../src/core/github-source-contracts.js";
import {
  CredentialGitHubSourceReader,
  gitHubSourceCredentialStatus,
  resolveGitHubSourceCredential,
  sourceCredentialExplanation,
  type SourceCredentialReason,
} from "../src/standalone/github-source-credential.js";
import {
  createFakeGh,
  fakeGhToken,
  type FakeGhState,
} from "./fixtures/fake-gh.js";

const selection = {
  id: "S-1",
  kind: "repository" as const,
  repositoryId: "R_1",
  owner: "org",
  name: "repo",
};
const reference = {
  nodeId: "I_1",
  repositoryId: "R_1",
  repositoryName: "org/repo",
  number: 1,
};
const issue = {
  node_id: "I_1",
  number: 1,
  title: "Issue",
  body: "Outcome",
  state: "open",
  repository_url: "https://api.github.com/repos/org/repo",
  labels: [{ name: "ready" }],
};

test("source references accept only env or exact github.com gh, without widening env consumers", () => {
  for (const value of ["env:SOURCE_TOKEN", "gh:github.com"])
    assert.equal(sourceCredentialReference.safeParse(value).success, true);
  for (const value of [
    "gh:example.com",
    "gh:GITHUB.COM",
    "gh:github.com/",
    "env:lower",
    "SOURCE_TOKEN",
    "file:/tmp/token",
    "",
  ])
    assert.equal(
      sourceCredentialReference.safeParse(value).success,
      false,
      value,
    );
  assert.equal(
    envCredentialReference.safeParse("gh:github.com").success,
    false,
  );
  assert.equal(
    githubConfigurationSchema.shape.credentialRef.safeParse(null).success,
    true,
  );
  assert.equal(
    githubConfigurationSchema.shape.credentialRef.safeParse("gh:github.com")
      .success,
    true,
  );
});

test("each public gh source read gets a fresh token, including nested blocker status reads", async (t) => {
  const gh = createFakeGh();
  t.after(() => gh.close());
  const authorizations: string[] = [];
  const reader = new CredentialGitHubSourceReader("gh:github.com", {
    gh: { executable: gh.executable },
    fetcher: async (input, init) => {
      authorizations.push(
        new Headers(init?.headers).get("authorization") ?? "",
      );
      const url = String(input);
      if (url.endsWith("/repos/org/repo"))
        return Response.json({ node_id: "R_1", full_name: "org/repo" });
      if (url.endsWith("/issues/1")) return Response.json(issue);
      return Response.json([issue]);
    },
  });
  for (const [token, read] of [
    ["gho_source-A", () => reader.readSelection(selection)],
    ["gho_source-B", () => reader.readBlockers(reference)],
    ["gho_source-C", () => reader.readIssueStatus(reference)],
  ] as const) {
    gh.setToken(token);
    const before = authorizations.length;
    const result = await read();
    if ("complete" in result) assert.equal(result.complete, true);
    else assert.equal(result.status, "open");
    const headers = authorizations.slice(before);
    assert.ok(headers.length > 0);
    assert.ok(headers.every((value) => value === `Bearer ${token}`));
  }
  // Exactly one status/token pair per public read, including the blocker read's nested status.
  assert.equal(gh.environments().length, 6);
  gh.set("not-signed-in");
  assert.deepEqual(await reader.readIssueStatus(reference), {
    status: "unknown",
    reason: "gh-not-signed-in",
  });
});

test("every resolution failure is safe, incomplete and makes no provider request", async (t) => {
  const gh = createFakeGh();
  t.after(() => gh.close());
  const cases: [FakeGhState | "missing", SourceCredentialReason][] = [
    ["missing", "gh-not-installed"],
    ["not-signed-in", "gh-not-signed-in"],
    ["unreadable", "gh-unreadable"],
    ["invalid-token", "gh-unreadable"],
    ["hang", "gh-unreadable"],
  ];
  for (const [state, reason] of cases) {
    if (state !== "missing") gh.set(state);
    const reader = new CredentialGitHubSourceReader("gh:github.com", {
      gh: {
        executable: state === "missing" ? gh.missing : gh.executable,
        timeoutMs: state === "hang" ? 150 : 5000,
      },
      fetcher: async () => {
        throw new Error("Provider must not be called");
      },
    });
    const results = [
      await reader.readSelection(selection),
      await reader.readBlockers(reference),
      await reader.readIssueStatus(reference),
    ];
    assert.deepEqual(results, [
      { complete: false, issues: [], reason },
      { complete: false, blockers: [], reason },
      { status: "unknown", reason },
    ]);
    const text = JSON.stringify(results) + sourceCredentialExplanation(reason);
    assert.equal(text.includes(fakeGhToken), false);
    assert.equal(text.includes("keyring failed"), false);
    assert.match(sourceCredentialExplanation(reason), /GitHub source settings/);
  }
});

test("invalid, missing and changed env source references never fall back to a detected login", async (t) => {
  const gh = createFakeGh();
  t.after(() => gh.close());
  const environment = { SOURCE: "source-A", DISCOVERY: "discovery-canary" };
  const options = { environment, gh: { executable: gh.executable } };
  assert.deepEqual(await resolveGitHubSourceCredential(null, options), {
    reason: "missing-credential",
  });
  assert.deepEqual(
    await resolveGitHubSourceCredential("gh:other.host", options),
    { reason: "invalid-credential-reference" },
  );
  assert.deepEqual(await resolveGitHubSourceCredential("env:ABSENT", options), {
    reason: "missing-credential",
  });
  assert.deepEqual(await resolveGitHubSourceCredential("env:SOURCE", options), {
    token: "source-A",
  });
  environment.SOURCE = "source-B";
  assert.deepEqual(await resolveGitHubSourceCredential("env:SOURCE", options), {
    token: "source-B",
  });
  assert.equal(gh.environments().length, 0);
  const status = await gitHubSourceCredentialStatus(null, options);
  assert.deepEqual(status, {
    configured: false,
    source: null,
    usable: false,
    reason: "missing-credential",
    gh: { state: "signed-in", login: "octo" },
  });
  assert.equal(JSON.stringify(status).includes(fakeGhToken), false);
  gh.set("invalid-token");
  const unusable = await gitHubSourceCredentialStatus("gh:github.com", options);
  assert.equal(unusable.gh.state, "signed-in");
  assert.equal(unusable.usable, false);
  assert.equal(unusable.reason, "gh-unreadable");
});

test("invalid and missing source references leave every snapshot unknown before any read", async () => {
  for (const ref of [null, "gh:other.host", "env:ABSENT"]) {
    const reader = new CredentialGitHubSourceReader(ref, {
      environment: {},
      reader: () => {
        throw new Error("must not resolve a delegate");
      },
    });
    assert.equal((await reader.readSelection(selection)).complete, false);
    assert.equal((await reader.readBlockers(reference)).complete, false);
    assert.equal((await reader.readIssueStatus(reference)).status, "unknown");
  }
});

test("provider failure remains incomplete with credentials excluded from the failure", async (t) => {
  const gh = createFakeGh();
  t.after(() => gh.close());
  const reader = new CredentialGitHubSourceReader("gh:github.com", {
    gh: { executable: gh.executable },
    fetcher: async () => {
      throw new Error(`private stderr ${fakeGhToken}`);
    },
  });
  const snapshots = [
    await reader.readSelection(selection),
    await reader.readBlockers(reference),
    await reader.readIssueStatus(reference),
  ];
  assert.equal(JSON.stringify(snapshots).includes(fakeGhToken), false);
  assert.equal((snapshots[0] as { complete: boolean }).complete, false);
  assert.equal((snapshots[1] as { complete: boolean }).complete, false);
  assert.equal((snapshots[2] as { status: string }).status, "unknown");
});

test("a cached reader evaluates source gh environment freshly for rotation and Clear", async (t) => {
  const gh = createFakeGh();
  t.after(() => gh.close());
  let current = "chosen-A";
  let discovery: string | null = "env:DISCOVERY";
  const received: string[] = [];
  const domain = {
    claudeTokenReference: () => null,
    projects: () => [],
    deliveryCredentialReference: () => null,
    discoveryCredentialReference: () => discovery,
  };
  let factories = 0;
  const options = {
    gh: () => {
      factories++;
      return {
        executable: gh.executable,
        environment: ghEnvironment(domain, {
          reference: "gh:github.com",
          environment: {
            GH_TOKEN: current,
            CHOSEN_ALIAS: current,
            DISCOVERY: "other-login",
          },
        }),
      };
    },
    reader: (token: string) => ({
      async readSelection() {
        received.push(token);
        return { complete: true as const, issues: [], reason: null };
      },
      async readBlockers() {
        received.push(token);
        return { complete: true, blockers: [], reason: null };
      },
      async readIssueStatus() {
        received.push(token);
        return { status: "open" as const };
      },
    }),
  };
  const reader = new CredentialGitHubSourceReader("gh:github.com", options);
  gh.setToken("resolved-A");
  await reader.readSelection(selection);
  current = "chosen-B";
  discovery = null;
  gh.setToken("resolved-B");
  await reader.readBlockers(reference);
  current = "chosen-C";
  gh.setToken("resolved-C");
  await reader.readIssueStatus(reference);
  assert.deepEqual(received, ["resolved-A", "resolved-B", "resolved-C"]);
  assert.equal(factories, 3);
  const envs = gh.environments();
  assert.deepEqual(
    envs.map((e) => e.GH_TOKEN),
    ["chosen-A", "chosen-A", "chosen-B", "chosen-B", "chosen-C", "chosen-C"],
  );
  assert.ok(envs.every((e) => e.CHOSEN_ALIAS === undefined));
  await gitHubSourceCredentialStatus("gh:github.com", options);
  assert.equal(factories, 4, "one fresh options snapshot per status operation");
  const cleared = new CredentialGitHubSourceReader(null, options);
  const before = gh.environments().length;
  assert.equal((await cleared.readSelection(selection)).complete, false);
  assert.equal(gh.environments().length, before);
});

test("a failed gh options factory never invokes host gh and preserves independent env/null results", async (t) => {
  const gh = createFakeGh(),
    previousPath = process.env.PATH;
  process.env.PATH = `${gh.executable.slice(0, gh.executable.lastIndexOf("/"))}:${previousPath ?? ""}`;
  t.after(() => {
    gh.close();
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  });
  let factories = 0,
    providers = 0;
  const options = {
    gh: () => {
      factories++;
      throw new Error("PRIVATE environment lookup failure");
    },
    environment: { SOURCE: "env-own-value" },
  };
  const reader = new CredentialGitHubSourceReader("gh:github.com", {
    ...options,
    reader: () => {
      providers++;
      throw new Error("provider must not run");
    },
  });
  assert.equal((await reader.readSelection(selection)).reason, "gh-unreadable");
  assert.equal((await reader.readBlockers(reference)).reason, "gh-unreadable");
  assert.equal(
    (await reader.readIssueStatus(reference)).reason,
    "gh-unreadable",
  );
  assert.equal(factories, 3);
  for (const [ref, usable, reason] of [
    ["gh:github.com", false, "gh-unreadable"],
    ["env:SOURCE", true, null],
    ["env:ABSENT", false, "missing-credential"],
    [null, false, "missing-credential"],
  ] as const) {
    const before: number = factories;
    const status = await gitHubSourceCredentialStatus(ref, options);
    assert.equal(status.usable, usable);
    assert.equal(status.reason, reason);
    assert.deepEqual(status.gh, { state: "unreadable" });
    assert.ok(!JSON.stringify(status).includes("PRIVATE"));
    assert.ok(!JSON.stringify(status).includes("env-own-value"));
    assert.equal(factories, before + 1, "one fresh paired capture, no retry");
  }
  assert.equal(providers, 0);
  assert.equal(
    gh.environments().length,
    0,
    "no fallback to available host-path fake gh",
  );
  assert.deepEqual(await resolveGitHubSourceCredential("env:SOURCE", options), {
    token: "env-own-value",
  });
});

import { SourceRateLimitPauses } from "../src/standalone/github-source-credential.js";
import { GhLoginScope } from "../src/standalone/gh-credential.js";

test("resolved-token pauses cover all public reads, rotate immediately and prioritize resolver failure", async (t) => {
  const fake = createFakeGh();
  t.after(() => fake.close());
  for (const kind of ["selection", "blockers", "status"] as const) {
    let calls = 0;
    let reset = Date.now() + 60_000;
    const base = new CredentialGitHubSourceReader("gh:github.com", {
      gh: { executable: fake.executable },
      reader: () => ({
        async readSelection() {
          calls++;
          return {
            complete: false,
            issues: [],
            reason: "rate-limited",
            resumeAt: reset,
          };
        },
        async readBlockers() {
          calls++;
          return {
            complete: false,
            blockers: [],
            reason: "rate-limited",
            resumeAt: reset,
          };
        },
        async readIssueStatus() {
          calls++;
          return { status: "unknown", reason: "rate-limited", resumeAt: reset };
        },
      }),
    });
    const scope = new SourceRateLimitPauses();
    const read = (reader: CredentialGitHubSourceReader) =>
      kind === "selection"
        ? reader.readSelection(selection)
        : kind === "blockers"
          ? reader.readBlockers(reference)
          : reader.readIssueStatus(reference);
    fake.set("signed-in");
    fake.setToken(`token-A-${kind}`);
    assert.equal(
      (await read(base.withRateLimitPauses(scope))).reason,
      "rate-limited",
    );
    await read(base.withRateLimitPauses(scope));
    assert.equal(calls, 1, "new clones share the same token pause");
    fake.set("not-signed-in");
    assert.equal(
      (await read(base.withRateLimitPauses(scope))).reason,
      "gh-not-signed-in",
    );
    fake.set("signed-in");
    fake.setToken(`token-B-${kind}`);
    reset = Date.now() - 1;
    await read(base.withRateLimitPauses(scope));
    await read(base.withRateLimitPauses(scope));
    assert.equal(
      calls,
      3,
      "new token bypasses old pause and expired reset allows next read",
    );
    fake.setToken(`token-A-${kind}`);
    await read(base);
    assert.equal(
      calls,
      4,
      "unscoped operator previews do not inherit sync pauses",
    );
    await read(base.withRateLimitPauses(scope));
    assert.equal(calls, 4, "preview does not clear sync pause");
  }
});

test("an old-token provider result cannot pause a replacement during an in-flight env read", async () => {
  const environment = { SOURCE: "token-A" };
  const scope = new SourceRateLimitPauses();
  let finish!: () => void;
  let started!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const held = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const tokens: string[] = [];
  const reader = new CredentialGitHubSourceReader("env:SOURCE", {
    environment,
    reader: (token) => ({
      async readSelection() {
        tokens.push(token);
        if (token === "token-A") {
          started();
          await held;
          return {
            complete: false,
            issues: [],
            reason: "rate-limited",
            resumeAt: Date.now() + 60_000,
          };
        }
        return { complete: true, issues: [], reason: null };
      },
      async readBlockers() {
        return { complete: true, blockers: [], reason: null };
      },
      async readIssueStatus() {
        return { status: "open" };
      },
    }),
  }).withRateLimitPauses(scope);
  const old = reader.readSelection(selection);
  await entered;
  environment.SOURCE = "token-B";
  finish();
  await old;
  assert.equal((await reader.readSelection(selection)).complete, true);
  environment.SOURCE = "token-A";
  assert.equal((await reader.readSelection(selection)).reason, "rate-limited");
  environment.SOURCE = "";
  assert.equal(
    (await reader.readSelection(selection)).reason,
    "missing-credential",
  );
  assert.deepEqual(tokens, ["token-A", "token-B"]);
});

test("status shares one equivalent login probe but fresh tokens, isolating snapshots and new scopes", async (t) => {
  const fake = createFakeGh();
  t.after(() => fake.close());
  const environment = { GH_TOKEN: "selected-current" };
  const scope = new GhLoginScope();
  const options = { gh: () => ({ executable: fake.executable, environment }) };
  const statuses = await Promise.all(
    Array.from({ length: 8 }, () =>
      gitHubSourceCredentialStatus("gh:github.com", options, scope),
    ),
  );
  assert.ok(statuses.every((status) => status.usable));
  assert.equal(
    fake.environments().length,
    9,
    "one detector and eight fresh tokens",
  );
  await gitHubSourceCredentialStatus(
    null,
    { gh: { executable: fake.executable, environment: {} } },
    scope,
  );
  assert.equal(
    fake.environments().length,
    10,
    "stripped null context has its own detector",
  );
  fake.set("not-signed-in");
  assert.equal(
    (
      await gitHubSourceCredentialStatus(
        "gh:github.com",
        options,
        new GhLoginScope(),
      )
    ).reason,
    "gh-not-signed-in",
  );
  assert.equal(fake.environments().length, 11);
  environment.GH_TOKEN = "replacement";
  fake.set("signed-in");
  assert.equal(
    (await gitHubSourceCredentialStatus("gh:github.com", options, scope))
      .usable,
    true,
  );
  assert.equal(
    fake.environments().length,
    13,
    "changed environment cannot reuse a login",
  );
  const before = fake.environments().length;
  const throwing = {
    gh: () => {
      throw new Error("private factory failure");
    },
    environment: { SOURCE: "available" },
  };
  assert.equal(
    (await gitHubSourceCredentialStatus("gh:github.com", throwing, scope))
      .reason,
    "gh-unreadable",
  );
  assert.equal(
    (await gitHubSourceCredentialStatus("env:SOURCE", throwing, scope)).usable,
    true,
  );
  assert.equal(
    (await gitHubSourceCredentialStatus(null, throwing, scope)).reason,
    "missing-credential",
  );
  assert.equal(fake.environments().length, before);
});
