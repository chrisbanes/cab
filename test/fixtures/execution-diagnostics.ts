import { randomUUID } from "node:crypto";
import { ConversationHistoryStore } from "../../src/standalone/conversation-history.js";
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
  options: { now?: () => number; unchanged?: boolean } = {},
) {
  const seeded = await seedInstructionHistory(f);
  const captured = `assignment:${seeded.assignmentA}:captured`,
    absent = `assignment:${seeded.assignmentA}:absent`,
    direct = "direct-run-1",
    unchanged = `assignment:${seeded.assignmentA}:unchanged`;
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
    // A resumed turn whose thread already held both instruction revisions.
    if (options.unchanged) {
      request(db, unchanged, {
        taskId: seeded.taskA,
        projectId: seeded.projectA,
        assignmentId: seeded.assignmentA,
      });
      const resumed = new ExecutionDiagnosticsStore(db);
      resumed.begin({
        workId: unchanged,
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
      resumed.bindThread(unchanged, "thread-seeded");
      resumed.bindTurn(unchanged, "turn-unchanged");
      const note = (name: string, payload: Record<string, unknown>) =>
        resumed.record(
          unchanged,
          "input",
          name,
          "info",
          undefined,
          payload,
          [],
        );
      note("request", { text: "Continue." });
      note("project-instructions", { revision: 1, sent: false });
      note("profile-instructions", { revision: 1, sent: false });
      note("submitted", { bytes: 9, sha256: "b".repeat(64) });
      resumed.finish(unchanged);
    }
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
      `Project instructions:\n${seeded.text.project[0]} ${leak}`,
      1,
    );
    input(
      "profile-instructions",
      `Profile instructions:\n${profileOne} ${leak}`,
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
      "cab_report_result",
      "info",
      "call-1",
      { arguments: { note: "ok" }, success: true },
      [],
    );
    store.finish(captured);
  });
  return { ...seeded, captured, absent, direct, unchanged, profileOne, leak };
}

/** A real retained Claude turn with an independently retained diagnostic settlement. */
export function seedExecutionReasoningSummary(
  f: Fixture,
  seed: Awaited<ReturnType<typeof seedExecutionDiagnostics>>,
  options: {
    text?: string;
    settled?: boolean;
    state?: "completed" | "failed";
    limits?: Partial<
      import("../../src/standalone/execution-diagnostics.js").DiagnosticLimits
    >;
    failSettlement?: boolean;
    captured?: boolean;
  } = {},
) {
  const workId = randomUUID(),
    intentId = randomUUID();
  const binding = {
    workId,
    taskId: seed.taskA,
    assignmentId: seed.assignmentA,
    assignmentVersion: 1,
    instructionsRevision: 1,
    profileRevision: 1,
    conversationRevision: 1,
    workRevision: 1,
    threadId: randomUUID(),
    turnId: randomUUID(),
  };
  const at = Date.now();
  f.seedPersistedState((db) => {
    request(db, workId, {
      taskId: seed.taskA,
      projectId: seed.projectA,
      assignmentId: seed.assignmentA,
      state: options.state === "failed" ? "held" : "completed",
    });
    db.prepare(`INSERT INTO execution_intents(id,workId,prompt,workspace,state,threadId,turnId,accountType,sandbox,approval)
      VALUES (?,?,'fixture',?,?,?,?,'chatgpt','workspaceWrite','never')`).run(
      intentId,
      workId,
      f.directory,
      options.state === "failed" ? "held" : "completed",
      binding.threadId,
      binding.turnId,
    );
    db.prepare(`INSERT INTO task_execution_bindings(workId,taskId,assignmentId,assignmentVersion,instructionsRevision,profileRevision,conversationRevision,harness)
      VALUES (?,?,?,1,1,1,1,'claude')`).run(
      workId,
      seed.taskA,
      seed.assignmentA,
    );
    binding.workRevision = Number(
      db
        .prepare(
          `SELECT COALESCE(MAX(workRevision),0)+1 AS revision FROM task_work_revisions WHERE assignmentId=? AND conversationRevision=1`,
        )
        .get(seed.assignmentA)!.revision,
    );
    db.prepare(
      `INSERT INTO task_work_revisions(workId,assignmentId,conversationRevision,workRevision) VALUES (?,?,1,?)`,
    ).run(workId, seed.assignmentA, binding.workRevision);
    db.prepare(
      `INSERT INTO execution_intent_reasoning_summaries(intentId,enabled,captureMode,generation) VALUES (?,1,'enhanced',0)`,
    ).run(intentId);
    new ConversationHistoryStore(db).recordReasoningSummary(
      binding,
      intentId,
      options.text ?? "Retained summary",
      [],
    );
    if (options.captured === false) return;
    const store = new ExecutionDiagnosticsStore(db, {
      now: () => at,
      ...(options.limits ? { limits: options.limits } : {}),
    });
    store.begin({
      ...binding,
      projectId: seed.projectA,
      harness: "claude",
      mode: "enhanced",
      eventSource: "supported",
    });
    store.bindThread(workId, binding.threadId);
    store.bindTurn(workId, binding.turnId);
    store.record(
      workId,
      "runtime",
      "before-settlement",
      "info",
      undefined,
      { text: "before" },
      [],
    );
    if (options.failSettlement)
      db.exec(
        `CREATE TRIGGER fail_summary_settlement BEFORE INSERT ON diagnostic_items WHEN NEW.name='execution-settled' BEGIN SELECT RAISE(FAIL,'fixture settlement failure'); END`,
      );
    if (options.settled !== false)
      store.record(
        workId,
        "service",
        "execution-settled",
        "info",
        undefined,
        { outcome: options.state ?? "completed" },
        [],
      );
    if (options.failSettlement) db.exec("DROP TRIGGER fail_summary_settlement");
    store.record(
      workId,
      "tool",
      "after-settlement",
      "warn",
      undefined,
      { text: "after" },
      [],
    );
    store.finish(workId);
  });
  return { workId, binding, intentId, at };
}
