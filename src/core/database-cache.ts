import type { Database } from "./store.js";

type SqlValue = string | number | Uint8Array | null;
type PreparedStatement = ReturnType<Database["prepare"]>;

export interface CachedDatabaseOptions {
  /** Maximum number of prepared statements retained by this facade. */
  capacity?: number;
  /** Called after cache invalidation on every close attempt. */
  close?: () => void;
  /**
   * Called after each successful `exec` or statement call with its SQL, bound
   * parameters (none for `exec`), whether a transaction is still open, and the
   * rows changed by a `run` or a non-transaction-control `exec`.
   */
  observer?: DatabaseObserver;
}

export type DatabaseObserver = (
  sql: string,
  parameters: readonly SqlValue[],
  inTransaction: boolean,
  changes?: number,
) => void;

const transactionControl =
  /^\s*(?:BEGIN|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE|PRAGMA)\b/i;

const defaultCapacity = 512;
const schemaCommands = new Set([
  "CREATE",
  "ALTER",
  "DROP",
  "REINDEX",
  "VACUUM",
]);
const readOnlyPragmasWithArguments = new Set([
  "COLLATION_LIST",
  "COMPILE_OPTIONS",
  "FOREIGN_KEY_CHECK",
  "FOREIGN_KEY_LIST",
  "FUNCTION_LIST",
  "INDEX_INFO",
  "INDEX_LIST",
  "INDEX_XINFO",
  "INTEGRITY_CHECK",
  "MODULE_LIST",
  "PRAGMA_LIST",
  "QUICK_CHECK",
  "STATS",
  "TABLE_INFO",
  "TABLE_LIST",
  "TABLE_XINFO",
]);
const mutatingPragmasWithoutArguments = new Set([
  "INCREMENTAL_VACUUM",
  "OPTIMIZE",
  "SHRINK_MEMORY",
  "WAL_CHECKPOINT",
]);

function statementsForClassification(sql: string): string[] {
  const statements: string[] = [];
  let statement = "";
  let quote: "'" | '"' | "`" | "]" | undefined;
  for (let index = 0; index < sql.length; index += 1) {
    const character = sql[index]!;
    const next = sql[index + 1];
    if (quote !== undefined) {
      if (quote === "'") statement += " ";
      else statement += character;
      if (character === quote) {
        if (next === quote) {
          if (quote !== "'") statement += next;
          index += 1;
        } else {
          quote = undefined;
        }
      }
      continue;
    }
    if (character === "-" && next === "-") {
      while (index < sql.length && sql[index] !== "\n" && sql[index] !== "\r")
        index += 1;
      statement += " ";
    } else if (character === "/" && next === "*") {
      index += 2;
      while (
        index < sql.length &&
        !(sql[index] === "*" && sql[index + 1] === "/")
      )
        index += 1;
      index += 1;
      statement += " ";
    } else if (character === "'") {
      quote = "'";
      statement += " ";
    } else if (character === '"' || character === "`") {
      quote = character;
      statement += character;
    } else if (character === "[") {
      quote = "]";
      statement += character;
    } else if (character === ";") {
      statements.push(statement);
      statement = "";
    } else {
      statement += character;
    }
  }
  statements.push(statement);
  return statements;
}

function unquoteIdentifier(identifier: string): string {
  if (identifier.startsWith('"'))
    return identifier.slice(1, -1).replaceAll('""', '"');
  if (identifier.startsWith("`"))
    return identifier.slice(1, -1).replaceAll("``", "`");
  if (identifier.startsWith("["))
    return identifier.slice(1, -1).replaceAll("]]", "]");
  return identifier;
}

function invalidatesStatements(sql: string): boolean {
  const identifier =
    '(?:"(?:""|[^"])*"|`(?:``|[^`])*`|\\[(?:\\]\\]|[^\\]])+\\]|[\\w]+)';
  const pragmaPattern = new RegExp(
    `^\\s*PRAGMA\\s+(${identifier})(?:\\s*\\.\\s*(${identifier}))?(.*)$`,
    "i",
  );
  return statementsForClassification(sql).some((statement) => {
    const command = /^\s*(\w+)/.exec(statement)?.[1]?.toUpperCase();
    if (command === "ROLLBACK" || (command && schemaCommands.has(command)))
      return true;
    if (command !== "PRAGMA") return false;

    const pragma = pragmaPattern.exec(statement);
    if (pragma === null) return false;
    const name = unquoteIdentifier(pragma[2] ?? pragma[1]!).toUpperCase();
    const argumentsOrAssignment = pragma[3]!;
    return (
      /^\s*(?:=|\bTO\b)/i.test(argumentsOrAssignment) ||
      (argumentsOrAssignment.trimStart().startsWith("(") &&
        !readOnlyPragmasWithArguments.has(name)) ||
      (mutatingPragmasWithoutArguments.has(name) &&
        argumentsOrAssignment.trim() === "")
    );
  });
}

/**
 * A bounded, per-database LRU cache for parameterized prepared statements.
 * It retains statements only: each call still executes against the database.
 */
export class CachedDatabase implements Database {
  private readonly statements = new Map<string, PreparedStatement>();
  private readonly capacity: number;
  private readonly closeCallback: () => void;
  private readonly observer: DatabaseObserver | undefined;
  private totalChangesStatement: PreparedStatement | undefined;
  private closed = false;
  declare readonly isTransaction?: boolean;

  constructor(
    private readonly database: Database,
    options: CachedDatabaseOptions = {},
  ) {
    this.capacity = options.capacity ?? defaultCapacity;
    if (!Number.isSafeInteger(this.capacity) || this.capacity < 1)
      throw new RangeError(
        "Statement cache capacity must be a positive safe integer",
      );
    this.closeCallback = options.close ?? (() => undefined);
    this.observer = options.observer;
    if (database.isTransaction !== undefined)
      Object.defineProperty(this, "isTransaction", {
        configurable: false,
        enumerable: true,
        get: () => database.isTransaction,
      });
  }

  get isOpen(): boolean {
    return !this.closed;
  }

  exec(sql: string): unknown {
    this.assertOpen();
    if (invalidatesStatements(sql)) this.invalidate();
    if (!this.observer || transactionControl.test(sql)) {
      const result = this.database.exec(sql);
      this.observe(sql, []);
      return result;
    }
    const before = this.totalChanges();
    const result = this.database.exec(sql);
    this.observe(sql, [], this.totalChanges() - before);
    return result;
  }

  prepare(sql: string): PreparedStatement {
    this.assertOpen();
    const statement = this.statements.get(sql);
    if (statement !== undefined) {
      this.statements.delete(sql);
      this.statements.set(sql, statement);
      return statement;
    }

    const rawStatement = this.database.prepare(sql);
    const invalidatesOnRun = invalidatesStatements(sql);
    const wrapper: PreparedStatement = {
      run: (...parameters: SqlValue[]) => {
        this.assertOpen();
        if (invalidatesOnRun) this.invalidate();
        const result = rawStatement.run(...parameters);
        const changes = (result as { changes?: unknown } | undefined)?.changes;
        this.observe(
          sql,
          parameters,
          changes === undefined ? undefined : Number(changes),
        );
        return result;
      },
      get: (...parameters: SqlValue[]) => {
        this.assertOpen();
        const result = rawStatement.get(...parameters);
        this.observe(sql, parameters);
        return result;
      },
      all: (...parameters: SqlValue[]) => {
        this.assertOpen();
        const result = rawStatement.all(...parameters);
        this.observe(sql, parameters);
        return result;
      },
    };

    this.statements.set(sql, wrapper);
    if (this.statements.size > this.capacity) {
      const oldest = this.statements.keys().next();
      if (!oldest.done) this.statements.delete(oldest.value);
    }
    return wrapper;
  }

  /**
   * Invalidate cached references before every raw close attempt. The facade
   * stays unusable after a failed attempt, while a later call can retry close.
   */
  close(): void {
    this.invalidate();
    this.closed = true;
    this.closeCallback();
  }

  private observe(
    sql: string,
    parameters: readonly SqlValue[],
    changes?: number,
  ): void {
    this.observer?.(
      sql,
      parameters,
      this.database.isTransaction === true,
      changes,
    );
  }

  private totalChanges(): number {
    this.totalChangesStatement ??= this.database.prepare(
      "SELECT total_changes() AS n",
    );
    return Number(
      (this.totalChangesStatement.get() as { n: unknown } | undefined)?.n,
    );
  }

  private invalidate(): void {
    this.statements.clear();
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("Database facade is closed");
  }
}
