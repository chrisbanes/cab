import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  harnessDocuments,
  issueTitle,
  projectTitle,
  StatusMappingGuard,
  statusMappingManifestSchema,
} from "./github-qualification/status-mapping-fixture.js";
import { runStatusMappingJourney } from "./github-qualification/status-mapping-journey.js";

const fullName = "chrisbanes/ensemble-s07a-fixture";
const repositoryNode = "R_fixture";
const token = "ghp_live_status_mapping_secret_0123456789";

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
  actions: ["project.field"],
  runtimeTurnLimit: 0,
  maxAttempts: 4,
});
function files(
  change: Record<string, unknown> = {},
  expiresAt = "2099-01-01T00:00:00Z",
) {
  const raw = JSON.stringify({ ...manifest(), ...change });
  const grant = {
    version: 1,
    manifestSha256: createHash("sha256").update(raw).digest("hex"),
    accountNodeId: "U_owner",
    repositoryNodeId: repositoryNode,
    repositoryVisibility: "public",
    credential: "gh-cli",
    actions: ["project.field"],
    runtimeTurnLimit: 0,
    expiresAt,
    cleanup: { deleteScratchProjects: true, closeFixtureIssues: true },
  };
  return { raw, grant };
}
const api = (path: string) => `https://api.github.com${path}`;

test("the grant must match the manifest, be unexpired and stay inside the attempt allowance", () => {
  const f = files();
  assert.throws(() => new StatusMappingGuard(f.raw, undefined), /grant/);
  assert.throws(() => new StatusMappingGuard(`${f.raw} `, f.grant), /manifest/);
  assert.throws(
    () =>
      new StatusMappingGuard(f.raw, {
        ...f.grant,
        expiresAt: "2000-01-01T00:00:00Z",
      }),
    /expired/,
  );
  assert.throws(
    () =>
      new StatusMappingGuard(f.raw, {
        ...f.grant,
        cleanup: { deleteScratchProjects: true, closeFixtureIssues: false },
      }),
  );
  for (const change of [
    {
      repository: { ...manifest().repository, fullName: "chrisbanes/cab" },
    },
    { credential: "env:S07A_GITHUB_TOKEN" },
    { actions: ["project.field", "pr.merge"] },
    { runtimeTurnLimit: 1 },
    { maxAttempts: 2 },
    { maxAttempts: 5 },
  ])
    assert.equal(
      statusMappingManifestSchema.safeParse({ ...manifest(), ...change })
        .success,
      false,
      JSON.stringify(change),
    );
  const g = new StatusMappingGuard(f.raw, f.grant);
  assert.throws(() => g.begin("aaaaaaaa", 5), /allowance/);
  assert.throws(() => g.begin("aaaaaaaa", 0), /allowance/);
  assert.throws(() => g.begin("not-a-run", 1), /run id/);
  g.begin("aaaaaaaa", 3);
});

test("only the Project this run created may be used: never Project 6, never one linked to the product repository", () => {
  const f = files();
  const g = () => {
    const guard = new StatusMappingGuard(f.raw, f.grant);
    guard.begin("aaaaaaaa", 1);
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

test("the guard allows only the product's documents on the recorded resources and exact gh commands", () => {
  const f = files();
  const g = new StatusMappingGuard(f.raw, f.grant);
  g.begin("aaaaaaaa", 1);
  const post = (query: string, variables: Record<string, unknown> = {}) =>
    [
      api("/graphql"),
      { method: "POST", body: JSON.stringify({ query, variables }) },
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
    projectTitle("aaaaaaaa"),
    "--format",
    "json",
  ]);
  g.recordProject({
    nodeId: "PVT_9",
    number: 9,
    linkedRepositories: [fullName],
  });
  g.recordField("F_1", ["O_1", "O_2"]);
  g.recordItem("ITEM_1");
  g.recordIssue(7);
  const ok = [
    ["api", "-i", "/user"],
    ["project", "link", "9", "--owner", "chrisbanes", "--repo", fullName],
    ["project", "delete", "9", "--owner", "chrisbanes"],
    [
      "project",
      "item-edit",
      "--id",
      "ITEM_1",
      "--project-id",
      "PVT_9",
      "--field-id",
      "F_1",
      "--single-select-option-id",
      "O_2",
    ],
    ["issue", "close", "7", "--repo", fullName],
    [
      "api",
      "graphql",
      "-f",
      `query=${harnessDocuments.projectExists}`,
      "-f",
      "project=PVT_9",
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
    [
      "project",
      "item-edit",
      "--id",
      "ITEM_2",
      "--project-id",
      "PVT_9",
      "--field-id",
      "F_1",
      "--single-select-option-id",
      "O_2",
    ],
    [
      "project",
      "item-edit",
      "--id",
      "ITEM_1",
      "--project-id",
      "PVT_9",
      "--field-id",
      "F_1",
      "--single-select-option-id",
      "O_other",
    ],
    ["issue", "close", "8", "--repo", fullName],
    [
      "issue",
      "create",
      "--repo",
      "chrisbanes/cab",
      "--title",
      issueTitle("aaaaaaaa"),
      "--body",
      "x",
    ],
    ["repo", "delete", fullName],
    [
      "api",
      "graphql",
      "-f",
      `query=${harnessDocuments.projectExists}`,
      "-f",
      "project=PVT_6",
    ],
    [
      "api",
      "graphql",
      "-f",
      "query=mutation { deleteProjectV2 }",
      "-f",
      "project=PVT_9",
    ],
    ["api", "--method", "DELETE", `repos/${fullName}`],
  ])
    assert.throws(() => g.assertGh(args), /guard/, args.join(" "));
  assert.deepEqual(g.writes, [
    "gh project create",
    "gh project link",
    "gh project delete",
    "gh project item-edit",
    "gh issue close",
  ]);

  g.assertRequest(api("/user"));
  g.assertRequest(api(`/repos/${fullName}/issues/7`));
  g.assertRequest(
    ...post("query CabProjectPage($id:ID!)", {
      id: "PVT_9",
      query: "is:issue",
      after: null,
    }),
  );
  g.assertRequest(
    ...post("mutation CabDeliveryProject($project:ID!)", {
      project: "PVT_9",
      item: "ITEM_1",
      field: "F_1",
      option: "O_2",
    }),
  );
  for (const [url, init] of [
    ["https://attacker.example/graphql", { method: "POST" }],
    [api("/repos/chrisbanes/cab/issues/1"), {}],
    [api(`/repos/${fullName}/issues/7`), { method: "PATCH", body: "{}" }],
    [api("/orgs/someone/projectsV2"), {}],
    post("mutation { deleteProjectV2(input:{}) { clientMutationId } }"),
    post("query CabProjectPage($id:ID!)", {
      id: "PVT_6",
      query: "is:issue",
      after: null,
    }),
    post("mutation CabDeliveryProject($project:ID!)", {
      project: "PVT_9",
      item: "ITEM_2",
      field: "F_1",
      option: "O_2",
    }),
    post("mutation CabDeliveryProject($project:ID!)", {
      project: "PVT_9",
      item: "ITEM_1",
      field: "F_1",
      option: "O_unknown",
    }),
  ] as const)
    assert.throws(
      () => g.assertRequest(url as never, init as RequestInit),
      /guard/,
      String(url),
    );
  assert.equal(
    g.writes.filter((w) => w.includes("updateProjectV2ItemFieldValue")).length,
    1,
  );
});

/** A fake GitHub holding one scratch Project, its Status options and one issue. */
function fakeGitHub(
  fail: {
    link?: boolean;
    /** The next `item-add` calls fail with GitHub's transient "temporary conflict" answer. */
    transientItemAdds?: number;
    /** Project reads that list no item yet. */
    emptyReads?: number;
    /** A deleted Project answers with a not-found error, as GitHub does, not a null node. */
    notFoundAfterDelete?: boolean;
  } = {},
) {
  const options = [
    ["O_todo", "Todo"],
    ["O_prog", "In Progress"],
    ["O_rev", "In review"],
    ["O_done", "Done"],
  ] as const;
  const state = {
    status: "O_todo" as string,
    projectDeleted: false,
    projectCreated: false,
    itemAddCalls: 0,
    issueClosed: false,
    fetches: [] as string[],
    ghCalls: [] as string[],
    projectReads: 0,
  };
  const name = (id: string) => options.find(([o]) => o === id)?.[1] ?? null;
  const gh = (args: string[]): string => {
    state.ghCalls.push(args.slice(0, 2).join(" "));
    const [a, b] = args;
    if (a === "api" && b === "-i")
      return "HTTP/2.0 200 OK\nX-Oauth-Scopes: project, repo\n\n{}";
    if (a === "project" && b === "create") {
      state.projectCreated = true;
      return JSON.stringify({ id: "PVT_scratch", number: 41 });
    }
    if (a === "project" && b === "link") {
      if (fail.link) throw new Error("link refused");
      return "";
    }
    if (a === "project" && b === "field-list")
      return JSON.stringify({ fields: [{ id: "F_status", name: "Status" }] });
    if (a === "issue" && b === "create")
      return `https://github.com/${fullName}/issues/9\n`;
    if (a === "project" && b === "item-add") {
      if ((fail.transientItemAdds ?? 0) > state.itemAddCalls++)
        throw new Error(
          "GraphQL: Your attempt to move this item created a temporary conflict. Please try again.",
        );
      return JSON.stringify({ id: "ITEM_1" });
    }
    if (a === "project" && b === "item-edit") {
      state.status = args[9] ?? "";
      return "";
    }
    if (a === "project" && b === "item-list")
      return JSON.stringify({
        items: [{ id: "ITEM_1", status: name(state.status) }],
      });
    if (a === "issue" && b === "close") {
      state.issueClosed = true;
      return "";
    }
    if (a === "project" && b === "delete") {
      state.projectDeleted = true;
      return "";
    }
    if (a === "api" && b?.startsWith("repos/"))
      return state.issueClosed ? "closed\n" : "open\n";
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
                id: "F_status",
                options: options.map(([id, n]) => ({ id, name: n })),
              },
            },
          },
        });
      if (state.projectDeleted && fail.notFoundAfterDelete)
        throw new Error(
          "gh: Could not resolve to a node with the global id of 'PVT_scratch'.",
        );
      return JSON.stringify({
        data: { node: state.projectDeleted ? null : { id: "PVT_scratch" } },
      });
    }
    throw new Error(`unexpected gh ${args.join(" ")}`);
  };
  const page = { hasNextPage: false, endCursor: null };
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    state.fetches.push(`${init?.method ?? "GET"} ${url.pathname}`);
    if (url.pathname === "/user") return Response.json({ node_id: "U1" });
    if (url.pathname === `/repos/${fullName}`)
      return Response.json({
        node_id: repositoryNode,
        full_name: fullName,
        private: false,
        allow_merge_commit: true,
        allow_squash_merge: true,
        allow_rebase_merge: false,
      });
    if (url.pathname === `/repos/${fullName}/issues/9`)
      return Response.json({
        node_id: "I_9",
        number: 9,
        state: "open",
        title: issueTitle("x"),
        body: "b",
        labels: [],
      });
    const { query, variables } = JSON.parse(String(init?.body)) as {
      query: string;
      variables: Record<string, string>;
    };
    if (query.startsWith("query CabDeliveryRepository"))
      return Response.json({
        data: { node: { id: repositoryNode, nameWithOwner: fullName } },
      });
    if (query.startsWith("mutation CabDeliveryProject")) {
      state.status = variables.option ?? "";
      return Response.json({ data: {} });
    }
    const value = {
      __typename: "ProjectV2ItemFieldSingleSelectValue",
      optionId: state.status,
      field: { id: "F_status" },
    };
    if (query.startsWith("query CabDeliveryField"))
      return Response.json({
        data: {
          node: {
            id: "ITEM_1",
            project: { id: "PVT_scratch" },
            content: { id: "I_9", repository: { id: repositoryNode } },
            fieldValues: { nodes: [value], pageInfo: page },
          },
          field: {
            id: "F_status",
            options: options.map(([id]) => ({ id })),
            project: { id: "PVT_scratch" },
          },
        },
      });
    if (query.startsWith("query CabProjectPage")) {
      const listed = state.projectReads++ >= (fail.emptyReads ?? 0);
      return Response.json({
        data: {
          node: {
            id: "PVT_scratch",
            items: {
              nodes: !listed
                ? []
                : [
                    {
                      id: "ITEM_1",
                      content: {
                        __typename: "Issue",
                        id: "I_9",
                        number: 9,
                        title: issueTitle("x"),
                        body: "b",
                        state: "OPEN",
                        repository: {
                          id: repositoryNode,
                          nameWithOwner: fullName,
                        },
                        labels: { nodes: [], pageInfo: page },
                      },
                      fieldValues: { nodes: [value], pageInfo: page },
                    },
                  ],
              pageInfo: page,
            },
            fields: {
              nodes: [
                {
                  __typename: "ProjectV2SingleSelectField",
                  id: "F_status",
                  options: options.map(([id, n]) => ({ id, name: n })),
                },
              ],
              pageInfo: page,
            },
          },
        },
      });
    }
    throw new Error(`unexpected request ${query.slice(0, 40)}`);
  };
  return { state, gh, fetcher };
}

test("a run writes both events through the real writer, reads each back independently and deletes the Project", async () => {
  const f = files();
  const fake = fakeGitHub();
  const guard = new StatusMappingGuard(f.raw, f.grant);
  const evidence = await runStatusMappingJourney({
    guard,
    token,
    attempt: 1,
    gh: fake.gh,
    fetcher: fake.fetcher,
    readRetryMs: 0,
  });
  assert.equal(evidence.failure, undefined, JSON.stringify(evidence));
  assert.equal(evidence.qualification, "passed");
  assert.equal(evidence.cleanup, "verified");
  assert.equal(evidence.turns, 0);
  assert.equal(evidence.credentialExposures, 0);
  assert.deepEqual(evidence.project, { nodeId: "PVT_scratch", number: 41 });
  assert.deepEqual(evidence.deletedProject, {
    nodeId: "PVT_scratch",
    number: 41,
    deleted: true,
  });
  for (const [event, status] of [
    ["turnStarted", "In Progress"],
    ["handedBack", "In review"],
  ] as const) {
    const record = evidence[event] as Record<string, unknown>;
    assert.equal(record.state, "confirmed-success", event);
    assert.equal(record.independentReadback, status, event);
  }
  assert.equal(fake.state.projectDeleted, true);
  assert.equal(fake.state.issueClosed, true);
  // Exactly the two Status mutations, plus the harness's own setup and cleanup writes.
  assert.equal(
    guard.writes.filter((w) => w.includes("updateProjectV2ItemFieldValue"))
      .length,
    2,
  );
  assert.equal(JSON.stringify(evidence).includes(token), false);
});

test("a run that fails after creating the Project still deletes it and proves the cleanup", async () => {
  const f = files();
  const fake = fakeGitHub({ link: true });
  const evidence = await runStatusMappingJourney({
    guard: new StatusMappingGuard(f.raw, f.grant),
    token,
    attempt: 1,
    gh: fake.gh,
    fetcher: fake.fetcher,
  });
  assert.equal(evidence.qualification, "failed");
  assert.match(String(evidence.failure), /link refused/);
  assert.equal(evidence.cleanup, "verified");
  assert.equal(fake.state.projectDeleted, true);
  assert.deepEqual(
    fake.state.fetches.filter((r) => r.startsWith("POST")),
    [],
  );
});

test("a login without the project scope stops before anything is created", async () => {
  const f = files();
  const fake = fakeGitHub();
  const gh = (args: string[]) =>
    args[1] === "-i"
      ? "HTTP/2.0 200 OK\nX-Oauth-Scopes: repo\n\n{}"
      : fake.gh(args);
  const evidence = await runStatusMappingJourney({
    guard: new StatusMappingGuard(f.raw, f.grant),
    token,
    attempt: 1,
    gh,
    fetcher: fake.fetcher,
  });
  assert.equal(evidence.qualification, "failed");
  assert.match(String(evidence.failure), /project scope/);
  assert.equal(fake.state.projectCreated, false);
  assert.equal(evidence.cleanup, "verified");
});

test("a Project that lists its item late is read again, and a deleted Project that answers not-found is proved gone", async () => {
  const f = files();
  const fake = fakeGitHub({ emptyReads: 2, notFoundAfterDelete: true });
  const evidence = await runStatusMappingJourney({
    guard: new StatusMappingGuard(f.raw, f.grant),
    token,
    attempt: 1,
    gh: fake.gh,
    fetcher: fake.fetcher,
    readRetryMs: 0,
  });
  assert.equal(evidence.failure, undefined, JSON.stringify(evidence));
  assert.equal(evidence.qualification, "passed");
  assert.equal((evidence.projectReads as { reads: number }).reads, 3);
  assert.equal(evidence.cleanup, "verified");
});

test("a Project that never lists its item fails with the read counts and still cleans up", async () => {
  const f = files();
  const fake = fakeGitHub({ emptyReads: 99 });
  const evidence = await runStatusMappingJourney({
    guard: new StatusMappingGuard(f.raw, f.grant),
    token,
    attempt: 1,
    gh: fake.gh,
    fetcher: fake.fetcher,
    readRetryMs: 0,
  });
  assert.equal(evidence.qualification, "failed");
  assert.match(String(evidence.failure), /0 issues/);
  assert.equal(evidence.itemsListedByGh, 1);
  assert.deepEqual(evidence.projectReads, {
    reads: 10,
    filter: "is:issue",
    complete: true,
    reason: null,
    issues: 0,
  });
  assert.equal(evidence.cleanup, "verified");
  assert.equal(fake.state.projectDeleted, true);
});

test("a transient GitHub error in setup is retried at most three tries, and a persistent one fails the run with cleanup", async () => {
  for (const [transientItemAdds, passes] of [
    [2, true],
    [3, false],
  ] as const) {
    const f = files();
    const fake = fakeGitHub({ transientItemAdds });
    const evidence = await runStatusMappingJourney({
      guard: new StatusMappingGuard(f.raw, f.grant),
      token,
      attempt: 1,
      gh: fake.gh,
      fetcher: fake.fetcher,
      readRetryMs: 0,
      ghRetryMs: 0,
    });
    assert.equal(evidence.qualification, passes ? "passed" : "failed");
    assert.equal(fake.state.itemAddCalls, Math.min(transientItemAdds + 1, 3));
    assert.equal(evidence.cleanup, "verified");
  }
});
