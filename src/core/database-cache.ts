import type { Database } from "./store.js";

type SqlValue = string | number | Uint8Array | null;
type PreparedStatement = ReturnType<Database["prepare"]>;

export interface CachedDatabaseOptions {
  /** Maximum number of prepared statements retained by this facade. */
  capacity?: number;
  /** Called after cache invalidation on every close attempt. */
  close?: () => void;
}

const defaultCapacity = 512;
const schemaCommands = new Set([
  "CREATE",
  "ALTER",
  "DROP",
  "REINDEX",
  "VACUUM",
]);
const mutatingPragmas = new Set([
  "ANALYSIS_LIMIT",
  "APPLICATION_ID",
  "AUTO_VACUUM",
  "BUSY_TIMEOUT",
  "CACHE_SIZE",
  "DEFER_FOREIGN_KEYS",
  "FOREIGN_KEYS",
  "INCREMENTAL_VACUUM",
  "JOURNAL_MODE",
  "LOCKING_MODE",
  "MMAP_SIZE",
  "OPTIMIZE",
  "QUERY_ONLY",
  "SYNCHRONOUS",
  "SHRINK_MEMORY",
  "TEMP_STORE",
  "USER_VERSION",
  "WAL_CHECKPOINT",
]);
const mutatingPragmasWithoutArguments = new Set([
  "INCREMENTAL_VACUUM",
  "OPTIMIZE",
  "SHRINK_MEMORY",
  "WAL_CHECKPOINT",
]);

function sqlForClassification(sql: string): string {
  let output = "";
  for (let index = 0; index < sql.length; index += 1) {
    const character = sql[index]!;
    const next = sql[index + 1];
    if (character === "-" && next === "-") {
      while (index < sql.length && sql[index] !== "\n" && sql[index] !== "\r")
        index += 1;
      output += " ";
    } else if (character === "/" && next === "*") {
      index += 2;
      while (
        index < sql.length &&
        !(sql[index] === "*" && sql[index + 1] === "/")
      )
        index += 1;
      index += 1;
      output += " ";
    } else if (character === "'" || character === '"' || character === "`") {
      const quote = character;
      index += 1;
      while (index < sql.length) {
        if (sql[index] === quote) {
          if (sql[index + 1] === quote) index += 1;
          else break;
        }
        index += 1;
      }
      output += " ";
    } else if (character === "[") {
      while (index < sql.length && sql[index] !== "]") index += 1;
      output += " ";
    } else {
      output += character;
    }
  }
  return output;
}

function invalidatesStatements(sql: string): boolean {
  return sqlForClassification(sql)
    .split(";")
    .some((statement) => {
      const command = /^\s*(\w+)/.exec(statement)?.[1]?.toUpperCase();
      if (command === "ROLLBACK" || (command && schemaCommands.has(command)))
        return true;
      if (command !== "PRAGMA") return false;

      const pragma = /^\s*PRAGMA\s+([\w.]+)(.*)$/i.exec(statement);
      if (pragma === null) return false;
      const name = pragma[1]!.split(".").at(-1)!.toUpperCase();
      const argumentsOrAssignment = pragma[2]!;
      return (
        /^\s*(?:=|\bTO\b)/i.test(argumentsOrAssignment) ||
        (argumentsOrAssignment.trimStart().startsWith("(") &&
          mutatingPragmas.has(name)) ||
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
    if (database.isTransaction !== undefined)
      Object.defineProperty(this, "isTransaction", {
        configurable: false,
        enumerable: true,
        get: () => database.isTransaction,
      });
  }

  exec(sql: string): unknown {
    this.assertOpen();
    if (invalidatesStatements(sql)) this.invalidate();
    return this.database.exec(sql);
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
    const wrapper: PreparedStatement = {
      run: (...parameters: SqlValue[]) => {
        this.assertOpen();
        if (invalidatesStatements(sql)) this.invalidate();
        return rawStatement.run(...parameters);
      },
      get: (...parameters: SqlValue[]) => {
        this.assertOpen();
        return rawStatement.get(...parameters);
      },
      all: (...parameters: SqlValue[]) => {
        this.assertOpen();
        return rawStatement.all(...parameters);
      },
    };

    if (this.capacity > 0) {
      this.statements.set(sql, wrapper);
      if (this.statements.size > this.capacity) {
        const oldestSql = this.statements.keys().next().value as
          | string
          | undefined;
        if (oldestSql !== undefined) this.statements.delete(oldestSql);
      }
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

  private invalidate(): void {
    this.statements.clear();
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("Database facade is closed");
  }
}
