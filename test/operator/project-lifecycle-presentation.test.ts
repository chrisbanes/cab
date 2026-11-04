import assert from "node:assert/strict";
import { test } from "node:test";
import {
  projectLifecyclePresentation,
  visibleProjects,
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
