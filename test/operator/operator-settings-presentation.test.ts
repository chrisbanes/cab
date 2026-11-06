import {
  starterReviewerHarness,
  starterOptionCopy,
} from "../../web/src/setup-model.js";
import type { Workspace } from "../../src/operator/contracts.js";
import { sourceCredentialExplanation } from "../../src/standalone/github-source-credential.js";
import {
  commandNetworkAppliesNote,
  commandNetworkDisclosure,
  projectCommandNetworkLine,
} from "../../src/operator/command-network-copy.js";
import {
  diagnosticCaptureAppliesNote,
  diagnosticCaptureLine,
  sourceCredentialCopy,
} from "../../web/src/settings-view.js";
import { themeBlocks } from "../fixtures/theme-tokens.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import {
  adoptRepositoryRows,
  adoptSourceRows,
  capacityChanges,
  nextSelectionId,
  parseRows,
  profileChanges,
  projectChanges,
  privateField,
  removesAllAccess,
  repositoryChanges,
  repositoryCommand,
  repositoryRowsFrom,
  routingChanges,
  routingCommand,
  sourceChanges,
  sourceCommand,
  sourceRowsFrom,
  jiraRowsFrom,
  jiraSelections,
  adoptJiraRows,
  staleRepositoryRows,
  staleSourceRows,
  duplicateRepositoryIds,
  duplicateSourceIds,
  type ProfileConfigurationData,
  type ProjectConfigurationData,
  type RuntimeSettingsData,
} from "../../web/src/settings-changes.js";
import {
  holdPills,
  projectStateSummary,
  recoveryRecordRuns,
  readinessNextStep,
  repositoryLines,
  joinNames,
  draftSourceName,
  observationLabel,
  savedLine,
  selectionLine,
  settingsHeader,
  sourceHeading,
  sourceName,
  sourceStatusLine,
} from "../../web/src/settings-view.js";
import { clockLabel } from "../../web/src/presentation.js";

const id = () => randomUUID();
const mira = id(),
  jonas = id(),
  worker = id(),
  reviewer = id(),
  projectId = id();
const profile = (pid: string, name: string, revoked = false) => ({
  id: pid,
  name,
  summary: "Lead",
  version: 1,
  revoked,
});
const config = (): ProjectConfigurationData =>
  ({
    project: {
      id: projectId,
      name: "Atlas",
      version: 3,
      paused: false,
      archived: false,
      leadProfileId: mira,
    },
    profiles: [
      profile(mira, "Mira"),
      profile(jonas, "Jonas"),
      profile(worker, "Worker"),
      profile(reviewer, "Reviewer", true),
    ],
    instructionsRevision: 1,
    instructionPresent: true,
    routing: {
      version: 2,
      enabled: false,
      candidateProfileIds: [worker, reviewer],
      credentialConfigured: false,
      availability: "disabled",
    },
    placements: [],
    source: {
      version: 4,
      credentialConfigured: true,
      selections: [
        {
          id: "S-1",
          kind: "repository",
          descriptor: "acme/atlas",
          active: true,
        },
        { id: "S-3", kind: "project", descriptor: "PVT_x", active: false },
      ],
      readiness: {
        kind: "rule",
        mode: "all",
        conditions: [{ kind: "label", operator: "has", name: "ready" }],
      },
      closedIssues: "skip",
    },
    repositories: {
      version: 2,
      links: [
        {
          repositoryId: "acme/atlas",
          codeHost: "github",
          host: "github.com",
          ref: "main",
        },
      ],
    },
  }) as ProjectConfigurationData;

test("project and profile change lists name each change without private values", () => {
  const c = config();
  assert.deepEqual(
    projectChanges(c, { name: "Atlas", leadProfileId: mira, paused: false }),
    [],
  );
  assert.deepEqual(
    projectChanges(c, {
      name: "Atlas II",
      leadProfileId: jonas,
      paused: true,
      instructions: "PRIVATE",
    }),
    [
      "Project name: Atlas → Atlas II",
      "Lead agent: Mira → Jonas",
      "Pause project",
      "Instructions edited",
    ],
  );
  assert.deepEqual(
    projectChanges(
      { ...c, project: { ...c.project, paused: true } },
      { name: "Atlas", leadProfileId: mira, paused: false },
    ),
    ["Unpause project"],
  );
  // The command network switch lists both directions, and only against a loaded setting.
  const network = (saved: boolean, next: boolean) =>
    projectChanges(
      { ...c, commandNetworkAccess: saved },
      { name: "Atlas", leadProfileId: mira, commandNetworkAccess: next },
    );
  assert.deepEqual(network(false, true), ["Command network access enabled"]);
  assert.deepEqual(network(true, false), ["Command network access disabled"]);
  assert.deepEqual(network(true, true), []);
  // Diagnostic capture lists the change in both directions, and nothing for a mode the service did not report.
  const capture = (saved: "enhanced" | "baseline" | undefined, next: string) =>
    projectChanges(
      { ...c, ...(saved ? { diagnosticCapture: saved } : {}) },
      { name: "Atlas", leadProfileId: mira, diagnosticCapture: next },
    );
  assert.deepEqual(capture("enhanced", "baseline"), [
    "Diagnostic capture: Enhanced → Baseline",
  ]);
  assert.deepEqual(capture("baseline", "enhanced"), [
    "Diagnostic capture: Baseline → Enhanced",
  ]);
  assert.deepEqual(capture("baseline", "baseline"), []);
  assert.deepEqual(capture(undefined, "baseline"), []);
  // An unedited reveal adds no line and no command field, and the text is never a line.
  const base = { name: "Atlas", leadProfileId: mira, paused: false };
  assert.deepEqual(projectChanges(c, base, "PRIVATE"), []);
  assert.deepEqual(privateField("instructions", undefined, "PRIVATE"), {});
  assert.deepEqual(
    projectChanges(c, { ...base, instructions: "PRIVATE" }, "PRIVATE"),
    [],
  );
  assert.deepEqual(privateField("instructions", "PRIVATE", "PRIVATE"), {});
  assert.deepEqual(
    projectChanges(c, { ...base, instructions: "" }, "PRIVATE"),
    ["Instructions cleared"],
  );
  assert.deepEqual(privateField("instructions", "", "PRIVATE"), {
    instructions: "",
  });
  assert.deepEqual(
    projectChanges(c, { ...base, instructions: "NEW" }, "PRIVATE"),
    ["Instructions edited"],
  );
  assert.deepEqual(privateField("instructions", "NEW", "PRIVATE"), {
    instructions: "NEW",
  });
  // Without a revealed baseline an edit still counts, so the version fence decides.
  assert.deepEqual(privateField("instructions", "NEW", undefined), {
    instructions: "NEW",
  });
  assert.equal(
    projectChanges(c, { ...base, instructions: "NEW" }, "PRIVATE")
      .join(" ")
      .includes("NEW"),
    false,
  );
  const p = {
    profile: {
      id: reviewer,
      name: "Reviewer",
      summary: "Review",
      version: 2,
      revoked: false,
    },
    instructionPresent: true,
    instructionRevision: 1,
    capabilities: "Reviews",
  } as ProfileConfigurationData;
  assert.deepEqual(
    profileChanges(p, {
      name: "Reviewer",
      summary: "Review",
      capabilities: "More",
      revoked: true,
    }),
    ["Capabilities edited", "Revoke Reviewer"],
  );
  assert.deepEqual(
    profileChanges(
      { ...p, profile: { ...p.profile, revoked: true } },
      {
        name: "Reviewer",
        summary: "Review",
        capabilities: "Reviews",
        revoked: false,
      },
    ),
    ["Restore Reviewer"],
  );
  const same = { name: "Reviewer", summary: "Review", capabilities: "Reviews" };
  assert.deepEqual(profileChanges(p, { ...same, instructions: "NEW" }, "OLD"), [
    "Instructions edited",
  ]);
  assert.deepEqual(profileChanges(p, { ...same, instructions: "" }, "OLD"), [
    "Instructions cleared",
  ]);
  assert.deepEqual(
    profileChanges(p, { ...same, instructions: "OLD" }, "OLD"),
    [],
  );
  assert.deepEqual(privateField("instructions", undefined, "OLD"), {});
  assert.deepEqual(privateField("instructions", "NEW", "OLD"), {
    instructions: "NEW",
  });
});

test("routing lines and command keep guidance out unless edited", () => {
  const c = config();
  // The saved revoked candidate is not selectable, so dropping it is not a listed change.
  assert.deepEqual(
    routingChanges(c, { enabled: false, candidateProfileIds: [worker] }),
    [],
  );
  assert.deepEqual(
    routingChanges(c, {
      enabled: true,
      candidateProfileIds: [worker, mira],
      guidance: "PRIVATE",
      referenceMode: "set",
    }),
    [
      "Routing enabled",
      "Candidate added: Mira",
      "Routing guidance edited",
      "Credential reference: set new environment reference",
    ],
  );
  assert.deepEqual(
    routingChanges(
      c,
      { enabled: false, candidateProfileIds: [worker], guidance: "" },
      "OLD",
    ),
    ["Routing guidance cleared"],
  );
  assert.deepEqual(
    routingChanges(
      { ...c, routing: { ...c.routing, enabled: true } },
      { enabled: false, candidateProfileIds: [worker] },
    ),
    ["Routing disabled"],
  );
  assert.deepEqual(
    routingChanges(
      c,
      { enabled: false, candidateProfileIds: [worker], guidance: "OLD" },
      "OLD",
    ),
    [],
  );
  // A candidate revoked after it was checked is neither listed nor sent.
  assert.deepEqual(
    routingChanges(c, {
      enabled: false,
      candidateProfileIds: [worker, reviewer],
    }),
    [],
  );
  assert.deepEqual(
    routingCommand(
      projectId,
      {
        key: "k",
        expectedVersion: "2",
        enabled: false,
        candidateProfileIds: [worker, reviewer],
      },
      c,
    ).candidateProfileIds,
    [worker],
  );
  const command = routingCommand(
    projectId,
    {
      key: "k",
      expectedVersion: "2",
      enabled: true,
      candidateProfileIds: [worker],
    },
    c,
    "PRIVATE",
  );
  assert.equal("guidance" in command, false);
  const edited = routingCommand(
    projectId,
    {
      key: "k",
      expectedVersion: "2",
      enabled: true,
      candidateProfileIds: [worker],
      guidance: "NEW",
    },
    c,
    "PRIVATE",
  );
  assert.equal((edited as Record<string, unknown>).guidance, "NEW");
});

test("source rows, change lines and command use keep markers and never put a value in a line", () => {
  const c = config();
  const rows = sourceRowsFrom(c.source);
  assert.equal(rows.incomplete, false);
  const values = {
    key: "k",
    expectedVersion: "4",
    mode: "any",
    conditions: JSON.stringify(rows.conditions),
    selections: JSON.stringify([
      rows.selections[0],
      { ...rows.selections[1], removed: true },
      { id: "S-4", kind: "search", query: "PRIVATE QUERY", rowKey: "r" },
    ]),
    referenceMode: "clear",
  };
  const lines = sourceChanges(c.source, values);
  assert.deepEqual(lines, [
    "− S-3 · GitHub Project PVT_x",
    "+ S-4 · Search · added inactive",
    "Readiness: any of 1 condition",
    "Credential reference: cleared",
  ]);
  assert.equal(lines.join(" ").includes("PRIVATE"), false);
  assert.equal(
    sourceCommand(projectId, {
      ...values,
      referenceMode: "gh",
      credentialRef: "env:PRIVATE",
    }).credentialRef,
    "gh:github.com",
  );
  assert.ok(
    sourceChanges(c.source, {
      ...values,
      referenceMode: "gh",
      credentialRef: "env:PRIVATE",
    }).includes("Credential reference: use GitHub CLI login"),
  );
  assert.ok(
    !sourceChanges(c.source, {
      ...values,
      referenceMode: "gh",
      credentialRef: "env:PRIVATE",
    })
      .join(" ")
      .includes("PRIVATE"),
  );
  const command = sourceCommand(projectId, values);
  assert.deepEqual(command.selections, [
    { id: "S-1", keep: true },
    { id: "S-4", kind: "search", query: "PRIVATE QUERY" },
  ]);
  // Repository links belong to the repositories form, not the source command.
  assert.equal("repositories" in command, false);
  assert.equal(rows.closedIssues, "skip");
  assert.equal(command.closedIssues, undefined);
  assert.deepEqual(
    sourceChanges(c.source, { ...values, closedIssues: "skip" }),
    lines,
  );
  assert.ok(
    sourceChanges(c.source, { ...values, closedIssues: "done" }).includes(
      "Closed issues: Treat closure as Done",
    ),
  );
  assert.equal(
    sourceCommand(projectId, { ...values, closedIssues: "done" }).closedIssues,
    "done",
  );
  assert.equal(nextSelectionId(["S-1", "S-3", "Literal <x>"], ["S-4"]), "S-5");
  assert.equal(nextSelectionId([], []), "S-1");
  assert.equal(
    sourceRowsFrom({
      ...c.source,
      selections: [
        { id: null, kind: "search", descriptor: null, active: false },
      ],
    }).incomplete,
    true,
  );
});

test("saved search queries edit in place and unchanged ones stay kept", () => {
  const c = config();
  c.source.selections.splice(1, 0, {
    id: "S-2",
    kind: "search",
    descriptor: null,
    active: false,
  });
  const known = { searches: [{ id: "S-2", query: "PRIVATE QUERY" }] };
  const rows = sourceRowsFrom(c.source);
  const values = (edit: { query?: string } = {}) => ({
    key: "k",
    expectedVersion: "4",
    mode: "all",
    conditions: JSON.stringify(rows.conditions),
    selections: JSON.stringify(
      rows.selections.map((r) =>
        r.id === "S-2" && edit.query !== undefined
          ? { ...r, query: edit.query }
          : r,
      ),
    ),
    referenceMode: "preserve",
  });
  const kept = [
    { id: "S-1", keep: true },
    { id: "S-2", keep: true },
    { id: "S-3", keep: true },
  ];
  // Untouched rows, with the values read or not, are kept and nothing is listed.
  for (const read of [known, undefined]) {
    assert.deepEqual(sourceChanges(c.source, values(), read), []);
    const command = sourceCommand(projectId, values(), read);
    assert.deepEqual(command.selections, kept);
  }
  // Typing the revealed value back is not a change.
  const same = values({ query: "PRIVATE QUERY" });
  assert.deepEqual(sourceChanges(c.source, same, known), []);
  assert.deepEqual(sourceCommand(projectId, same, known).selections, kept);
  // An edit keeps the id, sends the whole search and names no value.
  const edited = values({ query: "NEW QUERY" });
  const lines = sourceChanges(c.source, edited, known);
  assert.deepEqual(lines, ["Search query edited for S-2"]);
  assert.equal(/QUERY/.test(lines.join(" ")), false);
  const command = sourceCommand(projectId, edited, known);
  assert.deepEqual(command.selections, [
    { id: "S-1", keep: true },
    { id: "S-2", kind: "search", query: "NEW QUERY" },
    { id: "S-3", keep: true },
  ]);
  // An edit made while the loaded value is unknown still counts, so the version fence decides.
  assert.deepEqual(sourceChanges(c.source, edited), lines);
  // A removed row lists its removal, not an edit.
  assert.deepEqual(
    sourceChanges(
      c.source,
      {
        ...edited,
        selections: JSON.stringify(
          parseRows(edited.selections).map((r) =>
            r.id === "S-2" ? { ...r, removed: true } : r,
          ),
        ),
      },
      known,
    ).filter((l) => l.includes("S-2")),
    ["− S-2 · Search"],
  );
  // Adopting a newer version keeps an edit, and drops one whose row was removed elsewhere.
  const adopted = adoptSourceRows(c.source, edited);
  assert.equal(
    parseRows(adopted.selections).find((r) => r.id === "S-2")?.query,
    "NEW QUERY",
  );
  assert.deepEqual(adopted.dropped, []);
  const without = {
    ...c.source,
    selections: c.source.selections.filter((s) => s.id !== "S-2"),
  };
  assert.deepEqual(adoptSourceRows(without, edited).dropped, ["S-2"]);
});

test("repository rows, change lines and command keep a saved path unless it is edited", () => {
  const c = config();
  const rows = repositoryRowsFrom(c.repositories);
  assert.equal(rows.incomplete, false);
  assert.deepEqual(rows.repositories, [
    {
      codeHost: "github",
      host: "github.com",
      repositoryId: "acme/atlas",
      ref: "main",
      savedRef: "main",
      keep: true,
    },
  ]);
  const known = {
    links: [{ repositoryId: "acme/atlas", path: "/PRIVATE/PATH" }],
  };
  const values = (edit: { ref?: string; path?: string } = {}) => ({
    key: "k",
    expectedVersion: "2",
    repositories: JSON.stringify(
      rows.repositories.map((r) => ({
        ...r,
        ...(edit.ref === undefined ? {} : { ref: edit.ref }),
        ...(edit.path === undefined ? {} : { path: edit.path }),
      })),
    ),
  });
  // Untouched rows, with the values read or not, are kept and nothing is listed.
  for (const read of [known, undefined]) {
    assert.deepEqual(repositoryChanges(c.repositories, values(), read), []);
    assert.deepEqual(repositoryCommand(projectId, values(), read), {
      type: "repositories.configure",
      key: "k",
      projectId,
      expectedVersion: 2,
      repositories: [
        {
          codeHost: "github",
          host: "github.com",
          repositoryId: "acme/atlas",
          ref: "main",
        },
      ],
    });
  }
  // Typing the revealed path back is not a change.
  const same = values({ path: "/PRIVATE/PATH" });
  assert.deepEqual(repositoryChanges(c.repositories, same, known), []);
  assert.equal(
    "path" in (repositoryCommand(projectId, same, known).repositories[0] ?? {}),
    false,
  );
  // An edit sends the path and names no value.
  const edited = values({ ref: "dev", path: "/NEW/PATH" });
  const lines = repositoryChanges(c.repositories, edited, known);
  assert.deepEqual(lines, [
    "Ref for acme/atlas: main → dev",
    "Local path changed for acme/atlas",
  ]);
  assert.equal(/PATH/.test(lines.join(" ")), false);
  assert.deepEqual(repositoryCommand(projectId, edited, known).repositories, [
    {
      codeHost: "github",
      host: "github.com",
      repositoryId: "acme/atlas",
      ref: "dev",
      path: "/NEW/PATH",
    },
  ]);
  // An edit made while the loaded path is unknown still counts, so the version fence decides.
  assert.deepEqual(repositoryChanges(c.repositories, edited), lines);
  // A new link sends its path.
  assert.deepEqual(
    repositoryCommand(projectId, {
      ...values(),
      repositories: JSON.stringify([
        { repositoryId: "acme/new", path: "/NEW", ref: "main", rowKey: "n" },
      ]),
    }).repositories,
    [
      {
        codeHost: "github",
        host: "github.com",
        repositoryId: "acme/new",
        ref: "main",
        path: "/NEW",
      },
    ],
  );
  assert.equal(removesAllAccess(c.repositories, { repositories: "[]" }), true);
  assert.equal(
    removesAllAccess(c.repositories, {
      repositories: JSON.stringify([
        { ...rows.repositories[0], removed: true },
      ]),
    }),
    true,
  );
  assert.equal(
    removesAllAccess({ ...c.repositories, links: [] }, { repositories: "[]" }),
    false,
  );
  assert.equal(
    removesAllAccess(c.repositories, {
      repositories: JSON.stringify(rows.repositories),
    }),
    false,
  );
  assert.equal(
    repositoryRowsFrom({
      ...c.repositories,
      links: [
        {
          repositoryId: null,
          codeHost: "github",
          host: "github.com",
          ref: null,
        },
      ],
    } as never).incomplete,
    true,
  );
  // Adopting a newer version keeps an edit, and drops one whose link was removed elsewhere.
  const adopted = adoptRepositoryRows(c.repositories, edited);
  assert.equal(parseRows(adopted.repositories)[0]?.path, "/NEW/PATH");
  assert.deepEqual(adopted.dropped, []);
  assert.deepEqual(
    adoptRepositoryRows({ ...c.repositories, links: [] }, edited).dropped,
    ["acme/atlas"],
  );
});

test("a saved GitLab link keeps its code host through the form and is shown with its host", () => {
  const c = config();
  const saved = {
    ...c.repositories,
    links: [
      ...c.repositories.links,
      {
        repositoryId: "4242",
        codeHost: "gitlab" as const,
        host: "gitlab.example.com",
        ref: "main",
      },
    ],
  };
  const rows = repositoryRowsFrom(saved);
  const command = repositoryCommand(projectId, {
    key: "k",
    expectedVersion: "2",
    repositories: JSON.stringify(rows.repositories),
  });
  assert.deepEqual(command.repositories[1], {
    codeHost: "gitlab",
    host: "gitlab.example.com",
    repositoryId: "4242",
    ref: "main",
  });
  assert.deepEqual(repositoryLines({ ...c, repositories: saved }), [
    "acme/atlas · main · checkout configured · GitHub github.com",
    "4242 · main · checkout configured · GitLab gitlab.example.com",
  ]);
});

test("a named saved repository link reads by its name in summaries and change lines, an unnamed one by its ID", () => {
  const c = config(),
    link = c.repositories.links[0]!,
    named = {
      ...c,
      repositories: {
        ...c.repositories,
        links: [
          { ...link, repositoryId: "R_atlas", name: "acme/atlas" },
          { ...link, repositoryId: "R_plain", name: null },
        ],
      },
    } as ProjectConfigurationData;
  assert.deepEqual(repositoryLines(named), [
    "acme/atlas · main · checkout configured · GitHub github.com",
    "R_plain · main · checkout configured · GitHub github.com",
  ]);
  assert.equal(
    projectStateSummary(named, null, []).state[0],
    "Lead: Mira · repository access: acme/atlas, R_plain",
  );
  const rows = repositoryRowsFrom(named.repositories);
  const draft = (
    change: (r: (typeof rows.repositories)[number]) => object,
  ) => ({
    key: "k",
    expectedVersion: "2",
    repositories: JSON.stringify(
      rows.repositories.map((r) => ({ ...r, ...change(r) })),
    ),
  });
  assert.deepEqual(
    repositoryChanges(
      named.repositories,
      draft((r) => ({ ref: "dev", removed: r.repositoryId === "R_plain" })),
    ),
    ["Ref for acme/atlas: main → dev", "− Repository access: R_plain"],
  );
  assert.deepEqual(
    repositoryChanges(
      named.repositories,
      draft(() => ({ removed: true })),
    ).concat(
      repositoryChanges(named.repositories, {
        key: "k",
        expectedVersion: "2",
        repositories: "[]",
      }),
    ),
    [
      "− Repository access: acme/atlas",
      "− Repository access: R_plain",
      "− Repository access: acme/atlas (saved since this form loaded)",
      "− Repository access: R_plain (saved since this form loaded)",
    ],
  );
});

test("a new GitLab link names its project path and reads like the CLI preview; a kept one never sends it", () => {
  const c = config();
  const saved = {
    ...c.repositories,
    links: [
      {
        repositoryId: "4242",
        codeHost: "gitlab" as const,
        host: "gitlab.example.com",
        ref: "main",
      },
    ],
  };
  const gitlab = {
    codeHost: "gitlab",
    host: "gitlab.example.com",
    projectPath: "group/atlas",
    repositoryId: "9",
    ref: "main",
    path: "/lab",
  };
  const github = { repositoryId: "acme/new", ref: "main", path: "/hub" };
  const kept = {
    ...repositoryRowsFrom(saved).repositories[0],
    ref: "dev",
    removed: true,
  };
  const values = (rows: object[]) => ({
    key: "k",
    expectedVersion: "2",
    repositories: JSON.stringify(rows),
  });
  const command = repositoryCommand(projectId, values([gitlab, github]));
  assert.deepEqual(command.repositories, [
    { ...gitlab },
    { codeHost: "github", host: "github.com", ...github },
  ]);
  assert.deepEqual(
    repositoryCommand(projectId, values([{ ...kept, removed: false }]))
      .repositories,
    [
      {
        codeHost: "gitlab",
        host: "gitlab.example.com",
        repositoryId: "4242",
        ref: "dev",
      },
    ],
  );
  assert.deepEqual(repositoryChanges(saved, values([kept, gitlab])), [
    "− Repository access: 4242",
    "+ Repository access: 9 · main · GitLab gitlab.example.com",
  ]);
  assert.deepEqual(
    repositoryChanges(saved, values([{ ...kept, removed: false }])),
    ["Ref for 4242: main → dev"],
  );
});

test("no readiness rule loads no condition, saves null and never clears an unavailable rule silently", () => {
  const c = config();
  const none = { ...c.source, readiness: { kind: "none" as const } };
  const unavailable = {
    ...c.source,
    readiness: { kind: "unavailable" as const },
  };
  const label = JSON.stringify([
    { kind: "label", operator: "has", name: "ready-for-agent", rowKey: "r" },
  ]);
  for (const source of [none, unavailable]) {
    assert.deepEqual(sourceRowsFrom(source).conditions, []);
    assert.equal(sourceRowsFrom(source).mode, "all");
  }
  const base = {
    key: "k",
    expectedVersion: "4",
    mode: "all",
    conditions: "[]",
    selections: JSON.stringify(sourceRowsFrom(c.source).selections),
    referenceMode: "preserve",
  };
  const readinessLines = (source: typeof c.source, v: typeof base) =>
    sourceChanges(source, v).filter((l) => l.startsWith("Readiness"));
  // An unedited no-rule source has nothing to save; the mode alone is no rule.
  assert.deepEqual(readinessLines(none, base), []);
  assert.deepEqual(readinessLines(none, { ...base, mode: "any" }), []);
  assert.equal(sourceCommand(projectId, base).readiness, null);
  assert.deepEqual(readinessLines(none, { ...base, conditions: label }), [
    "Readiness: all of 1 condition",
  ]);
  assert.deepEqual(
    sourceCommand(projectId, { ...base, conditions: label }).readiness,
    {
      mode: "all",
      conditions: [{ kind: "label", operator: "has", name: "ready-for-agent" }],
    },
  );
  // Removing the last condition of a saved rule removes the rule.
  assert.deepEqual(readinessLines(c.source, base), [
    "Readiness: no readiness rule",
  ]);
  assert.deepEqual(
    readinessLines(unavailable, { ...base, conditions: label }),
    ["Readiness: all of 1 condition (replaces unavailable readiness)"],
  );
});

test("capacity changes name global and override edits", () => {
  const p = id();
  const data = {
    globalLimit: 4,
    defaultProjectLimit: 2,
    globalUsage: 1,
    projects: [
      {
        project: {
          id: p,
          name: "Relay",
          version: 1,
          paused: true,
          leadProfileId: null,
        },
        limit: 2,
        usage: 1,
        override: null,
        tasks: [],
      },
    ],
  } as unknown as RuntimeSettingsData;
  assert.deepEqual(
    capacityChanges(data, {
      globalLimit: "4",
      [`override-${p}`]: false,
      [`limit-${p}`]: "2",
    }),
    [],
  );
  assert.deepEqual(
    capacityChanges(data, {
      globalLimit: "1",
      [`override-${p}`]: true,
      [`limit-${p}`]: "3",
    }),
    ["Global active-turn cap: 4 → 1", "Relay: override set to 3"],
  );
});

test("settings headers, saved lines, state cards and hold pills", () => {
  const c = config();
  const workspace = {
    data: {
      projects: [{ ...c.project }],
      profiles: [c.profiles[0]],
      runtime: { state: "available" },
      harnesses: [],
      gettingStarted: { turnStarted: false, dismissed: false },
    },
    observedAt: 0,
  } as never;
  assert.deepEqual(
    settingsHeader(
      `/app/projects/${projectId}/settings`,
      "?tab=github",
      workspace,
    ),
    {
      title: "Atlas · project configuration",
      documentTitle: "Project configuration",
      trail: [
        { label: "Settings", href: "/app/settings" },
        { label: "Projects" },
        { label: "Atlas", href: `/app/projects/${projectId}/settings` },
        { label: "GitHub source" },
      ],
    },
  );
  assert.equal(
    settingsHeader(`/app/projects/${id()}/settings`, "", workspace)?.title,
    "Project · project configuration",
  );
  assert.equal(
    settingsHeader(`/app/profiles/${mira}/settings`, "", workspace)?.title,
    "Mira · agent configuration",
  );
  assert.equal(
    settingsHeader(`/app/profiles/${mira}/settings`, "", workspace)
      ?.documentTitle,
    "Agent configuration",
  );
  assert.equal(
    settingsHeader(`/app/assignments/${id()}/recovery`, "", null)?.shortTitle,
    "Recovery",
  );
  assert.equal(settingsHeader("/app/tasks", "", null), null);
  const receipt = {
    kind: "configuration",
    key: "k",
    recorded: true,
    result: {
      commandType: "project.configure",
      resourceId: projectId,
      version: 3,
    },
  } as never;
  assert.equal(savedLine(3, undefined), null);
  assert.match(
    savedLine(3, { at: Date.now(), receipt }) ?? "",
    /^Saved \d\d:\d\d$/,
  );
  // A save at another version never reads as the current one, and no version is shown.
  assert.equal(savedLine(4, { at: Date.now(), receipt }), null);
  assert.equal(joinNames(["Ada"]), "Ada");
  assert.equal(joinNames(["Ada", "Eli"]), "Ada and Eli");
  assert.equal(joinNames(["Ada", "Eli", "Bo"]), "Ada, Eli and Bo");
  const summary = projectStateSummary(c, null, []);
  assert.equal(summary.state[0], "Lead: Mira · repository access: acme/atlas");
  assert.equal(summary.next, "Nothing needs attention here.");
  // A source that is saved but not active reads inactive, and an unusable credential is the next step.
  assert.equal(summary.state[1], "GitHub S-1 active · not synced");
  assert.equal(summary.state[2], "GitHub S-3 inactive · not synced");
  const unusable = projectStateSummary(
    {
      ...c,
      source: {
        ...c.source,
        credential: { source: "env", usable: false },
      } as ProjectConfigurationData["source"],
    },
    null,
    [],
  );
  assert.equal(
    unusable.next,
    "Set or change the credential in GitHub source settings, then preview this source version.",
  );
  assert.deepEqual(
    holdPills({
      stop: false,
      task: false,
      writer: true,
      capacity: false,
      uncertainty: true,
    }).map((h) => `${h.label}: ${h.value}`),
    [
      "Operator Stop: Not active",
      "Task hold: Not recorded",
      "Writer ownership: Held",
      "Capacity: None reported",
      "Uncertainty: Active",
    ],
  );
});

test("source changes list rows saved elsewhere, flag stale kept rows and merge them on adoption", () => {
  const c = config();
  const rows = sourceRowsFrom(c.source);
  // The form loaded before S-5 was saved elsewhere, and S-3 was removed.
  const loaded = {
    selections: JSON.stringify(rows.selections),
    conditions: JSON.stringify(rows.conditions),
    mode: "all",
  };
  const latest = {
    ...c.source,
    selections: [
      c.source.selections[0],
      { id: "S-5", kind: "search", descriptor: null, active: false },
    ],
  } as ProjectConfigurationData["source"];
  assert.deepEqual(sourceChanges(latest, loaded), [
    "− S-5 · Search (saved since this form loaded)",
  ]);
  assert.deepEqual(staleSourceRows(latest, loaded), ["S-3"]);
  const adopted = { ...loaded, ...adoptSourceRows(latest, loaded) };
  assert.deepEqual(sourceChanges(latest, adopted), []);
  assert.deepEqual(staleSourceRows(latest, adopted), []);
});

test("repository changes list links saved elsewhere, flag stale kept links and merge them on adoption", () => {
  const c = config();
  const rows = repositoryRowsFrom(c.repositories);
  // The form loaded before acme/extra was saved elsewhere, and acme/atlas was removed.
  const loaded = { repositories: JSON.stringify(rows.repositories) };
  const latest = {
    version: 3,
    links: [
      {
        repositoryId: "acme/extra",
        codeHost: "github",
        host: "github.com",
        ref: "main",
      },
    ],
  } as ProjectConfigurationData["repositories"];
  assert.deepEqual(repositoryChanges(latest, loaded), [
    "− Repository access: acme/extra (saved since this form loaded)",
  ]);
  assert.deepEqual(staleRepositoryRows(latest, loaded), ["acme/atlas"]);
  const adopted = { ...loaded, ...adoptRepositoryRows(latest, loaded) };
  assert.deepEqual(repositoryChanges(latest, adopted), []);
  assert.deepEqual(staleRepositoryRows(latest, adopted), []);
});

test("adoption renumbers a new source whose id was saved elsewhere", () => {
  const c = config();
  const rows = sourceRowsFrom(c.source);
  const draft = {
    selections: JSON.stringify([
      ...rows.selections,
      { id: "S-4", kind: "search", query: "PRIVATE MINE", rowKey: "r" },
    ]),
  };
  const latest = {
    ...c.source,
    selections: [
      ...c.source.selections,
      { id: "S-4", kind: "search", descriptor: null, active: false },
    ],
  } as ProjectConfigurationData["source"];
  const adopted = JSON.parse(adoptSourceRows(latest, draft).selections);
  assert.deepEqual(
    adopted.map(
      (r: { id: string; keep?: boolean }) => `${r.id}${r.keep ? "" : " new"}`,
    ),
    ["S-1", "S-3", "S-5 new", "S-4"],
  );
});

test("adoption resolves every identity collision explicitly", () => {
  const c = config();
  const rows = sourceRowsFrom(c.source);
  const parse = (v: string) => JSON.parse(v) as Record<string, unknown>[];
  // Draft: S-3 marked removed. Elsewhere: S-1 redefined under the same id, S-3 kept.
  const draft = {
    selections: JSON.stringify([
      rows.selections[0],
      { ...rows.selections[1], removed: true },
    ]),
  };
  const latest = {
    ...c.source,
    selections: [
      { id: "S-1", kind: "search", descriptor: null, active: false },
      c.source.selections[1],
    ],
  } as ProjectConfigurationData["source"];
  const adopted = adoptSourceRows(latest, draft);
  assert.deepEqual(adopted.dropped, []);
  // Kept selections take the latest definition; the operator's removal survives.
  assert.deepEqual(
    parse(adopted.selections).map((r) => [r.id, r.kind, Boolean(r.removed)]),
    [
      ["S-1", "search", false],
      ["S-3", "project", true],
    ],
  );
});

test("repository adoption resolves every identity collision explicitly", () => {
  const c = config();
  const rows = repositoryRowsFrom(c.repositories);
  const link = (repositoryId: string, ref: string) => ({
    repositoryId,
    codeHost: "github",
    host: "github.com",
    ref,
  });
  const parse = (v: string) => JSON.parse(v) as Record<string, unknown>[];
  // Draft: ref of acme/atlas edited, acme/two kept untouched, a new link acme/new. Elsewhere:
  // acme/two ref moved, acme/new saved with its own private path, acme/gone removed.
  const draft = {
    repositories: JSON.stringify([
      { ...rows.repositories[0], ref: "dev" },
      { repositoryId: "acme/two", ref: "main", savedRef: "main", keep: true },
      { repositoryId: "acme/gone", ref: "dev", savedRef: "main", keep: true },
      {
        repositoryId: "acme/new",
        ref: "main",
        path: "/PRIVATE/MINE",
        rowKey: "n",
      },
    ]),
  };
  const latest = {
    version: 3,
    links: [
      link("acme/atlas", "release"),
      link("acme/two", "next"),
      link("acme/new", "main"),
    ],
  } as ProjectConfigurationData["repositories"];
  const adopted = adoptRepositoryRows(latest, draft);
  // The edited link removed elsewhere is named, not dropped silently.
  assert.deepEqual(adopted.dropped, ["acme/gone"]);
  const repositories = parse(adopted.repositories);
  assert.deepEqual(
    repositories.map((r) => [r.repositoryId, r.ref, Boolean(r.keep)]),
    [
      ["acme/atlas", "dev", true],
      ["acme/two", "next", true],
      ["acme/new", "main", false],
      ["acme/new", "main", true],
    ],
  );
  const values = { repositories: adopted.repositories };
  // The colliding new link blocks Save until one row is removed; nothing is replaced silently.
  assert.deepEqual(duplicateRepositoryIds(values), ["acme/new"]);
  const lines = repositoryChanges(latest, values);
  assert.ok(
    lines.includes("Ref for acme/atlas: release → dev"),
    lines.join("\n"),
  );
  assert.equal(
    lines.some((l) => l.includes("acme/two")),
    false,
  );
  const keepTheirs = {
    repositories: JSON.stringify(repositories.filter((r) => r.keep)),
  };
  assert.deepEqual(duplicateRepositoryIds(keepTheirs), []);
  const replaceTheirs = {
    repositories: JSON.stringify(
      repositories.map((r) =>
        r.keep && r.repositoryId === "acme/new" ? { ...r, removed: true } : r,
      ),
    ),
  };
  assert.deepEqual(duplicateRepositoryIds(replaceTheirs), []);
  const replaced = repositoryChanges(latest, replaceTheirs);
  assert.ok(replaced.includes("− Repository access: acme/new"));
  assert.ok(replaced.includes("+ Repository access: acme/new · main"));
  assert.deepEqual(
    duplicateSourceIds({
      selections: JSON.stringify([{ id: "S-1" }, { id: "S-1" }]),
    }),
    ["S-1"],
  );
});

test("source failure copy matches JSON and advanced HTML without provider details", () => {
  for (const reason of [
    "missing-credential",
    "invalid-credential-reference",
    "gh-not-installed",
    "gh-not-signed-in",
    "gh-unreadable",
  ] as const)
    assert.equal(
      sourceCredentialCopy(reason),
      sourceCredentialExplanation(reason),
    );
});

test("the state colours stay legible on every ground in both themes", () => {
  const blocks = themeBlocks();
  const rgb = (hex: string) =>
    [0, 2, 4].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
  const luminance = ([r, g, b]: number[]) => {
    const [lr, lg, lb] = [r, g, b].map((v) => {
      const c = (v ?? 0) / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * (lr ?? 0) + 0.7152 * (lg ?? 0) + 0.0722 * (lb ?? 0);
  };
  const contrast = (a: number[], b: number[]) => {
    const [hi = 0, lo = 0] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };
  for (const [theme, tokens] of Object.entries(blocks)) {
    const hex = (name: string) => {
      const value = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(
        tokens.get(name) ?? "",
      );
      assert.ok(value?.[1], `${theme} ${name}`);
      return {
        rgb: rgb(value[1]),
        alpha: value[2] ? Number.parseInt(value[2], 16) / 255 : 1,
      };
    };
    const grounds = ["--bg", "--surface", "--raised", "--overlay"];
    for (const state of ["attn", "risk", "run", "ok", "idle"]) {
      const text = hex(`--${state}`).rgb;
      const soft = hex(`--${state}-soft`);
      for (const ground of grounds) {
        const base = hex(ground).rgb;
        const tinted = base.map((c, i) =>
          Math.round(soft.alpha * (soft.rgb[i] ?? 0) + (1 - soft.alpha) * c),
        );
        assert.ok(
          contrast(text, base) >= 4.5,
          `${theme} ${state} on ${ground}`,
        );
        assert.ok(
          contrast(text, tinted) >= 4.5,
          `${theme} ${state} badge on ${ground}`,
        );
      }
    }
  }
});

test("the phone summary appends stored counts and points to readiness when nothing matches", () => {
  const c = config();
  const observations = (
    counts: {
      observed: number;
      open: number;
      closedSkipped: number;
      matching: number | null;
      complete: boolean;
    } | null,
  ) => ({
    projects: [
      {
        projectId,
        readiness: {
          kind: "rule" as const,
          mode: "all" as const,
          conditions: [
            { kind: "label" as const, operator: "has" as const, name: "ready" },
          ],
        },
        selections: [
          {
            selectionId: "S-1",
            state:
              counts?.complete === false
                ? ("partial" as const)
                : ("complete" as const),
            lastAttemptAt: null,
            lastSuccessfulAt: null,
            counts,
          },
        ],
      },
    ],
  });
  const zero = {
    observed: 3,
    open: 3,
    closedSkipped: 0,
    matching: 0,
    complete: true,
  };
  const warned = projectStateSummary(c, observations(zero), []);
  assert.equal(
    warned.state[1],
    "GitHub S-1 active · synced · 3 observed · 3 open · 0 match label `ready`",
  );
  assert.equal(warned.next, readinessNextStep);
  const partial = projectStateSummary(
    c,
    observations({ ...zero, complete: false }),
    [],
  );
  assert.equal(
    partial.state[1],
    "GitHub S-1 active · partial · 3 observed · 3 open · 0 match label `ready` · partial read; counts may be incomplete",
  );
  assert.equal(partial.next, "Nothing needs attention here.");
  const none = projectStateSummary(c, observations(null), []);
  assert.equal(none.state[1], "GitHub S-1 active · synced");
});

test("recovery records collapse only consecutive records that display the same state", () => {
  const record = (workId: string, generation: number, extra = {}) => ({
    workId,
    generation: { workRevision: generation, requestSequence: generation },
    binding: null,
    intentState: "completed",
    requestState: "completed",
    holds: {
      stop: false,
      task: false,
      writer: false,
      capacity: false,
      uncertainty: false,
    },
    observations: ["exact-terminal-completed"],
    pendingEffectCount: 0,
    receiptRecorded: false,
    workspace: "preserved",
    ...extra,
  });
  const r1 = record("w1", 1),
    r2 = record("w2", 2),
    r3 = record("w3", 3);
  const r4 = record("w4", 4, {
    requestState: "held",
    holds: {
      stop: false,
      task: false,
      writer: true,
      capacity: false,
      uncertainty: false,
    },
  });
  const r5 = record("w5", 5, { receiptRecorded: true });
  assert.deepEqual(recoveryRecordRuns([r1, r2, r3, r4, r5]), [
    { shown: r3, older: [r1, r2] },
    { shown: r4, older: [] },
    { shown: r5, older: [] },
  ]);
  // A record equal to an earlier run, but not adjacent to it, stays its own run.
  const r6 = record("w6", 6);
  assert.deepEqual(
    recoveryRecordRuns([r1, r4, r6]).map((run) => run.shown),
    [r1, r4, r6],
  );
  // A witness carries its own id, so it never joins a neighbour's run.
  const witness = (id: string, n: number) =>
    record(`w${n}`, n, {
      noTurnSubmission: {
        id,
        source: "operator-adopted",
        idleThreadMayExist: true,
      },
    });
  const n1 = witness(randomUUID(), 7),
    n2 = witness(randomUUID(), 8);
  assert.deepEqual(
    recoveryRecordRuns([r1, n1, n2, r2]).map((run) => run.shown),
    [r1, n1, n2, r2],
  );
  assert.deepEqual(recoveryRecordRuns([]), []);
});

test("source names read content and never private text in index lines", () => {
  const repository = { kind: "repository", descriptor: "acme/atlas" };
  assert.deepEqual(sourceName(repository), {
    name: "acme/atlas",
    kind: "repository issues",
    private: false,
  });
  const search = { kind: "search", descriptor: null };
  assert.deepEqual(sourceName(search, { query: "label:ready" }), {
    name: "label:ready",
    kind: "search",
    private: true,
  });
  // Until the private read arrives (or when it fails or is stale) a search has a neutral name.
  for (const query of [undefined, "", "   "])
    assert.deepEqual(sourceName(search, { query }), {
      name: "Saved search",
      kind: "search",
      private: false,
    });
  const project = { kind: "project", descriptor: "PVT_atlas" };
  assert.equal(sourceName(project).name, "GitHub Project");
  assert.equal(
    sourceName(project, { projectTitle: "Atlas roadmap" }).name,
    "Atlas roadmap",
  );
  // The Project node id and its filter are never part of a name.
  assert.doesNotMatch(JSON.stringify(sourceName(project)), /PVT_atlas|filter/i);
  assert.equal(
    sourceHeading(sourceName(repository)),
    "acme/atlas \u00b7 repository issues",
  );
  assert.equal(sourceHeading(sourceName(search)), "Saved search \u00b7 search");
  assert.equal(sourceHeading(sourceName(project)), "GitHub Project");
  assert.equal(
    sourceHeading(sourceName(project, { projectTitle: "Atlas roadmap" })),
    "Atlas roadmap \u00b7 GitHub Project",
  );
  assert.equal(draftSourceName({ kind: "repository" }).name, "New source");
  assert.equal(
    draftSourceName({ kind: "repository", owner: "acme", name: "atlas" }).name,
    "acme/atlas",
  );
  assert.equal(
    draftSourceName({ kind: "search", query: " " }).name,
    "New source",
  );
  const line = (s: Parameters<typeof selectionLine>[0]) => selectionLine(s);
  const saved = [
    { id: "S-1", kind: "repository", descriptor: "acme/atlas" },
    { id: "S-2", kind: "search", descriptor: null },
    { id: "S-3", kind: "project", descriptor: "PVT_atlas" },
  ] as const;
  assert.deepEqual(
    saved.map((s) => line({ ...s, active: false })),
    [
      "S-1 acme/atlas issues \u00b7 inactive",
      "S-2 search \u00b7 inactive",
      "S-3 GitHub Project \u00b7 inactive",
    ],
  );
  assert.equal(line({ ...saved[0], active: true }), "S-1 acme/atlas issues");
  for (const s of saved)
    assert.doesNotMatch(line({ ...s, active: false }), /PRIVATE|PVT_|filter/);
});

test("source status lines are sentences with the clock label", () => {
  const at = "2026-10-16T18:45:00.000Z",
    time = clockLabel(Date.parse(at));
  const rule = {
    kind: "rule" as const,
    mode: "all" as const,
    conditions: [
      { kind: "label" as const, operator: "has" as const, name: "ready" },
    ],
  };
  const counts = (observed: number, matching: number | null) => ({
    observed,
    open: observed,
    closedSkipped: 0,
    matching,
    complete: true,
  });
  const row = (
    state: "complete" | "partial" | "never" | "unavailable",
    over: Record<string, unknown> = {},
  ) =>
    ({
      selectionId: "S-1",
      state,
      lastAttemptAt: at,
      lastSuccessfulAt: state === "complete" ? at : null,
      counts: counts(4, 2),
      ...over,
    }) as Parameters<typeof sourceStatusLine>[0];
  assert.equal(
    sourceStatusLine(row("complete"), rule),
    `Synced ${time} \u00b7 4 issues observed, 2 match the readiness rule`,
  );
  assert.equal(
    sourceStatusLine(row("complete", { counts: counts(1, 1) }), rule),
    `Synced ${time} \u00b7 1 issue observed, 1 match the readiness rule`,
  );
  assert.equal(
    sourceStatusLine(row("complete"), { kind: "none" }),
    `Synced ${time} \u00b7 4 issues observed, no readiness rule`,
  );
  assert.equal(
    sourceStatusLine(row("complete", { counts: counts(4, null) }), rule),
    `Synced ${time} \u00b7 4 issues observed`,
  );
  assert.equal(
    sourceStatusLine(row("complete", { counts: null }), rule),
    `Synced ${time}`,
  );
  assert.equal(
    sourceStatusLine(row("complete", { lastSuccessfulAt: null }), rule),
    "Synced \u00b7 4 issues observed, 2 match the readiness rule",
  );
  assert.equal(
    sourceStatusLine(row("partial"), rule),
    `Partly synced ${time} \u00b7 4 issues observed so far`,
  );
  assert.equal(sourceStatusLine(row("never"), rule), "Not synced yet");
  assert.equal(sourceStatusLine(undefined, rule), "Not synced yet");
  assert.equal(
    sourceStatusLine(row("unavailable"), rule),
    "Sync state can't be read right now",
  );
  // A state this build does not know reads as the unreadable sentence, never the raw word.
  assert.equal(
    sourceStatusLine(row("later-state" as never), rule),
    "Sync state can't be read right now",
  );
  for (const state of ["complete", "partial", "never", "unavailable"] as const)
    assert.doesNotMatch(
      sourceStatusLine(row(state), rule),
      /unavailable|null|\d{4}-\d{2}-\d{2}T/,
    );
  assert.equal(observationLabel(row("unavailable")), "Sync unknown");
  assert.equal(observationLabel(row("complete")), `Synced ${time}`);
});

test("command network access reads the saved setting, what applies and what it exposes", () => {
  assert.equal(
    projectCommandNetworkLine(false),
    "Command network access is disabled for this project.",
  );
  assert.equal(
    projectCommandNetworkLine(true),
    "Command network access is enabled for this project's Codex turns; Claude Code turns keep it denied.",
  );
  assert.equal(
    commandNetworkAppliesNote,
    "Applies to turns admitted after the change; running turns keep their policy.",
  );
  assert.equal(
    commandNetworkDisclosure,
    "Network-enabled commands can reach whatever credentials and logins the host exposes.",
  );
});

test("diagnostic capture reads the saved mode, when a change applies and that stored diagnostics stay", () => {
  assert.equal(
    diagnosticCaptureLine("enhanced"),
    "Diagnostic capture is enhanced for this project.",
  );
  assert.equal(
    diagnosticCaptureLine("baseline"),
    "Diagnostic capture is baseline for this project.",
  );
  assert.equal(
    diagnosticCaptureLine(undefined),
    "The service does not report this project's mode, so it cannot be changed here.",
  );
  assert.equal(
    diagnosticCaptureAppliesNote,
    "A change applies to executions started afterwards and erases no stored diagnostics.",
  );
});

test("opaque saved source and repository rows are kept by default removed explicitly and restored by discard", () => {
  const c = config();
  const sourceReference = {
    projectId,
    section: "source" as const,
    version: 4,
    index: 0,
  };
  const repositoryReference = {
    projectId,
    section: "repositories" as const,
    version: 2,
    index: 0,
  };
  const source = {
    ...c.source,
    readiness: { kind: "unavailable" as const },
    selections: [
      {
        id: null,
        kind: "search" as const,
        descriptor: null,
        active: false,
        savedRow: sourceReference,
      },
      c.source.selections[0]!,
    ],
  };
  const saved = {
    ...c.repositories,
    links: [
      {
        codeHost: "gitlab" as const,
        host: null,
        repositoryId: null,
        ref: null,
        savedRow: repositoryReference,
      },
      c.repositories.links[0]!,
    ],
  };
  const loaded = sourceRowsFrom(source),
    links = repositoryRowsFrom(saved);
  assert.equal(loaded.incomplete, false);
  assert.equal(links.incomplete, false);
  const values = {
    key: "k",
    expectedVersion: "4",
    selections: JSON.stringify(loaded.selections),
    conditions: "[]",
    preserveReadiness: true,
    repositories: JSON.stringify(links.repositories),
  };
  assert.deepEqual(sourceCommand(projectId, values).selections[0], {
    savedRow: sourceReference,
    keep: true,
  });
  assert.equal(
    Object.hasOwn(sourceCommand(projectId, values), "readiness"),
    false,
  );
  assert.deepEqual(repositoryCommand(projectId, values).repositories[0], {
    savedRow: repositoryReference,
    keep: true,
  });
  assert.deepEqual(sourceChanges(source, values), []);
  assert.deepEqual(repositoryChanges(saved, values), []);
  const removed = {
    ...values,
    selections: JSON.stringify(
      loaded.selections.map((row, index) =>
        index === 0 ? { ...row, removed: true } : row,
      ),
    ),
    repositories: JSON.stringify(
      links.repositories.map((row, index) =>
        index === 0 ? { ...row, removed: true } : row,
      ),
    ),
  };
  assert.deepEqual(sourceChanges(source, removed), [
    "− Unavailable saved source",
  ]);
  assert.deepEqual(repositoryChanges(saved, removed), [
    "− Unavailable saved repository link",
  ]);
  assert.equal(sourceCommand(projectId, removed).selections.length, 1);
  assert.equal(repositoryCommand(projectId, removed).repositories.length, 1);
  assert.deepEqual(sourceCommand(projectId, values).selections[0], {
    savedRow: sourceReference,
    keep: true,
  });
  assert.deepEqual(repositoryCommand(projectId, values).repositories[0], {
    savedRow: repositoryReference,
    keep: true,
  });
  assert.equal(JSON.stringify(loaded.selections[0]).includes('"id"'), false);
  assert.equal(
    JSON.stringify(links.repositories[0]).includes('"repositoryId"'),
    false,
  );
});

test("opaque adoption never transfers a removal to the same ordinal of a newer snapshot", () => {
  const c = config();
  const source = {
    ...c.source,
    selections: [
      {
        id: null,
        kind: "search" as const,
        descriptor: null,
        active: false,
        savedRow: {
          projectId,
          section: "source" as const,
          version: 4,
          index: 0,
        },
      },
    ],
  };
  const saved = {
    ...c.repositories,
    links: [
      {
        codeHost: "gitlab" as const,
        host: null,
        repositoryId: null,
        ref: null,
        savedRow: {
          projectId,
          section: "repositories" as const,
          version: 2,
          index: 0,
        },
      },
    ],
  };
  const values = {
    selections: JSON.stringify(
      sourceRowsFrom(source).selections.map((row) => ({
        ...row,
        removed: true,
      })),
    ),
    repositories: JSON.stringify(
      repositoryRowsFrom(saved).repositories.map((row) => ({
        ...row,
        removed: true,
      })),
    ),
  };
  const latestSource = {
    ...source,
    version: 5,
    selections: source.selections.map((row) => ({
      ...row,
      savedRow: { ...row.savedRow, version: 5 },
    })),
  };
  const latestLinks = {
    ...saved,
    version: 3,
    links: saved.links.map((row) => ({
      ...row,
      savedRow: { ...row.savedRow, version: 3 },
    })),
  };
  const adopted = adoptSourceRows(latestSource, values),
    repositories = adoptRepositoryRows(latestLinks, values);
  assert.deepEqual(adopted.dropped, ["Unavailable saved source"]);
  assert.deepEqual(repositories.dropped, ["Unavailable saved repository link"]);
  assert.equal(parseRows(adopted.selections)[0]!.removed, undefined);
  assert.equal(parseRows(repositories.repositories)[0]!.removed, undefined);
  assert.equal(
    JSON.parse(String(parseRows(adopted.selections)[0]!.savedRow)).version,
    5,
  );
  assert.equal(
    JSON.parse(String(parseRows(repositories.repositories)[0]!.savedRow))
      .version,
    3,
  );
});

test("Jira placeholders coexist with visible query edits without importing withheld identities from private reads", () => {
  const c = config();
  const reference = {
    projectId,
    section: "source" as const,
    version: 4,
    index: 0,
  };
  const source = {
    ...c.source,
    tracker: "jira" as const,
    selections: [
      {
        id: null,
        kind: "jql" as const,
        descriptor: null,
        active: true,
        savedRow: reference,
      },
      {
        id: "visible",
        kind: "jql" as const,
        descriptor: null,
        active: true,
        savedRow: { ...reference, index: 1 },
      },
    ],
  };
  const known = {
    jql: [
      { id: "PRIVATE HIDDEN ID", jql: "PRIVATE HIDDEN QUERY" },
      { id: "visible", jql: "project = VISIBLE" },
    ],
  };
  const loaded = jiraRowsFrom(source, known);
  assert.equal(loaded.incomplete, false);
  assert.equal(
    jiraRowsFrom({
      ...source,
      selections: source.selections.map(
        ({ savedRow: _reference, ...row }) => row,
      ),
    }).incomplete,
    true,
  );
  assert.equal(loaded.jql, "project = VISIBLE");
  assert.deepEqual(loaded.jqlIds, ["visible"]);
  assert.equal(JSON.stringify(loaded).includes("PRIVATE"), false);
  const edited = jiraSelections(source, {
    ...loaded,
    jql: "project = EDITED\nproject = NEW",
  });
  const added = edited[2]!;
  assert.ok("id" in added);
  assert.match(added.id, /^[0-9a-f-]{36}$/);
  assert.deepEqual(edited, [
    { savedRow: reference, keep: true },
    { id: "visible", kind: "jql", jql: "project = EDITED" },
    { id: added.id, kind: "jql", jql: "project = NEW" },
  ]);
  assert.equal(parseRows(jiraRowsFrom(source).selections).length, 2);
  const removed = {
    ...loaded,
    selections: JSON.stringify(
      parseRows(loaded.selections).map((row) => ({ ...row, removed: true })),
    ),
  };
  assert.deepEqual(jiraSelections(source, removed), [
    { id: "visible", kind: "jql", jql: "project = VISIBLE" },
  ]);
  const latest = {
    ...source,
    version: 5,
    selections: source.selections.map((row) => ({
      ...row,
      savedRow: { ...row.savedRow, version: 5 },
    })),
  };
  const adopted = adoptJiraRows(
    latest,
    { ...removed, jql: "project = EDITED" },
    known,
  );
  assert.equal(adopted.dropped, 1);
  assert.equal(adopted.jql, "project = EDITED");
  assert.equal(parseRows(adopted.selections)[0]!.removed, undefined);
});

test("Jira review retains query deletions and edits while adding only newly saved identities", () => {
  const source = {
    ...config().source,
    tracker: "jira" as const,
    selections: ["S-1", "S-2", "S-3"].map((id) => ({
      id,
      kind: "jql" as const,
      descriptor: null,
      active: true,
    })),
  };
  const known = {
    jql: source.selections.map(({ id }) => ({ id, jql: `project = ${id}` })),
  };
  for (const jql of ["project = EDITED", ""]) {
    const adopted = adoptJiraRows(
      source,
      {
        selections: "[]",
        jqlIds: ["S-1", "S-2"],
        jql,
      },
      known,
    );
    assert.equal(
      adopted.jql,
      [jql, "project = S-3"].filter(Boolean).join("\n"),
    );
    assert.deepEqual(adopted.jqlIds, jql ? ["S-1", "S-3"] : ["S-3"]);
    assert.equal(adopted.dropped, 0);
  }
});

test("Jira deletion intent survives successive conflicts and still adopts newly saved queries", () => {
  const source = {
    ...config().source,
    tracker: "jira" as const,
    selections: ["S-1", "S-2"].map((id) => ({
      id,
      kind: "jql" as const,
      descriptor: null,
      active: true,
    })),
  };
  const known = {
    jql: source.selections.map(({ id }) => ({ id, jql: `project = ${id}` })),
  };
  for (const jql of ["project = EDITED", ""]) {
    const { dropped: _firstDropped, ...first } = adoptJiraRows(
      source,
      {
        selections: "[]",
        jqlIds: ["S-1", "S-2"],
        jql,
      },
      known,
    );
    const { dropped: _secondDropped, ...second } = adoptJiraRows(
      source,
      first,
      known,
    );
    assert.deepEqual(second.jqlIds, first.jqlIds);
    assert.equal(second.jql, jql);
    const latest = {
      ...source,
      selections: [
        ...source.selections,
        { ...source.selections[0]!, id: "S-3" },
      ],
    };
    const latestKnown = {
      jql: [...known.jql, { id: "S-3", jql: "project = NEW" }],
    };
    const { dropped: _thirdDropped, ...third } = adoptJiraRows(
      latest,
      second,
      latestKnown,
    );
    assert.deepEqual(third.jqlIds, jql ? ["S-1", "S-3"] : ["S-3"]);
    assert.equal(third.jql, [jql, "project = NEW"].filter(Boolean).join("\n"));
    const { dropped: _fourthDropped, ...fourth } = adoptJiraRows(
      latest,
      third,
      latestKnown,
    );
    assert.deepEqual(
      jiraSelections(latest, fourth),
      jiraSelections(latest, third),
    );
  }
});

test("Jira review while private queries load does not keep an explicit identity twice or restore its deletion", () => {
  const source = {
    ...config().source,
    tracker: "jira" as const,
    selections: ["S-1", "S-2"].map((id, index) => ({
      id,
      kind: "jql" as const,
      descriptor: null,
      active: true,
      savedRow: { projectId, section: "source" as const, version: 4, index },
    })),
  };
  const { dropped: _dropped, ...adopted } = adoptJiraRows(source, {
    selections: "[]",
    jqlIds: ["S-1", "S-2"],
    jql: "project = EDITED",
  });
  assert.deepEqual(jiraSelections(source, adopted), [
    { id: "S-1", kind: "jql", jql: "project = EDITED" },
  ]);
  // A formerly public deletion cannot remove a now-opaque row by position.
  const hidden = {
    ...source,
    selections: source.selections.map((row, index) =>
      index === 1 ? { ...row, id: null } : row,
    ),
  };
  const { dropped, ...reviewed } = adoptJiraRows(hidden, adopted);
  assert.equal(dropped, 1);
  assert.deepEqual(reviewed.removedJqlIds, []);
  assert.deepEqual(jiraSelections(hidden, reviewed), [
    { savedRow: source.selections[1]!.savedRow, keep: true },
    { id: "S-1", kind: "jql", jql: "project = EDITED" },
  ]);
});

test("source identity allocation stays independent of hidden IDs during additions and conflict renumbering", () => {
  assert.match(nextSelectionId([null], []), /^[0-9a-f-]{36}$/);
  const source = {
    ...config().source,
    selections: [
      {
        id: null,
        kind: "search" as const,
        descriptor: null,
        active: false,
        savedRow: {
          projectId,
          section: "source" as const,
          version: 4,
          index: 0,
        },
      },
      { id: "S-1", kind: "search" as const, descriptor: null, active: false },
    ],
  };
  const adopted = parseRows(
    adoptSourceRows(source, {
      selections: JSON.stringify([
        { id: "S-1", kind: "search", query: "new query" },
      ]),
    }).selections,
  );
  const added = adopted.find((row) => row.query === "new query")!;
  assert.match(String(added.id), /^[0-9a-f-]{36}$/);
  assert.ok(adopted.some((row) => row.unavailable));
  assert.ok(adopted.some((row) => row.keep && row.id === "S-1"));
});

test("conflict adoption reallocates unsaved identities when every latest identity is withheld", () => {
  const source = {
    ...config().source,
    selections: [
      {
        id: null,
        kind: "search" as const,
        descriptor: null,
        active: false,
        savedRow: {
          projectId,
          section: "source" as const,
          version: 4,
          index: 0,
        },
      },
    ],
  };
  let values = {
    selections: JSON.stringify([
      { id: "S-1", kind: "search", query: "first", rowKey: "first" },
      { id: "S-2", kind: "search", query: "second", rowKey: "second" },
    ]),
  };
  for (const version of [4, 5]) {
    const latest = {
      ...source,
      version,
      selections: source.selections.map((row) => ({
        ...row,
        savedRow: { ...row.savedRow, version },
      })),
    };
    values = { selections: adoptSourceRows(latest, values).selections };
    const rows = parseRows(values.selections);
    const unsaved = rows.filter((row) => !row.keep);
    assert.equal(unsaved.length, 2);
    assert.deepEqual(
      unsaved.map((row) => row.rowKey),
      ["first", "second"],
    );
    assert.deepEqual(
      unsaved.map((row) => row.query),
      ["first", "second"],
    );
    for (const row of unsaved) assert.match(String(row.id), /^[0-9a-f-]{36}$/);
    assert.equal(new Set(unsaved.map((row) => row.id)).size, 2);
    assert.equal(rows.filter((row) => row.unavailable && row.keep).length, 1);
  }
});

test("opaque row identity cannot alias a visible id containing the serialized reference", () => {
  const c = config();
  const reference = {
    projectId,
    section: "source" as const,
    version: 4,
    index: 0,
  };
  const id = JSON.stringify(reference);
  const source = {
    ...c.source,
    selections: [
      {
        id: null,
        kind: "search" as const,
        descriptor: null,
        active: false,
        savedRow: reference,
      },
      { id, kind: "search" as const, descriptor: null, active: false },
    ],
  };
  const loaded = sourceRowsFrom(source);
  const values = {
    selections: JSON.stringify(
      loaded.selections.map((row, index) =>
        index === 0 ? { ...row, removed: true } : row,
      ),
    ),
  };
  const adopted = parseRows(adoptSourceRows(source, values).selections);
  assert.equal(adopted.length, 2);
  assert.equal(adopted[0]!.unavailable, true);
  assert.equal(adopted[0]!.removed, true);
  assert.equal(adopted[1]!.id, id);
  assert.equal(adopted[1]!.unavailable, undefined);
  assert.ok(
    sourceChanges(source, { selections: "[]", conditions: "[]" }).includes(
      "− Unavailable saved source (saved since this form loaded)",
    ),
  );
  const repositories = {
    ...c.repositories,
    links: [
      {
        codeHost: "gitlab" as const,
        host: null,
        ref: null,
        repositoryId: null,
        savedRow: { ...reference, section: "repositories" as const },
      },
    ],
  };
  assert.deepEqual(repositoryChanges(repositories, { repositories: "[]" }), [
    "− Unavailable saved repository link (saved since this form loaded)",
  ]);
});

test("starter option names actual runtimes and fails closed for unknown or incomplete readiness", () => {
  const workspace = {
    harnesses: ["codex", "claude"].map((harness) => ({
      harness,
      enabled: true,
      state: "available",
    })),
  } as Workspace["data"];
  for (const lead of ["codex", "claude"] as const) {
    const alternate = lead === "codex" ? "claude" : "codex";
    const checks = (
      alternate === "claude"
        ? ["claude-executable", "claude-token"]
        : ["codex-executable", "codex-login"]
    ).map((id) => ({
      id,
      status: "pass",
      label: id,
      reason: null,
      fix: null,
    })) as import("../../src/operator/readiness.js").ReadinessCheck[];
    assert.equal(
      starterReviewerHarness(lead, workspace, { state: "ready", checks }),
      alternate,
    );
    for (const readiness of [
      { state: "loading" },
      { state: "unavailable" },
      { state: "ready", checks: checks.slice(0, 1) },
    ] as const)
      assert.equal(starterReviewerHarness(lead, workspace, readiness), lead);
    assert.equal(
      starterReviewerHarness(
        lead,
        { ...workspace, harnesses: [] },
        { state: "ready", checks },
      ),
      lead,
    );
  }
  assert.equal(
    starterOptionCopy("codex", "claude"),
    "Adds Implementer (Codex) and Reviewer (Claude)",
  );
  assert.equal(
    starterOptionCopy("claude", "codex"),
    "Adds Implementer (Claude) and Reviewer (Codex)",
  );
  assert.equal(
    starterOptionCopy("codex", "codex"),
    "Adds Implementer (Codex) and Reviewer (Codex)",
  );
  assert.equal(
    starterOptionCopy("claude", "claude"),
    "Adds Implementer (Claude) and Reviewer (Claude)",
  );
});
