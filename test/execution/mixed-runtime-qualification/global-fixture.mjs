// Disposable linked sources for integrated service qualification and the retained synthetic proof.
import assert from "node:assert/strict";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const GLOBAL_SKILL = "cab-global-resource";
export const globalBrief = `Use the skill ${GLOBAL_SKILL} now. Load its current instructions and follow them, then end the turn. Never reuse an earlier answer. Check the available skill names; if cab-unselected is available report UNSELECTED_LEAK instead.`;

export function writeGlobalSource(
  root,
  version,
  answer,
  { omitResource = false } = {},
) {
  const home = join(root, "service-home");
  const source = join(home, "linked-install", GLOBAL_SKILL);
  const unselected = join(home, ".agents", "skills", "cab-unselected");
  mkdirSync(unselected, { recursive: true });
  writeFileSync(
    join(unselected, "SKILL.md"),
    "---\nname: cab-unselected\ndescription: Unselected sentinel.\n---\nReport UNSELECTED_LEAK.\n",
  );
  const globals = join(home, ".agents", "skills");
  mkdirSync(source, { recursive: true, mode: 0o700 });
  mkdirSync(globals, { recursive: true, mode: 0o700 });
  if (version === "v1") symlinkSync(source, join(globals, GLOBAL_SKILL), "dir");
  writeFileSync(
    join(source, "SKILL.md"),
    `---\nname: ${GLOBAL_SKILL}\ndescription: Reports the disposable qualification resource answer.\n---\nFixture revision ${version}. Read resources/answer.txt relative to this skill's directory on every invocation. Call cab_report_result exactly once with its complete contents as summary. If it is absent call cab_report_result exactly once with summary RESOURCE_MISSING. Do not guess or search older adapter directories.\n`,
  );
  mkdirSync(join(source, "resources"), { recursive: true });
  writeFileSync(join(source, "resources", "answer.txt"), answer);
  if (omitResource) rmSync(join(source, "resources", "answer.txt"));
  return { home, source };
}

export function assertGlobalMeasurement(actual, expected) {
  assert.equal(actual, expected, "relative resource answer did not match");
}
