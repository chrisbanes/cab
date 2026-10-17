import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { browseCommands, writeCommands } from "../../src/cli/commands.js";
import { BUILTIN_USAGE, OPTIONS } from "../../src/cli/main.js";
import { CATEGORY_FIX, DEFAULT_FIX } from "../../src/cli/remedy.js";
import { LIFECYCLE_OPTIONS, SERVICE_USAGE } from "../../src/cli/service.js";
import { ALWAYS_ALLOWED } from "../../src/cli/write.js";
import { harness } from "../fixtures/cli-harness.js";
import { startCliService } from "../fixtures/operator-cli.js";

const FIX = "Fix: Run 'ensemble --help'.";
const START_HERE = [
  "auth login",
  "doctor",
  "project list",
  "task list",
  "task get",
  "task create",
  "inbox list",
];

/** Every operator command's key and usage line, from the tables the CLI itself reads. */
const commands = new Map<string, string>([
  ...BUILTIN_USAGE,
  ...[...browseCommands, ...writeCommands].map(
    ([key, c]) => [key, c.usage] as const,
  ),
]);
const usageOf = (key: string) => commands.get(key) ?? assert.fail(key);
const operatorAreas = [
  ...new Set([...commands.keys()].map((k) => k.split(" ")[0] ?? k)),
];
const areas = [...operatorAreas, "service", "snapshot"].sort();
const serviceLines = SERVICE_USAGE.split("\n").filter((l) =>
  /^ {2}(service|snapshot) /.test(l),
);
const lines = (text: string) => text.trimEnd().split("\n");
const fixLines = (text: string) =>
  lines(text).filter((l) => l.startsWith("Fix: "));
const areaNames = (line: string | undefined) =>
  line?.slice("Areas: ".length).split(", ").sort();

test("ensemble --help prints the start-here block and the area names", async (t) => {
  const h = harness(t);
  const r = await h.run(["--help"]);
  assert.equal(r.code, 0);
  assert.equal(r.err, "");
  const out = lines(r.out);
  for (const key of START_HERE)
    assert.ok(out.includes(`  ${usageOf(key)}`), key);
  assert.deepEqual(areaNames(out.find((l) => l.startsWith("Areas: "))), areas);
  for (const text of ["ensemble help AREA", "--help --all", "--version"])
    assert.ok(r.out.includes(text), text);
  for (const text of ["task stop", "service install", "snapshot create"])
    assert.ok(!r.out.includes(text), text);
  assert.ok(out.length <= 25, `${out.length} lines`);
  // The same words on every platform.
  const linux = await harness(t, { platform: "linux" }).run(["--help"]);
  assert.equal(linux.out, r.out);
});

test("bare ensemble prints the start block and one Fix line", async (t) => {
  const h = harness(t);
  const help = await h.run(["--help"]);
  const human = await h.run([]);
  assert.equal(human.code, 2);
  assert.equal(human.out, help.out);
  assert.equal(human.err, `${FIX}\n`);
  const json = await h.run(["--output", "json"]);
  assert.equal(json.code, 2);
  assert.equal(json.out, help.out);
  assert.equal(json.err, "");
});

test("help AREA and AREA --help print only that area", async (t) => {
  const h = harness(t);
  for (const area of areas) {
    const named = await h.run(["help", area]);
    const flagged = await h.run([area, "--help"]);
    assert.equal(named.code, 0, area);
    assert.equal(flagged.code, 0, area);
    assert.equal(named.err, "", area);
    assert.equal(flagged.err, "", area);
    assert.equal(named.out, flagged.out, area);
    const out = lines(named.out);
    if (area === "service" || area === "snapshot") {
      for (const line of serviceLines)
        assert.equal(out.includes(line), line.startsWith(`  ${area} `), line);
    } else {
      for (const [key, usage] of commands)
        assert.equal(
          out.includes(`  ${usage}`),
          key.split(" ")[0] === area,
          `${area}: ${key}`,
        );
      for (const line of serviceLines) assert.ok(!out.includes(line), line);
    }
  }
  const task = (await h.run(["help", "task"])).out;
  assert.ok(task.includes("cannot be undone"));
  assert.ok(!task.includes("Runtimes:"));
  assert.ok((await h.run(["help", "runtime"])).out.includes("Runtimes:"));
  const service = (await h.run(["help", "service"])).out;
  assert.ok(service.includes("--state-dir"));
  assert.ok(!service.includes("snapshot create"));
  assert.ok(!(await h.run(["help", "snapshot"])).out.includes("--state-dir"));
  // The words after the area do not change which area is shown.
  for (const [args, area] of [
    [["service", "install", "--help"], "service"],
    [["task", "get", "--help"], "task"],
    [["snapshot", "create", "--help"], "snapshot"],
    [["help", "task", "--help"], "task"],
  ] as const) {
    const r = await h.run([...args]);
    assert.equal(r.code, 0, args.join(" "));
    assert.equal(r.err, "", args.join(" "));
    assert.equal(r.out, (await h.run(["help", area])).out, args.join(" "));
  }
});

test("--help --all lists every command with service and snapshot in a separate block", async (t) => {
  const r = await harness(t).run(["--help", "--all"]);
  assert.equal(r.code, 0);
  assert.equal(r.err, "");
  assert.ok(r.out.includes(SERVICE_USAGE));
  // The notes and the ORIGIN definition close the full help.
  assert.ok(r.out.includes("Recovery: recovery prepare"));
  assert.match(r.out, /\nORIGIN is https:\/\/HOST\[:PORT\][^\n]*\n$/);
  const out = r.out.split("\n");
  const heading = out.findIndex((l) => l.startsWith("Local service commands"));
  assert.ok(heading > 0);
  assert.equal(out[heading - 1], "");
  for (const usage of commands.values()) {
    const at = out.indexOf(`  ${usage}`);
    assert.ok(at >= 0 && at < heading, usage);
  }
  for (const line of serviceLines) assert.ok(out.indexOf(line) > heading, line);
});

test("help requests that are not an area fail as usage errors", async (t) => {
  const h = harness(t);
  for (const [args, message] of [
    [["help"], "Name an area: ensemble help AREA."],
    [["help", "bogus"], "Unknown area 'bogus'."],
    [["help", "task", "extra"], "Unexpected arguments."],
    [["task", "list", "--all"], "--all only goes with --help."],
    [["--all"], "--all only goes with --help."],
    [
      ["--help", "--output", "yaml"],
      "--output must be human or json (jsonl only for logs).",
    ],
  ] as const) {
    const r = await h.run([...args]);
    const name = args.join(" ");
    assert.equal(r.code, 2, name);
    assert.equal(r.out, "", name);
    assert.equal(lines(r.err)[0], `ensemble: ${message} (usage)`, name);
    assert.equal(lines(r.err).at(-1), FIX, name);
    assert.equal(fixLines(r.err).length, 1, name);
  }
});

test("words after a standalone -- are values, not help, version or --all requests", async (t) => {
  const h = harness(t);
  // Each word reaches `task get` as its TASK_ID instead of being read as an option or command.
  for (const args of [
    ["task", "get", "--", "--help"],
    ["task", "get", "--", "--version"],
    ["task", "get", "--", "help"],
    ["task", "get", "help"],
  ]) {
    const r = await h.run(args);
    const name = args.join(" ");
    assert.equal(r.code, 2, name);
    assert.equal(r.out, "", name);
    assert.equal(
      lines(r.err)[0],
      "ensemble: TASK_ID must be a UUID. (invalid-input)",
      name,
    );
    assert.equal(fixLines(r.err).length, 1, name);
  }
  // `--all` after the terminator is an extra word, not the help flag.
  const all = await h.run(["task", "list", "--", "--all"]);
  assert.equal(all.code, 2);
  assert.equal(all.out, "");
  assert.equal(lines(all.err)[0], "ensemble: Unexpected arguments. (usage)");
  assert.equal(fixLines(all.err).length, 1);
});

test("a request for help on an unknown word prints the start block", async (t) => {
  const h = harness(t);
  const r = await h.run(["bogus", "--help"]);
  assert.equal(r.code, 0);
  assert.equal(r.out, (await h.run(["--help"])).out);
  assert.equal(r.err, "");
});

test("a usage error prints the message, that command's usage and the Fix line", async (t) => {
  const h = harness(t);
  const rows: [string[], string, string[] | "areas"][] = [
    [["task", "get"], "Unexpected arguments.", ["task get"]],
    [
      ["auth"],
      "Unknown command.",
      ["auth login", "auth status", "auth logout"],
    ],
    [
      ["task", "bogus"],
      "Unknown command.",
      [...commands.keys()].filter((k) => k.startsWith("task ")),
    ],
    [["projects"], "Unknown command.", "areas"],
    [["-h"], "Unknown option '-h'.", "areas"],
    [
      ["task", "list", "--bogus-flag"],
      "Unknown option '--bogus-flag'.",
      ["task list"],
    ],
    [["help", "bogus"], "Unknown area 'bogus'.", "areas"],
    [
      ["task", "stop", randomUUID(), "--ready", "true"],
      "--ready is not an option of this command.",
      ["task stop"],
    ],
  ];
  for (const [args, message, expected] of rows) {
    const name = args.join(" ");
    const r = await h.run(args);
    assert.equal(r.code, 2, name);
    assert.equal(r.out, "", name);
    const err = lines(r.err);
    assert.equal(err[0], `ensemble: ${message} (usage)`, name);
    assert.equal(err.at(-1), FIX, name);
    assert.equal(fixLines(r.err).length, 1, name);
    assert.ok(err.length <= 16, name);
    assert.doesNotMatch(r.err, /positional argument|'--'/, name);
    const block = err.slice(1, -1);
    if (expected === "areas") {
      assert.equal(block[0], "Usage: ensemble <command> [options]", name);
      assert.deepEqual(areaNames(block[1]), areas, name);
      assert.equal(block.length, 2, name);
    } else
      assert.deepEqual(
        block,
        ["Usage:", ...expected.map((key) => `  ${usageOf(key)}`)],
        name,
      );
  }
});

test("a usage error in JSON keeps its envelope with a one-line message", async (t) => {
  const h = harness(t);
  for (const args of [["task", "get"], ["task", "bogus"], ["projects"]]) {
    const r = await h.run([...args, "--output", "json"]);
    const name = args.join(" ");
    assert.equal(r.code, 2, name);
    assert.equal(r.err, "", name);
    const error = r.json().error;
    assert.deepEqual(
      Object.keys(error).sort(),
      ["category", "code", "message", "outcome", "requestId", "retryable"],
      name,
    );
    assert.equal(error.code, "usage", name);
    assert.ok(
      !error.message.includes("\n") && !error.message.includes("Usage:"),
      name,
    );
  }
});

test("service and snapshot usage errors print only their area's commands", async (t) => {
  const h = harness(t);
  for (const [args, area, other] of [
    [["service", "bogus"], "service", "snapshot"],
    [["service"], "service", "snapshot"],
    [["snapshot", "create"], "snapshot", "service"],
    [["snapshot"], "snapshot", "service"],
  ] as const) {
    const name = args.join(" ");
    const r = await h.run([...args]);
    assert.equal(r.code, 2, name);
    assert.equal(r.out, "", name);
    const err = lines(r.err);
    assert.equal(err[0], "ensemble: Unexpected arguments. (usage)", name);
    assert.equal(err[1], "Usage:", name);
    assert.deepEqual(
      err.slice(2, -1),
      serviceLines.filter((l) => l.startsWith(`  ${area} `)),
      name,
    );
    assert.ok(!r.err.includes(`  ${other} `), name);
    assert.ok(!r.err.includes("SERVICE_OPTIONS:"), name);
    assert.equal(err.at(-1), FIX, name);
    assert.equal(fixLines(r.err).length, 1, name);
  }
});

const sourceDir = join(process.cwd(), "src", "cli");
const optionNames = new Set([
  ...Object.keys(OPTIONS),
  ...Object.keys(LIFECYCLE_OPTIONS),
]);
const flagsIn = (text: string) =>
  [...text.matchAll(/(?<![\w-])--[a-z][a-z-]*/g)].map((m) => m[0].slice(2));
/** The flags of an `ensemble ...` command that are not options of it. */
const flagProblems = (command: string) => {
  const words = command.split(/\s+/);
  const write = writeCommands.get(`${words[0]} ${words[1]}`);
  return flagsIn(command).filter(
    (flag) =>
      !optionNames.has(flag) ||
      (write && !ALWAYS_ALLOWED.includes(flag) && !write.flags.includes(flag)),
  );
};
const knownCommand = (words: string[]): boolean =>
  // `ensemble help` alone, or naming an area.
  (words[0] === "help" &&
    (words.length === 1 ||
      (words.length === 2 && areas.includes(words[1] ?? "")))) ||
  (words.length === 1 && areas.includes(words[0] ?? "")) ||
  ["service", "snapshot"].includes(words[0] ?? "") ||
  [...commands.keys()].some(
    (key) =>
      key === words.join(" ") || (!key.includes(" ") && key === words[0]),
  );

test("every command and flag that help and remedies name exists", async (t) => {
  assert.deepEqual(flagProblems("task stop TASK_ID --ready true"), ["ready"]);
  assert.deepEqual(flagProblems("task list --bogus"), ["bogus"]);
  assert.deepEqual(flagProblems("task list --limit 3 --output json"), []);
  assert.equal(knownCommand(["task", "bogus"]), false);
  assert.equal(knownCommand(["help", "recovry"]), false);
  assert.equal(knownCommand(["help", "recovery"]), true);
  const h = harness(t);
  const texts = [
    ...(await Promise.all(
      [["--help"], ["--help", "--all"], ...areas.map((a) => ["help", a])].map(
        async (args) => (await h.run(args)).out,
      ),
    )),
    ...Object.values(DEFAULT_FIX),
    ...Object.values(CATEGORY_FIX),
  ];
  const unknown = new Set<string>();
  for (const text of texts) {
    for (const flag of flagsIn(text))
      if (!optionNames.has(flag)) unknown.add(`--${flag}`);
    for (const m of text.matchAll(
      /\bensemble ([a-z][a-z-]*)(?: ([a-z][a-z-]*))?/g,
    )) {
      const words = [m[1] ?? "", m[2] ?? ""].filter(Boolean);
      if (!knownCommand(words)) unknown.add(m[0]);
    }
  }
  // Every quoted `'ensemble ...'` command written in a CLI source file.
  let seen = 0;
  for (const name of readdirSync(sourceDir).filter((f) => f.endsWith(".ts")))
    for (const m of readFileSync(join(sourceDir, name), "utf8").matchAll(
      /'ensemble ([^'$]+)'/g,
    )) {
      seen++;
      for (const flag of flagProblems(m[1] ?? ""))
        unknown.add(`${name}: ${m[0]} --${flag}`);
    }
  assert.ok(seen > 20, `scanned ${seen} quoted commands`);
  assert.deepEqual([...unknown], []);
});

test("auth login ends with the doctor command that reaches the new login", async (t) => {
  const s = await startCliService(t);
  const h = harness(t);
  const login = async (
    name: string,
    extra: Parameters<typeof h.run>[1] = {},
    ...more: string[]
  ) =>
    h.run(
      [
        "auth",
        "login",
        "--connection",
        name,
        "--url",
        s.origin,
        "--token-file",
        h.tokenFile((await s.issue("read", name)).token),
        ...more,
      ],
      extra,
    );
  const last = (text: string) => lines(text).at(-1);
  const reaches = async (command: string | undefined) => {
    const r = await h.run((command ?? "").split(" ").slice(1));
    assert.doesNotMatch(
      r.err,
      /connection-(ambiguous|not-found)/,
      command ?? "",
    );
  };

  let r = await login("home");
  assert.equal(r.code, 0, r.err);
  assert.equal(r.err, "");
  assert.match(lines(r.out)[0] ?? "", /^Logged in to home /);
  assert.equal(last(r.out), "Next: ensemble doctor");
  await reaches("ensemble doctor");

  // A second connection and no default: a bare doctor is ambiguous, so the line names the login.
  r = await login("work");
  assert.equal(r.code, 0, r.err);
  assert.equal(last(r.out), "Next: ensemble doctor --connection work");
  await reaches(last(r.out)?.slice("Next: ".length));

  // ENSEMBLE_CONNECTION decides what a bare doctor selects.
  const env = {
    ENSEMBLE_CLI_CONFIG_DIR: h.configDir,
    ENSEMBLE_CONNECTION: "home",
  };
  r = await login("work", { env });
  assert.equal(r.code, 0, r.err);
  assert.equal(last(r.out), "Next: ensemble doctor --connection work");
  r = await login("home", { env });
  assert.equal(last(r.out), "Next: ensemble doctor");

  // JSON carries neither the Next line nor anything on stderr.
  r = await login("home", {}, "--output", "json");
  assert.equal(r.code, 0, r.err);
  assert.equal(r.err, "");
  assert.deepEqual(Object.keys(r.json()).sort(), [
    "connection",
    "data",
    "observedAt",
    "schema",
    "service",
  ]);
  assert.ok(!r.out.includes("Next:"));
});
