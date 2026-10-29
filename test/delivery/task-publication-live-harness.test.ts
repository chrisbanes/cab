import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  harnessDocuments,
  issueTitle,
  projectTitle,
  readyLabel,
  TaskPublicationGuard,
  taskPublicationManifestSchema,
} from "./github-qualification/task-publication-fixture.js";
import { runTaskPublicationJourney } from "./github-qualification/task-publication-journey.js";
import {
  FakeGitHub,
  publicationProject,
} from "../fixtures/task-publication.js";
import { githubFake } from "../fixtures/delivery-fixture.js";

const fullName = "chrisbanes/ensemble-s07a-fixture";
const repositoryNode = "R1";
const token = "ghp_live_task_publication_secret_0123456789";
const actions = ["issue.create", "project.item.add", "project.field"];

const manifest = () => ({
  version: 1,
  provider: "github.com",
  account: { nodeId: "U_owner", login: "chrisbanes" },
  repository: {
    nodeId: repositoryNode,
    fullName,
    private: false,
    defaultBranch: "qualification",
  },
  credential: "gh-cli",
  actions,
  runtimeTurnLimit: 0,
  maxAttempts: 3,
  maxIssues: 6,
});
function files(
  change: Record<string, unknown> = {},
  expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString(),
) {
  const raw = JSON.stringify({ ...manifest(), ...change });
  const grant = {
    version: 1,
    manifestSha256: createHash("sha256").update(raw).digest("hex"),
    accountNodeId: "U_owner",
    repositoryNodeId: repositoryNode,
    repositoryVisibility: "public",
    credential: "gh-cli",
    actions,
    runtimeTurnLimit: 0,
    expiresAt,
    cleanup: { deleteScratchProjects: true, closeFixtureIssues: true },
  };
  return { raw, grant };
}
const api = (path: string) => `https://api.github.com${path}`;
const run = "aaaaaaaa";

test("the grant must match the manifest, be unexpired, last at most a day and stay inside the allowances", () => {
  const f = files();
  assert.throws(() => new TaskPublicationGuard(f.raw, undefined), /grant/);
  assert.throws(
    () => new TaskPublicationGuard(`${f.raw} `, f.grant),
    /manifest/,
  );
  assert.throws(
    () =>
      new TaskPublicationGuard(f.raw, {
        ...f.grant,
        expiresAt: "2000-01-01T00:00:00Z",
      }),
    /expired/,
  );
  assert.throws(
    () =>
      new TaskPublicationGuard(
        f.raw,
        files({}, new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString())
          .grant,
      ),
    /expired/,
  );
  for (const change of [
    {
      repository: { ...manifest().repository, fullName: "chrisbanes/cab" },
    },
    { credential: "env:S07A_GITHUB_TOKEN" },
    { actions: ["issue.create", "project.item.add"] },
    { actions: [...actions, "pr.merge"] },
    { actions: ["project.field", "issue.create", "project.item.add"] },
    { runtimeTurnLimit: 1 },
    { maxAttempts: 2 },
    { maxAttempts: 4 },
    { maxIssues: 4 },
    { maxIssues: 7 },
  ])
    assert.equal(
      taskPublicationManifestSchema.safeParse({ ...manifest(), ...change })
        .success,
      false,
      JSON.stringify(change),
    );
  const g = new TaskPublicationGuard(f.raw, f.grant);
  assert.throws(() => g.begin(run, 4), /allowance/);
  assert.throws(() => g.begin(run, 0), /allowance/);
  assert.throws(() => g.begin("not-a-run", 1), /run id/);
  g.begin(run, 3);
});

test("only the Project this run created may be used: never Project 6, never one linked to the product repository", () => {
  const f = files();
  const g = () => {
    const guard = new TaskPublicationGuard(f.raw, f.grant);
    guard.begin(run, 1);
    return guard;
  };
  assert.throws(
    () =>
      g().recordProject({ nodeId: "PVT_6", number: 6, linkedRepositories: [] }),
    /Project 6/,
  );
  for (const linkedRepositories of [
    ["chrisbanes/cab"],
    ["Chrisbanes/cab"],
    [fullName, "chrisbanes/cab"],
    ["chrisbanes/other"],
  ])
    assert.throws(
      () =>
        g().recordProject({ nodeId: "PVT_9", number: 9, linkedRepositories }),
      /ungranted repository/,
      linkedRepositories.join(),
    );
  const guard = g();
  guard.recordProject({
    nodeId: "PVT_9",
    number: 9,
    linkedRepositories: [fullName],
  });
  assert.throws(() =>
    guard.recordProject({
      nodeId: "PVT_10",
      number: 10,
      linkedRepositories: [],
    }),
  );
});

test("the guard allows only the product's requests on the recorded resources and exact gh commands", () => {
  const f = files();
  const g = new TaskPublicationGuard(f.raw, f.grant);
  assert.throws(() => g.assertRequest(api("/user")), /no attempt/);
  g.begin(run, 1);
  const post = (query: string, variables: Record<string, unknown> = {}) =>
    [
      api("/graphql"),
      { method: "POST", body: JSON.stringify({ query, variables }) },
    ] as const;
  const create = (title: string, labels: string[]) =>
    [
      api(`/repos/${fullName}/issues`),
      { method: "POST", body: JSON.stringify({ title, body: "b", labels }) },
    ] as const;
  // Nothing but the title-bound creation is allowed before a Project exists.
  assert.throws(() =>
    g.assertGh(["project", "delete", "6", "--owner", "chrisbanes"]),
  );
  assert.throws(() =>
    g.assertGh([
      "project",
      "create",
      "--owner",
      "chrisbanes",
      "--title",
      "mine",
      "--format",
      "json",
    ]),
  );
  g.assertGh([
    "project",
    "create",
    "--owner",
    "chrisbanes",
    "--title",
    projectTitle(run),
    "--format",
    "json",
  ]);
  g.recordProject({
    nodeId: "PVT_9",
    number: 9,
    linkedRepositories: [fullName],
  });
  g.recordField("F_1", ["O_1", "O_2"]);
  // Requests: reads of the fixture, the title- and label-bound create, and the product's Project writes.
  g.assertRequest(api("/user"));
  g.assertRequest(api(`/repos/${fullName}`));
  g.assertRequest(api(`/repos/${fullName}/issues?creator=bot&state=all`));
  g.assertRequest(...create(`${issueTitle(run)} a`, [readyLabel(run)]));
  g.assertRequest(
    ...post("query CabDeliveryRepository($id:ID!)", {
      id: repositoryNode,
    }),
  );
  g.recordIssue(7, "I_7");
  g.recordItem("ITEM_1");
  g.assertRequest(
    ...post("mutation CabDeliveryItemAdd", {
      project: "PVT_9",
      content: "I_7",
    }),
  );
  g.assertRequest(
    ...post("mutation CabDeliveryProject", {
      project: "PVT_9",
      item: "ITEM_1",
      field: "F_1",
      option: "O_2",
    }),
  );
  for (const [input, init] of [
    [api("/repos/chrisbanes/cab"), {}],
    [api("/repos/chrisbanes/cab/issues"), { method: "POST", body: "{}" }],
    [
      api(`/repos/${fullName}/issues/7/comments`),
      { method: "POST", body: "{}" },
    ],
    [api(`/repos/${fullName}`), { method: "DELETE" }],
    [api(`/repos/${fullName}/pulls`), { method: "POST", body: "{}" }],
    [api("/orgs/other"), {}],
    ["https://example.com/user", {}],
    create("Another title", [readyLabel(run)]),
    create(`${issueTitle(run)} b`, ["bug"]),
    post("mutation CabDeliveryProject", {
      project: "PVT_6",
      item: "ITEM_1",
      field: "F_1",
      option: "O_2",
    }),
    post("mutation CabDeliveryProject", {
      project: "PVT_9",
      item: "ITEM_1",
      field: "F_1",
      option: "O_other",
    }),
    post("mutation CabDeliveryItemAdd", {
      project: "PVT_9",
      content: "I_other",
    }),
    post("mutation CabDeliveryItemAdd", {
      project: "PVT_6",
      content: "I_7",
    }),
    post(
      'mutation { deleteProjectV2(input:{projectId:"PVT_9"}) { clientMutationId } }',
      {},
    ),
  ] as const)
    assert.throws(() => g.assertRequest(input, init), Error, String(input));
  // The issue allowance is two per attempt.
  g.assertRequest(...create(`${issueTitle(run)} b`, []));
  assert.throws(
    () => g.assertRequest(...create(`${issueTitle(run)} c`, [])),
    /allowance is spent/,
  );
  g.recordIssue(8, "I_8");
  const ok = [
    ["api", "-i", "/user"],
    ["project", "link", "9", "--owner", "chrisbanes", "--repo", fullName],
    ["project", "item-list", "9", "--owner", "chrisbanes", "--format", "json"],
    ["project", "delete", "9", "--owner", "chrisbanes"],
    ["issue", "close", "7", "--repo", fullName],
    ["issue", "close", "8", "--repo", fullName],
    ["api", `repos/${fullName}/issues/7`],
    [
      "api",
      "-X",
      "POST",
      `repos/${fullName}/labels`,
      "-f",
      `name=${readyLabel(run)}`,
      "-f",
      "color=ededed",
    ],
    ["api", "-X", "DELETE", `repos/${fullName}/labels/${readyLabel(run)}`],
    [
      "api",
      "graphql",
      "-f",
      `query=${harnessDocuments.projectExists}`,
      "-f",
      "project=PVT_9",
    ],
    [
      "api",
      "graphql",
      "-f",
      `query=${harnessDocuments.setStatusOptions}`,
      "-f",
      "field=F_1",
    ],
  ];
  for (const args of ok) g.assertGh(args);
  for (const args of [
    ["project", "delete", "6", "--owner", "chrisbanes"],
    [
      "project",
      "link",
      "9",
      "--owner",
      "chrisbanes",
      "--repo",
      "chrisbanes/cab",
    ],
    ["issue", "close", "9", "--repo", fullName],
    ["issue", "close", "7", "--repo", "chrisbanes/cab"],
    ["issue", "create", "--repo", fullName, "--title", "x", "--body", "y"],
    ["api", `repos/${fullName}/issues/9`],
    ["api", "-X", "DELETE", `repos/${fullName}/labels/bug`],
    ["api", "-X", "DELETE", `repos/chrisbanes/cab/labels/${readyLabel(run)}`],
    ["repo", "delete", fullName],
    [
      "api",
      "graphql",
      "-f",
      `query=${harnessDocuments.projectExists}`,
      "-f",
      "project=PVT_6",
    ],
    ["api", "graphql", "-f", "query=mutation{x}", "-f", "project=PVT_9"],
  ])
    assert.throws(() => g.assertGh(args), /not granted/, args.join(" "));
  // A label may only be deleted after the run created it.
  const fresh = new TaskPublicationGuard(f.raw, f.grant);
  fresh.begin(run, 1);
  assert.throws(
    () =>
      fresh.assertGh([
        "api",
        "-X",
        "DELETE",
        `repos/${fullName}/labels/${readyLabel(run)}`,
      ]),
    /not granted/,
  );
});

/** A fake `gh` over the fake GitHub: one scratch Project, its Status field, and the issues the product made. */
function fakeGh(github: FakeGitHub, options: { linkFails?: boolean } = {}) {
  const state = {
    projectDeleted: false,
    projectCreated: false,
    labels: new Set<string>(),
  };
  const gh = (args: string[]): string => {
    const [a, b] = args;
    if (a === "api" && b === "-i")
      return "HTTP/2.0 200 OK\nX-Oauth-Scopes: project, repo\n\n{}";
    if (a === "project" && b === "create") {
      state.projectCreated = true;
      return JSON.stringify({
        id: publicationProject.projectNodeId,
        number: 41,
      });
    }
    if (a === "project" && b === "link") {
      if (options.linkFails) throw new Error("link refused");
      return "";
    }
    if (a === "project" && b === "field-list")
      return JSON.stringify({
        fields: [{ id: publicationProject.fieldNodeId, name: "Status" }],
      });
    if (a === "project" && b === "item-list")
      return JSON.stringify({
        items: [...github.issues.values()]
          .filter((i) => i.items.has(publicationProject.projectNodeId))
          .map((i) => ({
            id: i.items.get(publicationProject.projectNodeId),
            status:
              i.fields.get(
                `${publicationProject.projectNodeId}/${publicationProject.fieldNodeId}`,
              ) === publicationProject.ready
                ? "Ready"
                : null,
            content: { number: i.number },
          })),
      });
    if (a === "project" && b === "delete") {
      state.projectDeleted = true;
      return "";
    }
    if (a === "issue" && b === "close") {
      const issue = github.issues.get(Number(args[2]));
      if (issue) issue.state = "closed";
      return "";
    }
    if (a === "api" && args[1] === "-X" && args[2] === "POST") {
      state.labels.add(String(args[5]).slice("name=".length));
      return "{}";
    }
    if (a === "api" && args[1] === "-X" && args[2] === "DELETE") {
      state.labels.delete(String(args[3]).split("/labels/")[1] ?? "");
      return "";
    }
    if (a === "api" && b?.startsWith("repos/")) {
      const issue = github.issues.get(Number(b.split("/issues/")[1]));
      if (!issue) throw new Error("not found");
      return JSON.stringify({
        number: issue.number,
        state: issue.state,
        title: issue.title,
        body: issue.body,
        labels: issue.labels.map((name) => ({ name })),
      });
    }
    if (a === "api" && b === "graphql") {
      const query = args[3] ?? "";
      if (query.includes(harnessDocuments.projectLinks))
        return JSON.stringify({
          data: {
            node: {
              number: 41,
              repositories: { nodes: [{ nameWithOwner: fullName }] },
            },
          },
        });
      if (query.includes("updateProjectV2Field"))
        return JSON.stringify({
          data: {
            updateProjectV2Field: {
              projectV2Field: {
                id: publicationProject.fieldNodeId,
                options: [
                  { id: "O_todo", name: "Todo" },
                  { id: publicationProject.ready, name: "Ready" },
                ],
              },
            },
          },
        });
      return JSON.stringify({
        data: {
          node: state.projectDeleted
            ? null
            : { id: publicationProject.projectNodeId },
        },
      });
    }
    throw new Error(`unexpected gh ${args.join(" ")}`);
  };
  return { gh, state };
}

/** The one request the journey makes itself: the fixture's identity. */
const fixtureFetch = (privateRepo = false): typeof fetch =>
  (async (input) => {
    const url = new URL(String(input));
    if (url.pathname === `/repos/${fullName}`)
      return Response.json({ node_id: repositoryNode, private: privateRepo });
    throw new Error(`unexpected request ${url.pathname}`);
  }) as typeof fetch;

test("a run publishes two Ready tasks through the real service, matches them on one sync, reads each back and cleans up", async () => {
  const f = files();
  const github = new FakeGitHub();
  const fake = fakeGh(github);
  const guard = new TaskPublicationGuard(f.raw, f.grant);
  const evidence = await runTaskPublicationJourney({
    guard,
    token,
    attempt: 1,
    gh: fake.gh,
    fetcher: fixtureFetch(),
    providerFactories: { github: () => github.provider() },
    issueTrackerFactories: { github: () => github.provider() },
    readerFactory: github.readerFactory(),
    ghRetryMs: 0,
    readRetryMs: 0,
  });
  assert.equal(evidence.failure, undefined, JSON.stringify(evidence));
  assert.equal(evidence.qualification, "passed");
  assert.equal(evidence.cleanup, "verified");
  assert.equal(evidence.turns, 0);
  assert.equal(evidence.duplicateImports, 0);
  assert.equal(evidence.credentialExposures, 0);
  assert.deepEqual(evidence.deletedProject, {
    nodeId: publicationProject.projectNodeId,
    number: 41,
    deleted: true,
  });
  const publications = evidence.publications as Array<{
    target: string;
    state: string;
    steps: { kind: string; state: string }[];
  }>;
  assert.deepEqual(
    publications.map((p) => [p.target, p.state]),
    [
      ["project", "converted"],
      ["repo", "converted"],
    ],
  );
  assert.deepEqual(
    publications[0]?.steps.map((s) => s.kind),
    ["issue.create", "project.item.add", "project.field"],
  );
  assert.deepEqual(
    publications[1]?.steps.map((s) => s.kind),
    ["issue.create"],
  );
  // The label is created before the first publication and removed with the rest.
  assert.equal(fake.state.labels.size, 0);
  assert.equal(fake.state.projectDeleted, true);
  assert.ok([...github.issues.values()].every((i) => i.state === "closed"));
  assert.equal(github.posts, 2);
  assert.equal(JSON.stringify(evidence).includes(token), false);
});

test("a run that fails after creating the Project still deletes it and proves the cleanup", async () => {
  const f = files();
  const github = new FakeGitHub();
  const fake = fakeGh(github, { linkFails: true });
  const evidence = await runTaskPublicationJourney({
    guard: new TaskPublicationGuard(f.raw, f.grant),
    token,
    attempt: 1,
    gh: fake.gh,
    fetcher: fixtureFetch(),
    providerFactories: { github: () => github.provider() },
    issueTrackerFactories: { github: () => github.provider() },
    readerFactory: github.readerFactory(),
    ghRetryMs: 0,
    readRetryMs: 0,
  });
  assert.equal(evidence.qualification, "failed");
  assert.match(String(evidence.failure), /link refused/);
  assert.equal(evidence.cleanup, "verified");
  assert.equal(fake.state.projectDeleted, true);
  assert.equal(github.posts, 0);
});

test("a login without the project scope stops before anything is created", async () => {
  const f = files();
  const github = new FakeGitHub();
  const fake = fakeGh(github);
  const evidence = await runTaskPublicationJourney({
    guard: new TaskPublicationGuard(f.raw, f.grant),
    token,
    attempt: 1,
    gh: (args) =>
      args[1] === "-i"
        ? "HTTP/2.0 200 OK\nX-Oauth-Scopes: repo\n\n{}"
        : fake.gh(args),
    fetcher: fixtureFetch(),
    providerFactories: { github: () => github.provider() },
    issueTrackerFactories: { github: () => github.provider() },
    readerFactory: github.readerFactory(),
  });
  assert.equal(evidence.qualification, "failed");
  assert.match(String(evidence.failure), /project scope/);
  assert.equal(fake.state.projectCreated, false);
  assert.equal(evidence.cleanup, "verified");
});

test("a fixture whose visibility differs from the grant stops before anything is created", async () => {
  const f = files();
  const github = new FakeGitHub();
  const fake = fakeGh(github);
  const evidence = await runTaskPublicationJourney({
    guard: new TaskPublicationGuard(f.raw, f.grant),
    token,
    attempt: 1,
    gh: fake.gh,
    fetcher: fixtureFetch(true),
    providerFactories: { github: () => github.provider() },
    issueTrackerFactories: { github: () => github.provider() },
    readerFactory: github.readerFactory(),
  });
  assert.equal(evidence.qualification, "failed");
  assert.match(String(evidence.failure), /visibility/);
  assert.equal(fake.state.projectCreated, false);
});

test("a create GitHub's list does not show at first is proved by a later refresh, never sent again", async () => {
  const f = files();
  const github = new FakeGitHub();
  github.createMode = "lost";
  github.readbackVisible = false;
  const fake = fakeGh(github);
  const provider = github.provider();
  const evidence = await runTaskPublicationJourney({
    guard: new TaskPublicationGuard(f.raw, f.grant),
    token,
    attempt: 1,
    gh: fake.gh,
    fetcher: fixtureFetch(),
    // The list catches up by the first read-back.
    ...githubFake(() => ({
      ...provider,
      inspectAction: async (record) => {
        for (const issue of github.issues.values()) issue.hidden = false;
        return provider.inspectAction(record);
      },
    })),
    readerFactory: github.readerFactory(),
    ghRetryMs: 0,
    readRetryMs: 0,
  });
  assert.equal(evidence.failure, undefined, JSON.stringify(evidence));
  assert.equal(evidence.qualification, "passed");
  const publications = evidence.publications as Array<{
    immediate: string;
    refreshPasses: number;
    state: string;
  }>;
  assert.deepEqual(
    publications.map((p) => [p.immediate, p.refreshPasses, p.state]),
    [
      ["sending", 1, "converted"],
      ["sending", 1, "converted"],
    ],
  );
  assert.equal(github.posts, 2);
});
