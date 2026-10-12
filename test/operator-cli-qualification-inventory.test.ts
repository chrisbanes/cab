import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { browseCommands, writeCommands } from "../src/cli/commands.js";

/**
 * Guards the CLI8 (#901) qualification inventory against the live command
 * registry: a representative journey cannot qualify an omitted command, and no
 * row may claim more than its cited evidence supports.
 */
const root = join(import.meta.dirname, "../..");

/** Commands registered in main.ts rather than the browse and write registries. */
const mainOnly = [
  "auth login",
  "auth status",
  "auth logout",
  "connection list",
  "connection use",
  "connection remove",
  "task get",
];

const areas = [
  "auth/connection",
  "project",
  "profile",
  "task",
  "assignment",
  "inbox/question/approval",
  "execution/logs",
  "recovery",
  "result/artifact/delivery",
  "operation",
];

/** The journey harness steps a row may cite (the lead's fixed step list). */
const harnessSteps = [
  "install",
  "login-keychain",
  "login-token-file",
  "auth-status",
  "connection-list",
  "connection-use",
  "connection-remove",
  "auth-logout",
  "task-list",
  "task-search",
  "task-get",
  "result-get",
  "result-list",
  "execution-list",
  "execution-get",
  "execution-inputs",
  "logs",
  "logs-follow-revoke",
  "assignment-get",
  "assignment-instructions",
  "profile-get",
  "profile-revisions",
  "profile-instructions",
  "readonly-denial-cli",
  "readonly-denial-direct",
  "profile-prepare",
  "profile-apply",
  "profile-apply-replay",
  "concurrent-conflict",
  "project-prepare",
  "project-apply-lost-response",
  "operation-get",
  "assignment-apply-current",
  "task-stop",
  "task-follow-up",
  "task-resume",
  "task-message",
  "remote-authority",
];

const stateSet = ["passed", "bounded", "unproved"];
const scenarioIds = ["CLI01", "CLI02", "CLI03", "CLI04", "CLI05", "CLI06"];

type Row = {
  id: string;
  kind: "command" | "operation";
  area: string;
  scenarios: string[];
  evidence: string[];
  effect: string;
  denial: string;
  revision: string;
  retry: string;
  observation: string;
  state: string;
  gap?: string;
};
type Inventory = {
  states: Record<string, string>;
  scenarios: Record<string, { state: string; basis: string; pending?: string }>;
  rows: Row[];
  excluded: { id: string; reason: string }[];
};

const evidenceDir = join(root, "docs/evidence");
const files = readdirSync(evidenceDir).filter((f) =>
  /^issue-901-cli8-inventory-.*\.json$/.test(f),
);
assert.equal(files.length, 1, `one CLI8 inventory file, found: ${files}`);
const inventory = JSON.parse(
  readFileSync(join(evidenceDir, files[0] as string), "utf8"),
) as Inventory;
const commandRows = inventory.rows.filter((r) => r.kind === "command");
const nonEmpty = (s: unknown) => typeof s === "string" && s.trim().length > 0;

/** A cited test names the command as adjacent literals, or as its whole key. */
function namesCommand(testFile: string, command: string) {
  const text = readFileSync(join(root, testFile), "utf8");
  const quote = "[\"'`]";
  const parts = command.split(" ");
  const adjacent = parts.join(`${quote},\\s*${quote}`);
  return new RegExp(
    `${quote}${adjacent}${quote}|${quote}${command}${quote}`,
  ).test(text);
}

test("command rows equal the live command registry", () => {
  const expected = new Set([
    ...browseCommands.keys(),
    ...writeCommands.keys(),
    ...mainOnly,
  ]);
  const ids = inventory.rows.map((r) => r.id);
  assert.deepEqual(
    ids.filter((id, i) => ids.indexOf(id) !== i),
    [],
    "row ids are unique",
  );
  const actual = new Set(commandRows.map((r) => r.id));
  const missing = [...expected].filter((c) => !actual.has(c));
  const extra = [...actual].filter((c) => !expected.has(c));
  assert.deepEqual(
    missing,
    [],
    `commands without an inventory row: ${missing}`,
  );
  assert.deepEqual(extra, [], `inventory rows for unknown commands: ${extra}`);
});

test("operations without a command are explicit", () => {
  const operations = inventory.rows.filter((r) => r.kind === "operation");
  assert.ok(operations.length > 0);
  for (const row of operations)
    assert.ok(
      row.state === "passed" || nonEmpty(row.gap),
      `${row.id}: gap required`,
    );
  const capture = operations.find((r) => /diagnosticCapture/.test(r.id));
  assert.ok(
    capture,
    "the project diagnosticCapture prepare operation is listed",
  );
  assert.equal(capture.area, "project");
  assert.equal(capture.state, "unproved");
});

test("every row names scenarios, area, existing evidence, a closed state and its gap", () => {
  for (const row of inventory.rows) {
    const at = `${row.kind} row "${row.id}"`;
    assert.ok(["command", "operation"].includes(row.kind), at);
    assert.ok(nonEmpty(row.id) && nonEmpty(row.effect), `${at}: id and effect`);
    for (const field of ["denial", "revision", "retry"] as const)
      assert.ok(nonEmpty(row[field]), `${at}: ${field} (or n/a: reason)`);
    assert.ok(areas.includes(row.area), `${at}: unknown area ${row.area}`);
    assert.ok(row.scenarios.length > 0, `${at}: scenario required`);
    for (const s of row.scenarios)
      assert.ok(scenarioIds.includes(s), `${at}: unknown scenario ${s}`);
    assert.ok(row.evidence.length > 0, `${at}: evidence required`);
    for (const e of row.evidence) {
      if (e.startsWith("harness:"))
        assert.ok(
          harnessSteps.includes(e.slice("harness:".length)),
          `${at}: unknown harness step ${e}`,
        );
      else assert.ok(existsSync(join(root, e)), `${at}: missing evidence ${e}`);
    }
    assert.ok(stateSet.includes(row.state), `${at}: state ${row.state}`);
    assert.ok(
      ["real", "synthetic"].includes(row.observation),
      `${at}: observation ${row.observation}`,
    );
    if (row.state !== "passed")
      assert.ok(nonEmpty(row.gap), `${at}: gap required while ${row.state}`);
    if (row.state === "passed") {
      // Passed rows cite the dated live record, and at least one harness step that
      // the record shows as a real run with its expected exit.
      const live = row.evidence.find((e) =>
        /^docs\/evidence\/issue-901-cli8-live-.+\.json$/.test(e),
      );
      assert.ok(live, `${at}: passed needs a CLI8 live record`);
      const record = JSON.parse(readFileSync(join(root, live), "utf8")) as {
        mode: string;
        steps: {
          step: string;
          exit: number | null;
          expected: number | null;
          observation: string;
        }[];
      };
      assert.equal(record.mode, "live", `${at}: ${live} is not a live run`);
      assert.ok(
        row.evidence.some((e) =>
          record.steps.some(
            (step) =>
              `harness:${step.step}` === e &&
              step.observation === "real" &&
              step.exit !== null &&
              step.exit === step.expected,
          ),
        ),
        `${at}: no cited harness step ran as expected in ${live}`,
      );
      assert.equal(
        row.observation,
        "real",
        `${at}: passed needs real evidence`,
      );
    }
  }
});

test("each command row cites a test that names the command", () => {
  for (const row of commandRows) {
    const tests = row.evidence.filter((e) => /^test\/.+\.test\.ts$/.test(e));
    assert.ok(
      tests.some((e) => namesCommand(e, row.id)),
      `${row.id}: none of ${tests} names the command`,
    );
  }
});

test("CLI01-CLI06 each have a disposition and every area has a row", () => {
  assert.deepEqual(Object.keys(inventory.scenarios).sort(), scenarioIds);
  for (const id of scenarioIds) {
    const scenario = inventory.scenarios[id];
    assert.ok(scenario && stateSet.includes(scenario.state), `${id}: state`);
    assert.ok(nonEmpty(scenario.basis), `${id}: basis`);
  }
  assert.deepEqual(Object.keys(inventory.states).sort(), [...stateSet].sort());
  for (const area of areas)
    assert.ok(
      inventory.rows.some((r) => r.area === area),
      `area without a row: ${area}`,
    );
  const rowIds = new Set(inventory.rows.map((r) => r.id));
  for (const x of inventory.excluded) {
    assert.ok(
      nonEmpty(x.id) && !rowIds.has(x.id),
      `excluded ${x.id} is not a row`,
    );
    assert.match(x.reason, /^design excludes from first release: /, x.id);
  }
});
