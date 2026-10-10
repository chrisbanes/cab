import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import {
  adoptSourceRows,
  capacityChanges,
  nextSelectionId,
  profileChanges,
  projectChanges,
  removesAllAccess,
  routingChanges,
  routingCommand,
  sourceChanges,
  sourceCommand,
  sourceRowsFrom,
  staleSourceRows,
  type ProfileConfigurationData,
  type ProjectConfigurationData,
  type RuntimeSettingsData,
} from "../web/src/settings-changes.js";
import {
  holdPills,
  projectStateSummary,
  savedLine,
  settingsHeader,
} from "../web/src/settings-view.js";

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
        mode: "all",
        conditions: [{ kind: "label", name: "ready" }],
      },
      repositories: [{ repositoryId: "acme/atlas", ref: "main" }],
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
      replaceInstructions: true,
      instructions: "PRIVATE",
    }),
    [
      "Project name: Atlas → Atlas II",
      "Lead profile: Mira → Jonas",
      "Pause project",
      "Instructions replaced (private, not shown after saving)",
    ],
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
});

test("routing lines and command keep guidance out unless replaced", () => {
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
      replaceGuidance: true,
      referenceMode: "set",
    }),
    [
      "Routing enabled",
      "Candidate added: Mira",
      "Guidance replaced (private, not shown after saving)",
      "Credential reference: set new environment reference",
    ],
  );
  const command = routingCommand(projectId, {
    key: "k",
    expectedVersion: "2",
    enabled: true,
    candidateProfileIds: [worker],
    guidance: "PRIVATE",
  });
  assert.equal("guidance" in command, false);
});

test("source rows, change lines and command use keep markers and never paths", () => {
  const c = config();
  const rows = sourceRowsFrom(c.source);
  assert.equal(rows.incomplete, false);
  assert.deepEqual(rows.repositories, [
    { repositoryId: "acme/atlas", ref: "main", keep: true },
  ]);
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
    repositories: JSON.stringify([
      {
        ...rows.repositories[0],
        ref: "dev",
        replacePath: true,
        path: "/PRIVATE",
      },
    ]),
    referenceMode: "clear",
  };
  const lines = sourceChanges(c.source, values);
  assert.deepEqual(lines, [
    "− S-3 · GitHub Project PVT_x",
    "+ S-4 · Search (query private) · added inactive",
    "Readiness: any of 1 condition",
    "Ref for acme/atlas: main → dev",
    "Local path replaced for acme/atlas (private)",
    "Credential reference: cleared",
  ]);
  assert.equal(lines.join(" ").includes("PRIVATE"), false);
  const command = sourceCommand(projectId, values);
  assert.deepEqual(command.selections, [
    { id: "S-1", keep: true },
    { id: "S-4", kind: "search", query: "PRIVATE QUERY" },
  ]);
  assert.deepEqual(command.repositories, [
    { repositoryId: "acme/atlas", ref: "dev", path: "/PRIVATE" },
  ]);
  assert.deepEqual(
    sourceCommand(projectId, {
      ...values,
      repositories: JSON.stringify(rows.repositories),
    }).repositories,
    [{ repositoryId: "acme/atlas", ref: "main" }],
  );
  assert.equal(removesAllAccess(c.source, { repositories: "[]" }), true);
  assert.equal(
    removesAllAccess(c.source, {
      repositories: JSON.stringify([
        { ...rows.repositories[0], removed: true },
      ]),
    }),
    true,
  );
  assert.equal(
    removesAllAccess({ ...c.source, repositories: [] }, { repositories: "[]" }),
    false,
  );
  assert.equal(
    removesAllAccess(c.source, {
      repositories: JSON.stringify(rows.repositories),
    }),
    false,
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
    "Mira · profile configuration",
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
  assert.equal(savedLine("General", 3, undefined), "General version 3");
  assert.match(
    savedLine("General", 3, { at: Date.now(), receipt }),
    /^General saved \d\d:\d\d$/,
  );
  assert.equal(
    savedLine("General", 4, { at: Date.now(), receipt }),
    "General version 4",
  );
  const summary = projectStateSummary(c, null, []);
  assert.equal(summary.state[0], "Lead: Mira · repository access: acme/atlas");
  assert.equal(summary.next, "Nothing needs attention here.");
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
  // The form loaded before S-5 and a second link were saved elsewhere, and S-3 was removed.
  const loaded = {
    selections: JSON.stringify(rows.selections),
    repositories: JSON.stringify(rows.repositories),
    conditions: JSON.stringify(rows.conditions),
    mode: "all",
  };
  const latest = {
    ...c.source,
    selections: [
      c.source.selections[0],
      { id: "S-5", kind: "search", descriptor: null, active: false },
    ],
    repositories: [
      ...c.source.repositories,
      { repositoryId: "acme/extra", ref: "main" },
    ],
  } as ProjectConfigurationData["source"];
  assert.deepEqual(sourceChanges(latest, loaded), [
    "− S-5 · Search (saved since this form loaded)",
    "− Repository access: acme/extra (saved since this form loaded)",
  ]);
  assert.deepEqual(staleSourceRows(latest, loaded), ["S-3"]);
  const adopted = { ...loaded, ...adoptSourceRows(latest, loaded) };
  assert.deepEqual(sourceChanges(latest, adopted), []);
  assert.deepEqual(staleSourceRows(latest, adopted), []);
});

test("adoption renumbers a new source whose id was saved elsewhere", () => {
  const c = config();
  const rows = sourceRowsFrom(c.source);
  const draft = {
    selections: JSON.stringify([
      ...rows.selections,
      { id: "S-4", kind: "search", query: "PRIVATE MINE", rowKey: "r" },
    ]),
    repositories: JSON.stringify(rows.repositories),
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
