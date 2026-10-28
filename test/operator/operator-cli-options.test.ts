import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { browseCommands, writeCommands } from "../../src/cli/commands.js";
import {
  BUILTIN_USAGE,
  declaredOptions,
  OPTIONS,
  usageOptions,
} from "../../src/cli/main.js";
import { ALWAYS_ALLOWED } from "../../src/cli/write.js";
import { harness } from "../fixtures/cli-harness.js";
import { startCliService } from "../fixtures/operator-cli.js";

/** Options that main() answers before it dispatches any command. */
const EARLY = ["help", "all", "version"];
const commandKeys = () => [
  ...BUILTIN_USAGE.keys(),
  ...browseCommands.keys(),
  ...writeCommands.keys(),
];
const optionTakesValue = (name: string) =>
  OPTIONS[name as keyof typeof OPTIONS].type === "string";
const fixLines = (text: string) =>
  text.split("\n").filter((line) => line.startsWith("Fix: "));

/** Every file of the configuration directory, by name, with its bytes. */
const snapshot = (dir: string) =>
  Object.fromEntries(
    readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => {
        const path = join(entry.parentPath, entry.name);
        return [path, readFileSync(path, "utf8")];
      }),
  );

async function signedIn(t: Parameters<typeof startCliService>[0]) {
  const s = await startCliService(t);
  const h = harness(t);
  h.keychain.items.set("sentinel-account", "sentinel-token");
  const rw = await s.issue("read-write", "options-rw");
  const login = await h.run([
    "auth",
    "login",
    "--connection",
    "home",
    "--url",
    s.origin,
    "--token-file",
    h.tokenFile(rw.token),
  ]);
  assert.equal(login.code, 0, login.err);
  return { s, h };
}

test("every command declares its options, and a command table entry is never skipped", () => {
  const keys = commandKeys();
  assert.equal(
    new Set(keys).size,
    keys.length,
    "a command key is declared twice",
  );
  for (const key of keys) {
    const declared = declaredOptions(key);
    assert.ok(declared, `${key} has no declared options`);
    for (const name of declared)
      assert.ok(name in OPTIONS, `${key} names --${name}, which is no option`);
  }
  // A write command's `flags` and its usage line say the same thing.
  for (const [key, command] of writeCommands) {
    const named = usageOptions(command.usage).filter(
      (name) => !ALWAYS_ALLOWED.includes(name),
    );
    assert.deepEqual(
      [...new Set(named)].sort(),
      [...command.flags].sort(),
      `${key}: usage and flags differ`,
    );
  }
  assert.equal(declaredOptions("task bogus"), undefined);
});

test("a command refuses every option it does not declare before it acts", async (t) => {
  const { h } = await signedIn(t);
  const before = snapshot(h.configDir);
  const keychain = [...h.keychain.items];
  const sent = h.fetches.length;
  let refused = 0;
  for (const key of commandKeys()) {
    const declared = declaredOptions(key) ?? [];
    for (const name of Object.keys(OPTIONS)) {
      if (EARLY.includes(name) || ALWAYS_ALLOWED.includes(name)) continue;
      if (declared.includes(name)) continue;
      const args = [
        ...key.split(" "),
        `--${name}`,
        ...(optionTakesValue(name) ? ["x"] : []),
      ];
      const r = await h.run(args);
      const label = args.join(" ");
      assert.equal(r.code, 2, label);
      assert.equal(r.out, "", label);
      assert.ok(
        r.err.startsWith(
          `cab: --${name} is not an option of this command. (usage)\n`,
        ),
        `${label}: ${r.err}`,
      );
      assert.equal(fixLines(r.err).length, 1, label);
      refused++;
    }
  }
  assert.ok(refused > 1000, `checked ${refused} refusals`);
  assert.deepEqual(snapshot(h.configDir), before);
  assert.deepEqual([...h.keychain.items], keychain);
  assert.equal(h.fetches.length, sent, "nothing was sent");
});

test("a mutating built-in refuses --verbose without changing the connection or credential", async (t) => {
  const { s, h } = await signedIn(t);
  const before = snapshot(h.configDir);
  const keychain = [...h.keychain.items];
  const file = h.tokenFile("unused-token");
  for (const args of [
    ["connection", "remove", "home", "--verbose"],
    ["connection", "use", "home", "--verbose"],
    ["auth", "logout", "--verbose"],
    ["auth", "logout", "--connection", "home", "--verbose"],
    ["auth", "login", "--url", s.origin, "--token-file", file, "--verbose"],
    ["connection", "remove", "--verbose", "home"],
  ]) {
    const r = await h.run(args);
    assert.equal(r.code, 2, args.join(" "));
    assert.equal(r.out, "", args.join(" "));
    assert.match(r.err, /--verbose is not an option of this command/);
    assert.equal(fixLines(r.err).length, 1, args.join(" "));
  }
  const json = await h.run([
    "connection",
    "remove",
    "home",
    "--verbose",
    "--output",
    "json",
  ]);
  assert.equal(json.code, 2);
  assert.equal(json.json().error.code, "usage");
  assert.deepEqual(snapshot(h.configDir), before);
  assert.deepEqual([...h.keychain.items], keychain);
  // The command still works without the flag, so the checks above were not vacuous.
  const listed = await h.run(["connection", "list"]);
  assert.equal(listed.code, 0, listed.err);
  assert.match(listed.out, /home/);
});

test("--verbose is accepted by the read commands that declare it, and honours --", async (t) => {
  const { h } = await signedIn(t);
  const declaring = commandKeys().filter((key) =>
    declaredOptions(key)?.includes("verbose"),
  );
  assert.deepEqual(declaring.sort(), [
    "execution get",
    "execution list",
    "logs",
  ]);
  for (const key of declaring) {
    const r = await h.run([...key.split(" "), "--verbose"]);
    assert.doesNotMatch(r.err, /is not an option/, key);
  }
  // After `--` it is a positional, never the option.
  const r = await h.run(["connection", "remove", "home", "--", "--verbose"]);
  assert.equal(r.code, 2);
  assert.match(r.err, /Unexpected arguments/);
  assert.doesNotMatch(r.err, /is not an option/);
  assert.match((await h.run(["connection", "list"])).out, /home/);
});
