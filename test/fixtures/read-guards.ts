import { randomUUID } from "node:crypto";
import { StatementSync } from "node:sqlite";
import type { TestContext } from "node:test";
import type { createOperatorFixture } from "./operator-web.js";

type Fixture = Awaited<ReturnType<typeof createOperatorFixture>>;

/** A view of `target` whose listed methods throw; everything else runs on the target. */
export function forbid<T extends object>(
  target: T,
  names: readonly string[],
): T {
  return new Proxy(target, {
    get(object, property) {
      if (typeof property === "string" && names.includes(property))
        return () => {
          throw Error(`Full-history read: ${property}`);
        };
      const value = Reflect.get(object, property, object);
      return typeof value === "function" ? value.bind(object) : value;
    },
  });
}

const historyTables =
  /\b(turn_requests|execution_intents|execution_recovery_identities|task_execution_bindings|coordination_delivery_batches)\b/;

/**
 * Counts history-table rows returned to operator read code. Statements issued by
 * background service work are not counted: only calls whose synchronous stack
 * passes through the operator read modules are.
 */
export function historyRowCounter(t: TestContext) {
  let rows = 0;
  const reader = /operator-api|operator-runtime|coordination-view/;
  const count = (sql: string, returned: number) => {
    if (!historyTables.test(sql)) return;
    const limit = Error.stackTraceLimit;
    Error.stackTraceLimit = 64;
    const stack = Error().stack ?? "";
    Error.stackTraceLimit = limit;
    if (reader.test(stack)) rows += returned;
  };
  const all = StatementSync.prototype.all,
    get = StatementSync.prototype.get;
  t.mock.method(
    StatementSync.prototype,
    "all",
    function (this: StatementSync, ...args: Parameters<StatementSync["all"]>) {
      const result = all.apply(this, args);
      count(this.sourceSQL, result.length);
      return result;
    },
  );
  t.mock.method(
    StatementSync.prototype,
    "get",
    function (this: StatementSync, ...args: Parameters<StatementSync["get"]>) {
      const result = get.apply(this, args);
      count(this.sourceSQL, result === undefined ? 0 : 1);
      return result;
    },
  );
  return {
    async measure<T>(read: () => Promise<T> | T): Promise<[T, number]> {
      const before = rows;
      const value = await read();
      return [value, rows - before];
    },
  };
}

/**
 * Completed generations bound to tasks and assignments that do not exist: an
 * intent, recovery identity and binding, and/or a turn request each. With
 * `owner`, they belong to that task and assignment (version 1, revisions 1/1) so
 * only the count bound can reject them.
 */
export function seedOrphanHistory(
  f: Fixture,
  count: number,
  kinds = { requests: true, recovery: true },
  owner?: { taskId: string; projectId: string; assignmentId: string },
) {
  f.seedPersistedState((db) => {
    db.exec("BEGIN");
    for (let i = 0; i < count; i++) {
      const workId = `orphan-${randomUUID()}`,
        taskId = owner?.taskId ?? randomUUID(),
        assignmentId = owner?.assignmentId ?? randomUUID();
      if (kinds.recovery) {
        db.prepare(
          "INSERT INTO execution_intents (id,workId,prompt,workspace,state,accountType,sandbox,approval) VALUES (?,?,'ORPHAN PROMPT','/orphan','completed','chatgpt','workspaceWrite','never')",
        ).run(randomUUID(), workId);
        db.prepare(
          "INSERT INTO execution_recovery_identities (workId,workRevision,requestSequence) VALUES (?,1,1)",
        ).run(workId);
        db.prepare(
          "INSERT INTO task_execution_bindings (workId,taskId,assignmentId,assignmentVersion,instructionsRevision,profileRevision,conversationRevision) VALUES (?,?,?,1,1,1,1)",
        ).run(workId, taskId, assignmentId);
      }
      if (kinds.requests)
        db.prepare(
          "INSERT INTO turn_requests (requestKey,workId,kind,taskId,projectId,assignmentId,assignmentVersion,instructionsRevision,profileRevision,prompt,state) VALUES (?,?,'assignment',?,?,?,1,1,1,'ORPHAN PROMPT','completed')",
        ).run(
          randomUUID(),
          workId,
          taskId,
          owner?.projectId ?? randomUUID(),
          assignmentId,
        );
    }
    db.exec("COMMIT");
  });
}
