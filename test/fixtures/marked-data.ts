import { DatabaseSync } from "node:sqlite";
import { StandaloneDataDirectory } from "../../src/standalone/data-directory.js";

/** A marked data directory with one table, as `test/operations.test.ts` builds it. */
export function markedDataDirectory(path: string): void {
  const owner = StandaloneDataDirectory.openExclusive(path);
  try {
    const db = new DatabaseSync(owner.databasePath);
    db.exec(
      "CREATE TABLE fixture (value TEXT); INSERT INTO fixture VALUES ('one');",
    );
    db.close();
  } finally {
    owner.close();
  }
}
