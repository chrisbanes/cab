import type { DatabaseSync } from "node:sqlite";
import { ExecutionDiagnosticsStore } from "../../src/standalone/execution-diagnostics.js";
import {
  instructionSecret,
  seedInstructionHistory,
} from "./instruction-history.js";
import type { createOperatorFixture } from "./operator-web.js";

type Fixture = Awaited<ReturnType<typeof createOperatorFixture>>;

function request(
  db: DatabaseSync,
  workId: string,
  values: {
    kind?: "direct" | "assignment";
    taskId?: string | null;
    projectId?: string | null;
    assignmentId?: string | null;
    state?: string;
    reason?: string | null;
  },
) {
  db.prepare(
    `INSERT INTO turn_requests (requestKey, workId, kind, taskId, projectId, assignmentId,
      taskVersion, assignmentVersion, instructionsRevision, profileRevision, prompt, state, reason)
      VALUES (?, ?, ?, ?, ?, ?, 1, 1, 1, 1, 'seeded prompt', ?, ?)`,
  ).run(
    `key:${workId}`,
    workId,
    values.kind ?? "assignment",
    values.taskId ?? null,
    values.projectId ?? null,
    values.assignmentId ?? null,
    values.state ?? "completed",
    values.reason ?? null,
  );
}

/**
 * Seeds instruction history plus three executions of lead A: one captured (stored
 * with no write-time exclusions, so reads must redact), one never captured and one
 * direct run. Captured payloads echo instruction text, a credential and a path.
 */
export async function seedExecutionDiagnostics(
  f: Fixture,
  options: { now?: () => number } = {},
) {
  const seeded = await seedInstructionHistory(f);
  const captured = `assignment:${seeded.assignmentA}:captured`,
    absent = `assignment:${seeded.assignmentA}:absent`,
    direct = "direct-run-1";
  const profileOne = seeded.text.profile[0] ?? "";
  const leak = `${instructionSecret} ${f.directory}/notes token=hunter2`;
  f.seedPersistedState((db) => {
    request(db, captured, {
      taskId: seeded.taskA,
      projectId: seeded.projectA,
      assignmentId: seeded.assignmentA,
      reason: `Failed near ${leak}`,
    });
    request(db, absent, {
      taskId: seeded.taskA,
      projectId: seeded.projectA,
      assignmentId: seeded.assignmentA,
      state: "held",
    });
    request(db, direct, { kind: "direct" });
    const store = new ExecutionDiagnosticsStore(db, {
      ...(options.now ? { now: options.now } : {}),
    });
    store.begin({
      workId: captured,
      taskId: seeded.taskA,
      projectId: seeded.projectA,
      assignmentId: seeded.assignmentA,
      assignmentVersion: 1,
      instructionsRevision: 1,
      profileRevision: 1,
      conversationRevision: 1,
      harness: "codex",
      mode: "enhanced",
      eventSource: "supported",
    });
    store.bindThread(captured, "thread-seeded");
    store.bindTurn(captured, "turn-seeded");
    const input = (name: string, text: string, revision?: number) =>
      store.record(
        captured,
        "input",
        name,
        "info",
        undefined,
        { text, ...(revision ? { revision } : {}) },
        [],
      );
    input("request", `Please echo ${profileOne}`);
    input("role", "Assignment role: project lead.");
    input("review-references", "Captured review references (JSON): {}");
    input(
      "project-instructions",
      `Captured project instructions (revision 1):\n${seeded.text.project[0]} ${leak}`,
      1,
    );
    input(
      "profile-instructions",
      `Captured profile instructions (revision 1):\n${profileOne} ${leak}`,
      1,
    );
    store.record(
      captured,
      "input",
      "submitted",
      "info",
      undefined,
      { bytes: 10, sha256: "a".repeat(64) },
      [],
    );
    store.record(
      captured,
      "setting",
      "settings",
      "info",
      undefined,
      {
        entries: [
          { name: "harness", value: "codex", source: "service-admitted" },
          { name: "model", value: "gpt-seeded", source: "runtime-reported" },
          { name: "serviceTier", value: null, source: "unknown" },
        ],
      },
      [],
    );
    store.record(
      captured,
      "runtime",
      "commandExecution/completed",
      "warn",
      "cmd-1",
      { command: `echo ${profileOne}`, aggregatedOutput: leak, exitCode: 1 },
      [],
    );
    store.record(
      captured,
      "tool",
      "ensemble_report_result",
      "info",
      "call-1",
      { arguments: { note: "ok" }, success: true },
      [],
    );
    store.finish(captured);
  });
  return { ...seeded, captured, absent, direct, profileOne, leak };
}
