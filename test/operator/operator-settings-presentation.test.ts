import { sourceCredentialExplanation } from "../../src/standalone/github-source-credential.js";
import { sourceCredentialCopy } from "../../web/src/settings-view.js";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
  duplicateSourceIds,
  type ProfileConfigurationData,
  type ProjectConfigurationData,
  type RuntimeSettingsData,
} from "../../web/src/settings-changes.js";
import {
  holdPills,
  projectStateSummary,
  joinNames,
  savedLine,
  settingsHeader,
} from "../../web/src/settings-view.js";

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
      guidance: "PRIVATE",
    },
    c,
  );
  assert.equal("guidance" in command, false);
});

test("source rows, change lines and command use keep markers and never paths", () => {
  const c = config();
  const rows = sourceRowsFrom(c.source);
  assert.equal(rows.incomplete, false);
  assert.deepEqual(rows.repositories, [
    { repositoryId: "acme/atlas", ref: "main", savedRef: "main", keep: true },
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

test("adoption resolves every identity collision explicitly", () => {
  const c = config();
  const rows = sourceRowsFrom(c.source);
  const repo = (id: string, ref: string) => ({ repositoryId: id, ref });
  const parse = (v: string) => JSON.parse(v) as Record<string, unknown>[];
  // Draft: ref of acme/atlas edited, acme/two kept untouched, a new link acme/new and S-3
  // marked removed. Elsewhere: acme/two ref moved, acme/new saved with its own private path,
  // S-1 redefined under the same id, S-3 kept, acme/gone removed.
  const draft = {
    selections: JSON.stringify([
      rows.selections[0],
      { ...rows.selections[1], removed: true },
    ]),
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
    ...c.source,
    selections: [
      { id: "S-1", kind: "search", descriptor: null, active: false },
      c.source.selections[1],
    ],
    repositories: [
      repo("acme/atlas", "release"),
      repo("acme/two", "next"),
      repo("acme/new", "main"),
    ],
  } as ProjectConfigurationData["source"];
  const adopted = adoptSourceRows(latest, draft);
  // The edited link removed elsewhere is named, not dropped silently.
  assert.deepEqual(adopted.dropped, ["acme/gone"]);
  const selections = parse(adopted.selections);
  // Kept selections take the latest definition; the operator's removal survives.
  assert.deepEqual(
    selections.map((r) => [r.id, r.kind, Boolean(r.removed)]),
    [
      ["S-1", "search", false],
      ["S-3", "project", true],
    ],
  );
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
  const { dropped: _dropped, ...rowsOnly } = adopted;
  const values = {
    ...rowsOnly,
    conditions: JSON.stringify(rows.conditions),
    mode: "all",
  };
  // The colliding new link blocks Save until one row is removed; nothing is replaced silently.
  assert.deepEqual(duplicateSourceIds(values), ["acme/new"]);
  const lines = sourceChanges(latest, values);
  assert.ok(
    lines.includes("Ref for acme/atlas: release → dev"),
    lines.join("\n"),
  );
  assert.equal(
    lines.some((l) => l.includes("acme/two")),
    false,
  );
  const keepTheirs = {
    ...values,
    repositories: JSON.stringify(repositories.filter((r) => r.keep)),
  };
  assert.deepEqual(duplicateSourceIds(keepTheirs), []);
  const replaceTheirs = {
    ...values,
    repositories: JSON.stringify(
      repositories.map((r) =>
        r.keep && r.repositoryId === "acme/new" ? { ...r, removed: true } : r,
      ),
    ),
  };
  assert.deepEqual(duplicateSourceIds(replaceTheirs), []);
  const replaced = sourceChanges(latest, replaceTheirs);
  assert.ok(replaced.includes("− Repository access: acme/new"));
  assert.ok(replaced.includes("+ Repository access: acme/new · main"));
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

test("the warning colours stay legible on the page and on a warning alert", () => {
  const css = readFileSync(
    new URL("../../../web/src/tokens.css", import.meta.url),
    "utf8",
  );
  const token = (name: string) =>
    new RegExp(`${name}:\\s*#([0-9a-f]{6})([0-9a-f]{2})?;`, "i").exec(css);
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
  const fg = token("--nova-warning-fg"),
    bg = token("--nova-warning-bg"),
    page = token("--background"),
    card = token("--card");
  assert.ok(fg?.[1] && bg?.[1] && bg[2] && page?.[1] && card?.[1]);
  const alpha = Number.parseInt(bg[2], 16) / 255;
  const surface = rgb(card[1]).map((c, i) =>
    Math.round(alpha * (rgb(bg[1] as string)[i] ?? 0) + (1 - alpha) * c),
  );
  assert.ok(contrast(rgb(fg[1]), rgb(page[1])) >= 4.5, "text on the page");
  assert.ok(contrast(rgb(fg[1]), surface) >= 4.5, "text on a warning alert");
});
