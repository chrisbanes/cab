import {
  retainedProjectLine,
  projectExternalRetention,
  projectDeletionWarning,
} from "../../src/operator/project-lifecycle-copy.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  projectLifecyclePresentation,
  visibleProjects,
  taskProjectReadOnly,
  deletionConfirmationReady,
} from "../../web/src/project-lifecycle-model.js";

test("archived history permits rename, restore and delete preview, with paused restoration explained", () => {
  assert.deepEqual(projectLifecyclePresentation(true), {
    label: "Archived",
    readOnly: true,
    notice:
      "This project is archived. Its tasks and history are available to read. Restore keeps it paused.",
    rename: true,
    configure: false,
    archive: false,
    restore: true,
    deletePreview: true,
  });
  const live = projectLifecyclePresentation(false);
  assert.equal(live.readOnly, false);
  assert.equal(live.notice, null);
  assert.equal(live.configure, true);
  assert.equal(live.archive, true);
  assert.equal(live.restore, false);
  assert.equal(live.deletePreview, false);
});

test("pickers hide archived projects by default and history includes both without changing their order", () => {
  const projects = [
    { id: "A", archived: false },
    { id: "B", archived: true },
    { id: "C", archived: false },
  ];
  assert.deepEqual(
    visibleProjects(projects).map((project) => project.id),
    ["A", "C"],
  );
  assert.equal(visibleProjects(projects, true), projects);
  assert.deepEqual(
    projects.map((project) => project.id),
    ["A", "B", "C"],
  );
});

test("direct task lifecycle permits active writes even when the default picker omits its project; missing or mismatched lifecycle refuses", () => {
  assert.equal(taskProjectReadOnly("A", { id: "A", archived: false }), false);
  assert.equal(taskProjectReadOnly("A", { id: "A", archived: true }), true);
  assert.equal(taskProjectReadOnly("A", undefined), true);
  assert.equal(taskProjectReadOnly("A", { id: "B", archived: false }), true);
  assert.equal(
    taskProjectReadOnly(undefined, { id: "A", archived: false }),
    true,
  );
});

test("delete confirmation holds exact case, version, project and original preview through pending or unknown outcomes", () => {
  const input = {
    archived: true,
    projectId: "A",
    version: 4,
    name: "Relay",
    preview: { projectId: "A", version: 4, name: "Relay", previewDigest: "d" },
    typedName: "Relay",
    phase: "editable",
  };
  assert.equal(deletionConfirmationReady(input), true);
  for (const typedName of ["relay", "Relay ", " Relay", ""])
    assert.equal(deletionConfirmationReady({ ...input, typedName }), false);
  for (const phase of [
    "pending",
    "unknown",
    "recorded",
    "conflict",
    "rejected",
  ])
    assert.equal(deletionConfirmationReady({ ...input, phase }), false);
  assert.equal(deletionConfirmationReady({ ...input, version: 5 }), false);
  assert.equal(deletionConfirmationReady({ ...input, projectId: "B" }), false);
  assert.equal(deletionConfirmationReady({ ...input, name: "Renamed" }), false);
  assert.equal(deletionConfirmationReady({ ...input, archived: false }), false);
  assert.equal(deletionConfirmationReady({ ...input, preview: null }), false);
  assert.equal(
    deletionConfirmationReady({
      ...input,
      name: null,
      preview: { ...input.preview, name: null },
    }),
    false,
  );
});

test("shared deletion wording describes loss of local work and retention of external state without inventing cleanup success", () => {
  assert.match(projectDeletionWarning, /dirty, untracked and unpushed work/);
  assert.match(projectDeletionWarning, /There is no undo/);
  assert.match(projectExternalRetention, /Cleanup can remain pending/);
  assert.equal(
    retainedProjectLine({
      codeHost: "gitlab",
      repositoryId: "team/repo",
      branch: "topic",
      changeRequestId: "42",
    }),
    "Retained gitlab: team/repo; branch topic; PR 42.",
  );
});
