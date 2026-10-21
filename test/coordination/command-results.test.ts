import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type DomainCommandOutcome,
  type DomainCommandResultMap,
  parseDomainCommandOutcome,
  parseFreshDomainCommandOutcome,
} from "../../src/core/command-results.js";
import type { DomainCommand } from "../../src/core/domain.js";

const projectId = "10000000-0000-4000-8000-000000000001";
const profileId = "20000000-0000-4000-8000-000000000001";
const taskId = "30000000-0000-4000-8000-000000000001";
const assignmentId = "40000000-0000-4000-8000-000000000001";

const project: DomainCommandResultMap["project.create"] = {
  id: projectId,
  name: "Project",
  version: 1,
  paused: 0,
  leadProfileId: null,
  instructionsRevision: 1,
  instructions: "",
};
const task: DomainCommandResultMap["task.create"] = {
  id: taskId,
  projectId,
  version: 1,
  outcome: "",
  ready: 0,
  state: "open",
  importedBlockers: "clear",
  title: "Task",
};
const profile: DomainCommandResultMap["profile.create"] = {
  id: profileId,
  version: 1,
  name: "Profile",
  summary: "",
  instructions: "",
  capabilities: "",
  revoked: 0,
};
const assignment: DomainCommandResultMap["assignment.create"] = {
  id: assignmentId,
  taskId,
  projectId,
  version: 1,
  profileId,
  profileRevision: 1,
  instructionsRevision: 1,
  brief: "",
  resultDestination: "lead",
  requesterAssignmentId: null,
  resultRecipientAssignmentId: null,
  resultRecipientDisposition: "unresolved",
  state: "pending",
};
const capacity: DomainCommandResultMap["capacity.configure"] = {
  globalLimit: 1,
  defaultProjectLimit: 2,
  projectOverrides: {},
  currentUsage: { global: 0, projects: {} },
  effectiveProjectLimits: {},
};
const github: DomainCommandResultMap["github.configure"] = {
  version: 1,
  credentialRef: null,
  selections: [],
  readiness: { mode: "all", conditions: [{ kind: "label", name: "ready" }] },
  closedIssues: "skip",
  repositories: [],
};

const cases = {
  "delivery.configure": {
    mode: "reviewable-pr",
    grants: [],
    requiredChecks: [],
    version: 1,
    credentialConfigured: false,
  },
  "project.create": project,
  "project.configure": project,
  "task.create": task,
  "task.configure": task,
  "profile.create": profile,
  "profile.configure": profile,
  "routing.configure": {
    projectId,
    version: 1,
    enabled: 0,
    guidance: "",
    credentialAvailable: 0,
    candidateProfileIds: "[]",
  },
  "github.configure": github,
  "status-mapping.configure": {
    version: 2,
    mapping: {
      selectionId: "selection",
      projectNodeId: "P1",
      fieldNodeId: "F1",
      events: { turnStarted: "O1", handedBack: null, held: null, done: null },
    },
  },
  "github.activate": {
    projectId,
    selectionId: "selection",
    configVersion: 1,
    active: true,
    alreadyActive: false,
  },
  "github.place": task,
  "source.review": task,
  "assignment.create": assignment,
  "assignment.apply": assignment,
  "dependency.add": task,
  "dependency.remove": task,
  "imported-blockers.set": task,
  "capacity.configure": capacity,
  "discovery.configure": { configured: false },
  "claude-token.configure": { configured: false },
  "getting-started.configure": { dismissed: false },
  "runtime.configure": { harness: "claude", enabled: false },
} satisfies { [K in DomainCommand["type"]]: DomainCommandResultMap[K] };

test("validates one concrete result shape for every domain command", () => {
  for (const [type, result] of Object.entries(cases) as [
    DomainCommand["type"],
    unknown,
  ][]) {
    assert.deepEqual(parseDomainCommandOutcome(type, result), {
      type,
      result,
    });
  }
});

test("preserves nullable values, zero SQLite flags, and original JSON fields", () => {
  const zeroFlagTask = { ...task, ready: 0 };
  const parsed = parseDomainCommandOutcome("task.create", zeroFlagTask);
  assert.equal(parsed.type, "task.create");
  if (parsed.type === "task.create") {
    assert.equal(parsed.result.ready, 0);
    assert.equal(parsed.result.outcome, "");
  }

  const parsedProject = parseDomainCommandOutcome("project.create", project);
  assert.equal(parsedProject.type, "project.create");
  if (parsedProject.type === "project.create")
    assert.equal(parsedProject.result.leadProfileId, null);
  const parsedAssignment = parseDomainCommandOutcome(
    "assignment.create",
    assignment,
  );
  assert.equal(parsedAssignment.type, "assignment.create");
  if (parsedAssignment.type === "assignment.create")
    assert.equal(parsedAssignment.result.requesterAssignmentId, null);
  const configured = {
    ...github,
    credentialRef: "env:GITHUB_TOKEN",
    selections: [
      {
        id: "repo",
        kind: "repository",
        repositoryId: "R_kgDOExample",
        owner: "owner",
        name: "repo",
      },
    ],
    repositories: [
      {
        repositoryId: "R_kgDOExample",
        path: "/repo",
        ref: "main",
        gitCommonDirectory: "/repo/.git",
      },
    ],
  };
  assert.deepEqual(
    parseDomainCommandOutcome("github.configure", configured).result,
    configured,
  );
});

test("rejects schemas that normalize result identities", () => {
  const untrustedActivation = {
    projectId,
    selectionId: " selector ",
    configVersion: 1,
    active: true,
    alreadyActive: false,
  };
  assert.throws(
    () => parseDomainCommandOutcome("github.activate", untrustedActivation),
    /changed validated material/,
  );

  const untrustedGithub = {
    ...github,
    selections: [
      {
        id: " selection ",
        kind: "project",
        projectNodeId: " project-node ",
        filter: "  preserve this filter  ",
      },
    ],
    readiness: {
      mode: "all",
      conditions: [{ kind: "label", name: " ready " }],
    },
    repositories: [
      {
        repositoryId: " repo ",
        path: " /repo ",
        ref: " main ",
        gitCommonDirectory: "/repo/.git",
      },
    ],
  };
  assert.throws(
    () => parseDomainCommandOutcome("github.configure", untrustedGithub),
    /changed validated material/,
  );

  const untrustedDelivery = {
    mode: "reviewable-pr",
    grants: [
      {
        action: "issue.comment",
        repositoryId: " repo ",
        mode: "allow",
        projectNodeId: " project-node ",
      },
    ],
    requiredChecks: [{ name: " check " }],
    version: 1,
    credentialConfigured: false,
  };
  assert.throws(
    () => parseDomainCommandOutcome("delivery.configure", untrustedDelivery),
    /changed validated material/,
  );
});

test("accepts unchanged material with whitespace, reordered keys, and null prototypes", () => {
  const reorderedNullPrototypeProject = Object.assign(Object.create(null), {
    instructions: "  preserve these instructions\n",
    instructionsRevision: 1,
    leadProfileId: null,
    paused: 0,
    version: 1,
    name: " Project ",
    id: projectId,
  });
  const parsedProject = parseDomainCommandOutcome(
    "project.create",
    reorderedNullPrototypeProject,
  );
  assert.deepEqual(parsedProject.result, {
    id: projectId,
    name: " Project ",
    version: 1,
    paused: 0,
    leadProfileId: null,
    instructionsRevision: 1,
    instructions: "  preserve these instructions\n",
  });

  const projectOverrides = Object.create(null) as Record<string, number>;
  projectOverrides[projectId] = 3;
  const realSqliteStyleCapacity = Object.assign(Object.create(null), {
    effectiveProjectLimits: projectOverrides,
    currentUsage: Object.assign(Object.create(null), {
      projects: Object.create(null),
      global: 0,
    }),
    projectOverrides,
    defaultProjectLimit: 2,
    globalLimit: 4,
  });
  assert.equal(
    parseDomainCommandOutcome("capacity.configure", realSqliteStyleCapacity)
      .type,
    "capacity.configure",
  );
});

test("rejects malformed result fields rather than coercing them", () => {
  const invalid: Array<[DomainCommand["type"], unknown]> = [
    ["project.create", { ...project, id: "not-a-uuid" }],
    ["project.create", { ...project, instructionsRevision: 0 }],
    ["project.create", { ...project, instructionsRevision: 1.5 }],
    ["project.create", { ...project, instructionsRevision: Number.NaN }],
    [
      "project.create",
      { ...project, instructionsRevision: Number.POSITIVE_INFINITY },
    ],
    ["project.create", { ...project, instructionsRevision: "1" }],
    ["project.create", { ...project, leadProfileId: "" }],
    ["project.create", { ...project, paused: 2 }],
    ["project.create", { ...project, paused: "0" }],
    ["project.create", { ...project, paused: Number.POSITIVE_INFINITY }],
    ["task.create", { ...task, ready: 0.5 }],
    ["task.create", { ...task, state: "pending" }],
    ["routing.configure", { ...cases["routing.configure"], version: -1 }],
    ["routing.configure", { ...cases["routing.configure"], enabled: 2 }],
    [
      "routing.configure",
      { ...cases["routing.configure"], credentialAvailable: "1" },
    ],
    [
      "routing.configure",
      { ...cases["routing.configure"], candidateProfileIds: "{}" },
    ],
    [
      "routing.configure",
      { ...cases["routing.configure"], candidateProfileIds: '["bad"]' },
    ],
    [
      "github.configure",
      { ...github, selections: [{ id: "x", kind: "unknown" }] },
    ],
    [
      "github.configure",
      { ...github, readiness: { mode: "all", conditions: [] } },
    ],
    [
      "github.configure",
      {
        ...github,
        repositories: [{ repositoryId: "r", path: "/r", ref: "main" }],
      },
    ],
    [
      "github.configure",
      {
        ...github,
        repositories: Array(21).fill({
          repositoryId: "r",
          path: "/r",
          ref: "main",
          gitCommonDirectory: "/r/.git",
        }),
      },
    ],
    [
      "github.configure",
      {
        ...github,
        repositories: [
          {
            repositoryId: "R_DUP",
            path: "/first",
            ref: "main",
            gitCommonDirectory: "/first/.git",
          },
          {
            repositoryId: "R_DUP",
            path: "/second",
            ref: "main",
            gitCommonDirectory: "/second/.git",
          },
        ],
      },
    ],
    [
      "github.configure",
      {
        ...github,
        selections: [
          { id: "same", kind: "search", query: "one" },
          { id: "same", kind: "search", query: "two" },
        ],
      },
    ],
    ["capacity.configure", { ...capacity, globalLimit: 0 }],
    ["capacity.configure", { ...capacity, globalLimit: 1.5 }],
    [
      "capacity.configure",
      { ...capacity, globalLimit: Number.POSITIVE_INFINITY },
    ],
    [
      "capacity.configure",
      { ...capacity, currentUsage: { global: -1, projects: {} } },
    ],
    [
      "capacity.configure",
      { ...capacity, projectOverrides: { [projectId]: null } },
    ],
    ["discovery.configure", { configured: "false" }],
    ["claude-token.configure", { configured: 1 }],
    ["getting-started.configure", { dismissed: 1 }],
    ["discovery.configure", { configured: null }],
    ["assignment.apply", { ...assignment, requesterAssignmentId: "" }],
  ];

  for (const [type, result] of invalid)
    assert.throws(
      () => parseDomainCommandOutcome(type, result),
      `${type}: ${JSON.stringify(result)}`,
    );
});

test("legacy receipt validation preserves only the known migrated omissions", () => {
  const { summary: _summary, ...legacyProfile } = profile;
  assert.deepEqual(
    parseDomainCommandOutcome("profile.create", legacyProfile).result,
    legacyProfile,
  );
  assert.throws(() =>
    parseFreshDomainCommandOutcome("profile.create", legacyProfile),
  );
  assert.throws(() =>
    parseDomainCommandOutcome("profile.create", {
      ...legacyProfile,
      summary: 1,
    }),
  );

  const {
    resultRecipientAssignmentId: _recipient,
    resultRecipientDisposition: _disposition,
    ...legacyAssignment
  } = assignment;
  assert.deepEqual(
    parseDomainCommandOutcome("assignment.create", legacyAssignment).result,
    legacyAssignment,
  );
  assert.throws(() =>
    parseFreshDomainCommandOutcome("assignment.create", legacyAssignment),
  );
  assert.throws(() =>
    parseDomainCommandOutcome("assignment.create", {
      ...legacyAssignment,
      resultRecipientAssignmentId: "invalid",
    }),
  );
  assert.throws(() =>
    parseDomainCommandOutcome("assignment.create", {
      ...legacyAssignment,
      resultRecipientDisposition: "unresolved",
    }),
  );
  assert.throws(() =>
    parseDomainCommandOutcome("assignment.create", {
      ...legacyAssignment,
      resultRecipientDisposition: "unknown",
    }),
  );

  const { closedIssues: _closedIssues, ...legacyGithub } = github;
  assert.deepEqual(
    parseDomainCommandOutcome("github.configure", legacyGithub).result,
    legacyGithub,
  );
  assert.throws(() =>
    parseFreshDomainCommandOutcome("github.configure", legacyGithub),
  );
  assert.deepEqual(
    parseFreshDomainCommandOutcome("github.configure", {
      ...github,
      closedIssues: "done",
    }).result.closedIssues,
    "done",
  );
  assert.throws(() =>
    parseDomainCommandOutcome("github.configure", {
      ...github,
      closedIssues: "closed",
    }),
  );

  const activation = {
    projectId,
    selectionId: "selection",
    configVersion: 1,
    active: true as const,
  };
  assert.deepEqual(
    parseDomainCommandOutcome("github.activate", activation).result,
    activation,
  );
  assert.throws(() =>
    parseFreshDomainCommandOutcome("github.activate", activation),
  );
  assert.equal(
    parseFreshDomainCommandOutcome("github.activate", {
      ...activation,
      alreadyActive: true,
    }).result.alreadyActive,
    true,
  );
  for (const parse of [
    parseDomainCommandOutcome,
    parseFreshDomainCommandOutcome,
  ])
    assert.throws(() =>
      parse("github.activate", { ...activation, alreadyActive: "yes" }),
    );
});

test("keeps result variants correlated with their command key", () => {
  const taskOutcome: DomainCommandOutcome = {
    type: "task.configure",
    result: task,
  };
  assert.equal(taskOutcome.type, "task.configure");
});
