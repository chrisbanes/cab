import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  claudeTokenExclusions,
  claudeTokenSource,
  readClaudeToken,
} from "../../src/standalone/claude-token.js";
import { tmpdir } from "../fixtures/temp.js";

const CANARY = "canary-file-token-3381";

function directory(t: { after: (fn: () => void) => void }) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ensemble-token-")));
  chmodSync(root, 0o700);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

const file = (path: string) => readClaudeToken({ kind: "file", path });

test("a Claude token reference names an environment variable or a file", () => {
  assert.deepEqual(claudeTokenSource("env:CLAUDE_TOKEN"), {
    kind: "env",
    name: "CLAUDE_TOKEN",
  });
  assert.deepEqual(claudeTokenSource("file:/private/claude/token"), {
    kind: "file",
    path: "/private/claude/token",
  });
});

test("an owner-only token file resolves to its trimmed value", (t) => {
  const root = directory(t);
  const path = join(root, "token");
  writeFileSync(path, `${CANARY}\n`, { mode: 0o600 });
  assert.deepEqual(file(path), { value: CANARY });
  // Replaced atomically, the next read returns the new value.
  const next = join(root, "token.next");
  writeFileSync(next, "canary-rotated-4410", { mode: 0o600 });
  renameSync(next, path);
  assert.deepEqual(file(path), { value: "canary-rotated-4410" });
});

test("an unsafe token file is never read and its problem names neither path nor value", (t) => {
  const root = directory(t);
  const valid = join(root, "token");
  writeFileSync(valid, `${CANARY}\n`, { mode: 0o600 });
  const write = (name: string, content: string | Buffer, mode = 0o600) => {
    const path = join(root, name);
    writeFileSync(path, content, { mode });
    chmodSync(path, mode);
    return path;
  };
  const link = join(root, "link");
  symlinkSync(valid, link);
  const dir = join(root, "dir");
  mkdirSync(dir, { mode: 0o700 });
  const cases: [string, ReturnType<typeof readClaudeToken>][] = [
    ["is a symbolic link", file(link)],
    ["permits group or other access", file(write("group", CANARY, 0o640))],
    ["permits group or other access", file(write("other", CANARY, 0o604))],
    ["is larger than 4096 bytes", file(write("large", "a".repeat(4097)))],
    ["is missing", file(join(root, "absent"))],
    ["is not a regular file", file(dir)],
    ["is empty", file(write("empty", ""))],
    ["is empty", file(write("newline", "\n"))],
    ["does not hold a single token", file(write("spaced", "a b"))],
    [
      "does not hold a single token",
      file(write("binary", Buffer.from([0xff, 0xfe]))),
    ],
    [
      "is not owned by the service user",
      readClaudeToken(
        { kind: "file", path: valid },
        process.env,
        (process.getuid?.() ?? 0) + 1,
      ),
    ],
  ];
  for (const [problem, read] of cases) {
    assert.deepEqual(read, { problem });
    assert.equal(JSON.stringify(read).includes(root), false);
    assert.equal(JSON.stringify(read).includes(CANARY), false);
  }
});

test("exclusions cover the reference, its location and only a resolved value", (t) => {
  const root = directory(t);
  const path = join(root, "token");
  writeFileSync(path, CANARY, { mode: 0o600 });
  assert.deepEqual(
    claudeTokenExclusions("env:FIXTURE_TOKEN", { FIXTURE_TOKEN: CANARY }),
    {
      names: ["FIXTURE_TOKEN"],
      values: [CANARY],
      redactions: ["env:FIXTURE_TOKEN", "FIXTURE_TOKEN", CANARY],
    },
  );
  assert.deepEqual(claudeTokenExclusions(`file:${path}`), {
    names: [],
    values: [CANARY],
    redactions: [`file:${path}`, path, CANARY],
  });
  chmodSync(path, 0o644);
  assert.deepEqual(claudeTokenExclusions(`file:${path}`), {
    names: [],
    values: [],
    redactions: [`file:${path}`, path],
  });
});
