import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type FieldsRead,
  linkedRepositoryNames,
  type ProjectsRead,
  projectChoices,
  type RepositoriesRead,
  rowState,
  selectField,
  selectProject,
} from "../../web/src/readiness-discovery.js";

const repositories: RepositoriesRead = {
  state: "ready",
  truncated: false,
  repositories: [
    {
      repositoryId: "R_atlas",
      owner: "Acme",
      name: "Atlas",
      defaultBranch: "main",
    },
    {
      repositoryId: "R_relay",
      owner: "acme",
      name: "relay",
      defaultBranch: "main",
    },
  ],
};
const project = (id: string, title: string, number = 1) => ({
  projectNodeId: id,
  title,
  number,
});
const projects = (
  linked: ReturnType<typeof project>[],
  truncated = false,
  ownerLogin = "acme",
): ProjectsRead => ({
  state: "ready",
  ownerLogin,
  linked,
  owned: [project("PVT_owned", "Owned")],
  truncated,
});
const fields: FieldsRead = {
  state: "ready",
  truncated: false,
  fields: [
    {
      fieldNodeId: "F_status",
      name: "Status",
      options: [
        { optionNodeId: "O_todo", name: "Todo" },
        { optionNodeId: "O_ready", name: "Ready" },
      ],
    },
  ],
};
const ids = (projectNodeId = "", fieldNodeId = "", optionNodeId = "") => ({
  projectNodeId,
  fieldNodeId,
  optionNodeId,
});
const saved = [{ repositoryId: "R_atlas" }];
const ready = projectChoices(repositories, saved, {
  "Acme/Atlas": projects([project("PVT_atlas", "Atlas roadmap")]),
});

test("saved links resolve by node ID, typed id or owner/name and unresolved links are skipped", () => {
  const names = (...repositoryIds: string[]) =>
    linkedRepositoryNames(
      repositoryIds.map((repositoryId) => ({ repositoryId })),
      repositories.state === "ready" ? repositories.repositories : [],
    );
  assert.deepEqual(names("R_atlas"), ["Acme/Atlas"]);
  assert.deepEqual(names("github.com/acme/atlas"), ["Acme/Atlas"]);
  assert.deepEqual(names("ACME/atlas", "R_atlas"), ["Acme/Atlas"]);
  assert.deepEqual(names("R_gone", "acme/relay"), ["acme/relay"]);
});

test("the Project list is the linked Projects only, deduplicated across repositories", () => {
  assert.deepEqual(ready, {
    state: "ready",
    projects: [{ projectNodeId: "PVT_atlas", label: "Atlas roadmap" }],
  });
  const both = projectChoices(
    repositories,
    [{ repositoryId: "R_atlas" }, { repositoryId: "R_relay" }],
    {
      "Acme/Atlas": projects([project("PVT_a", "A"), project("PVT_b", "B")]),
      "acme/relay": projects([project("PVT_b", "B")]),
    },
  );
  assert.deepEqual(
    both.state === "ready" && both.projects.map((p) => p.projectNodeId),
    ["PVT_a", "PVT_b"],
  );
});

test("Projects that share a title are told apart by owner and number", () => {
  const labels = (c: ReturnType<typeof projectChoices>) =>
    c.state === "ready" ? c.projects.map((p) => p.label) : c.state;
  const both = [{ repositoryId: "R_atlas" }, { repositoryId: "R_relay" }];
  // Same owner: the Project number differs. Other titles stay plain.
  assert.deepEqual(
    labels(
      projectChoices(repositories, saved, {
        "Acme/Atlas": projects([
          project("PVT_a", "Roadmap", 1),
          project("PVT_b", "Roadmap", 2),
          project("PVT_c", "Web", 3),
        ]),
      }),
    ),
    ["Roadmap (acme #1)", "Roadmap (acme #2)", "Web"],
  );
  // Across linked repositories with different owners.
  assert.deepEqual(
    labels(
      projectChoices(repositories, both, {
        "Acme/Atlas": projects([project("PVT_a", "Roadmap", 1)]),
        "acme/relay": projects(
          [project("PVT_x", "Roadmap", 1)],
          false,
          "other",
        ),
      }),
    ),
    ["Roadmap (acme #1)", "Roadmap (other #1)"],
  );
  // A Project linked from two repositories is listed once, without a suffix.
  assert.deepEqual(
    labels(
      projectChoices(repositories, both, {
        "Acme/Atlas": projects([project("PVT_a", "Roadmap")]),
        "acme/relay": projects([project("PVT_a", "Roadmap")]),
      }),
    ),
    ["Roadmap"],
  );
});

test("pending reads load; unavailable, truncated or empty reads fall back with a note", () => {
  assert.equal(projectChoices(undefined, saved, {}).state, "loading");
  assert.equal(projectChoices(repositories, saved, {}).state, "loading");
  const note = (c: ReturnType<typeof projectChoices>) =>
    c.state === "typed" ? c.note : c.state;
  assert.match(
    note(
      projectChoices(
        { state: "unavailable", reason: "unauthorized" },
        saved,
        {},
      ),
    ),
    /^GitHub discovery is unavailable: GitHub rejected the credential\. Type the node IDs\.$/,
  );
  assert.match(
    note(
      projectChoices(
        { state: "unavailable", reason: "unconfigured" },
        saved,
        {},
      ),
    ),
    /^GitHub discovery is unavailable: no discovery credential is configured.* Type the node IDs\.$/,
  );
  assert.match(
    note(projectChoices({ ...repositories, truncated: true }, saved, {})),
    /^GitHub discovery is unavailable: .*too many results/,
  );
  assert.match(
    note(
      projectChoices(repositories, saved, {
        "Acme/Atlas": { state: "unavailable", reason: "rate-limited" },
      }),
    ),
    /rate limit/,
  );
  assert.match(
    note(
      projectChoices(repositories, saved, { "Acme/Atlas": projects([], true) }),
    ),
    /too many results/,
  );
  for (const none of [
    projectChoices(repositories, saved, { "Acme/Atlas": projects([]) }),
    projectChoices(repositories, [{ repositoryId: "R_gone" }], {}),
  ])
    assert.match(note(none), /^No GitHub Project is linked/);
});

test("a row shows selects for empty or fully listed IDs and keeps typed IDs otherwise", () => {
  const read = { PVT_atlas: fields };
  assert.equal(rowState(ids(), ready, {}).state, "picker");
  assert.equal(
    rowState(ids("PVT_atlas", "F_status", "O_ready"), ready, read).state,
    "picker",
  );
  // The Project list stays selectable while its fields load.
  assert.deepEqual(rowState(ids("PVT_atlas"), ready, {}), {
    state: "loading",
    projects: [{ projectNodeId: "PVT_atlas", label: "Atlas roadmap" }],
  });
  assert.equal(rowState(ids(), { state: "loading" }, {}).state, "loading");
  for (const unlisted of [
    ids("PVT_gone"),
    ids("PVT_atlas", "F_gone"),
    ids("PVT_atlas", "F_status", "O_gone"),
    ids("PVT_atlas", "", "O_ready"),
    ids("", "F_status"),
  ])
    assert.equal(rowState(unlisted, ready, read).state, "typed");
  for (const failed of [
    { state: "unavailable", reason: "forbidden" } as const,
    { ...fields, truncated: true },
  ])
    assert.equal(
      rowState(ids("PVT_atlas"), ready, { PVT_atlas: failed }).state,
      "typed",
    );
  assert.equal(
    rowState(ids(), { state: "typed", note: "n" }, {}).state,
    "typed",
  );
});

test("choosing a Project clears field and option, and choosing a field clears the option", () => {
  assert.deepEqual(selectProject("PVT_b"), ids("PVT_b"));
  assert.deepEqual(
    selectField(ids("PVT_a", "F_old", "O_old"), "F_new"),
    ids("PVT_a", "F_new"),
  );
});
