import assert from "node:assert/strict";
import { test } from "node:test";
import {
  clockLabel,
  codeSentence,
  outcomeLine,
  shortId,
  updatedLabel,
} from "../../web/src/presentation.js";

test("clock label is two-digit local hours and minutes", () => {
  assert.equal(clockLabel(new Date(2026, 9, 16, 9, 5).getTime()), "09:05");
  assert.equal(clockLabel(new Date(2026, 9, 16, 17, 50).getTime()), "17:50");
});

test("the updated label shows one time unless the reads show different clock labels", () => {
  const at = (...time: [number, number, number, number?]) =>
    new Date(2026, 9, time[3] ?? 16, time[0], time[1], time[2]).getTime();
  assert.equal(updatedLabel(at(16, 48, 7), at(16, 48, 7)), "Updated 16:48");
  assert.equal(updatedLabel(at(16, 48, 1), at(16, 48, 59)), "Updated 16:48");
  assert.equal(
    updatedLabel(at(16, 47, 59), at(16, 48, 0)),
    "Updated 16:47–16:48",
  );
  assert.equal(
    updatedLabel(at(23, 59, 30), at(0, 0, 10, 17)),
    "Updated 23:59–00:00",
  );
});

test("short identifier keeps the first eight characters unless told otherwise", () => {
  assert.equal(shortId("9bd4c1e2f00d4a7b"), "9bd4c1e2");
  assert.equal(shortId("A-9bd4"), "A-9bd4");
  assert.equal(shortId("9bd4c1e2f00d4a7b", 4), "9bd4");
});

test("a reason code reads as its sentence and an unmapped code never leaks", () => {
  const sentences = {
    "base-branch-required": "Choose a base branch to compare against.",
  };
  assert.equal(
    codeSentence("base-branch-required", sentences, "Not available."),
    "Choose a base branch to compare against.",
  );
  const unmapped = codeSentence(
    "reviewable-pr-awaiting-current-settlement",
    sentences,
    "Not available.",
  );
  assert.equal(unmapped, "Not available.");
  assert.doesNotMatch(unmapped, /reviewable-pr/);
});

test("the outcome line is its first non-empty line without Markdown markers", () => {
  assert.deepEqual(outcomeLine("## Context\n\n- [ ] Restore focus"), {
    line: "Context",
    more: true,
  });
  assert.deepEqual(outcomeLine("- [ ] Restore focus\n- [ ] Retain drafts"), {
    line: "Restore focus",
    more: true,
  });
  assert.deepEqual(outcomeLine("1. [x] Done first\n2. Then this"), {
    line: "Done first",
    more: true,
  });
  assert.deepEqual(outcomeLine("Write the guide."), {
    line: "Write the guide.",
    more: false,
  });
  // Trailing blank lines are not more text, and a link labelled x keeps its label.
  assert.deepEqual(outcomeLine("[X](https://example.com) first\n\n  \n"), {
    line: "[X](https://example.com) first",
    more: false,
  });
  // Nothing meaningful, and a redacted outcome, give no line and no exception.
  assert.deepEqual(outcomeLine("  \n- [ ]  \n"), { line: "", more: false });
  assert.deepEqual(outcomeLine(null), { line: "", more: false });
});
