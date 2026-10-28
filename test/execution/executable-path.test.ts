import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { resolveOnPath } from "../../src/standalone/executable-path.js";
import { tmpdir } from "../fixtures/temp.js";

test("resolveOnPath returns the first executable regular file's PATH entry, not its target", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "cab-onpath-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const [a, b, c, d] = ["a", "b", "c", "d"].map((name) => {
    const directory = join(root, name);
    mkdirSync(directory);
    return directory;
  });
  assert.ok(a && b && c && d);
  writeFileSync(join(a, "claude"), "#!/bin/sh\n", { mode: 0o644 });
  writeFileSync(join(c, "claude"), "#!/bin/sh\n", { mode: 0o755 });
  symlinkSync(join(c, "claude"), join(b, "claude"));
  mkdirSync(join(d, "claude"));
  const path = (...entries: string[]) => ({ PATH: entries.join(delimiter) });

  // `a` is not executable, so `b`'s symlink wins and is reported as itself.
  assert.equal(await resolveOnPath("claude", path(a, b, c)), join(b, "claude"));
  assert.equal(await resolveOnPath("claude", path(c, b)), join(c, "claude"));
  // A directory named `claude` and relative or empty entries are skipped.
  assert.equal(
    await resolveOnPath("claude", path(d, "bin", "", "./a", c)),
    join(c, "claude"),
  );
  assert.equal(await resolveOnPath("claude", path(a, d, "bin", "")), null);
  assert.equal(await resolveOnPath("claude", {}), null);

  chmodSync(join(c, "claude"), 0o644);
  assert.equal(await resolveOnPath("claude", path(b, c)), null);
});
