import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type DomainCommandOutcome,
  type DomainCommandResultMap,
  parseDomainCommandOutcome,
} from "../src/core/command-results.js";
import type { DomainCommand } from "../src/core/domain.js";

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
  "github.activate": {
    projectId,
    selectionId: "selection",
    configVersion: 1,
    active: true,
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
    ["discovery.configure", { configured: null }],
    ["assignment.apply", { ...assignment, requesterAssignmentId: "" }],
  ];

  for (const [type, result] of invalid)
    assert.throws(
      () => parseDomainCommandOutcome(type, result),
      `${type}: ${JSON.stringify(result)}`,
    );
});

test("keeps result variants correlated with their command key", () => {
  const taskOutcome: DomainCommandOutcome = {
    type: "task.configure",
    result: task,
  };
  assert.equal(taskOutcome.type, "task.configure");
});
