import assert from "node:assert/strict";
import { test } from "node:test";
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
