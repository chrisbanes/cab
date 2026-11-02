import assert from "node:assert/strict";
import { test } from "node:test";
import {
  composeIssueBrief,
  issueBriefByteLimit,
  issueBriefNoteSeparator,
  issueBriefTruncatedMarker,
  omittedNotesMarker,
} from "../../src/core/issue-brief.js";

const bytes = (value: string) => Buffer.byteLength(value, "utf8");

test("the newest brief comment and the notes after it make the issue brief", () => {
  assert.deepEqual(
    composeIssueBrief([
      "Discussion",
      "## Agent Brief\nOld",
      "Old note",
      "Preamble\r\n##  Agent Brief \r\nNew",
      "Note 1\r\nline",
      "Note 2",
    ]),
    {
      text: ["Preamble\n##  Agent Brief \nNew", "Note 1\nline", "Note 2"].join(
        issueBriefNoteSeparator,
      ),
      truncated: false,
    },
  );
  assert.equal(composeIssueBrief([]), null);
  assert.equal(
    composeIssueBrief([
      "### Agent Brief",
      "## Agent Briefing",
      "## agent brief x",
    ]),
    null,
  );
});

test("over the cap, the oldest notes are dropped first with a counted marker", () => {
  const note = "n".repeat(12_000);
  const result = composeIssueBrief([
    "## Agent Brief\nKeep",
    `first ${note}`,
    `second ${note}`,
    `third ${note}`,
    `fourth ${note}`,
  ]);
  assert.ok(result);
  assert.equal(result.truncated, true);
  assert.ok(bytes(result.text) <= issueBriefByteLimit);
  assert.ok(
    result.text.startsWith(`## Agent Brief\nKeep\n\n${omittedNotesMarker(2)}`),
  );
  assert.ok(!result.text.includes("first "));
  assert.ok(!result.text.includes("second "));
  assert.ok(result.text.includes("third ") && result.text.endsWith(note));
  assert.equal(omittedNotesMarker(1), "[… 1 earlier note omitted …]");
});

test("a brief alone over the cap is cut on a code point with a marker", () => {
  // Four-byte characters, offset by one ASCII byte so a naive cut would split one.
  const huge = `## Agent Brief\nx${"🚀".repeat(10_000)}`;
  const result = composeIssueBrief([huge, "later"]);
  assert.ok(result);
  assert.equal(result.truncated, true);
  assert.ok(bytes(result.text) <= issueBriefByteLimit);
  assert.ok(!result.text.includes("�"));
  assert.ok(
    result.text.endsWith(
      `${issueBriefTruncatedMarker}\n\n${omittedNotesMarker(1)}`,
    ),
  );
  assert.ok(huge.startsWith(result.text.split("\n\n[…")[0]!));
  const alone = composeIssueBrief([huge]);
  assert.ok(alone?.text.endsWith(issueBriefTruncatedMarker));
});
