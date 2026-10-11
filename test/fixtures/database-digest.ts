import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

/** Digest of every persisted row except CLI credential last-use metadata. */
export function databaseDigest(f: {
  seedPersistedState(seed: (db: DatabaseSync) => void): void;
}): string {
  const hash = createHash("sha256");
  f.seedPersistedState((db) => {
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as { name: string }[];
    for (const { name } of tables) {
      if (name === "operator_cli_credentials") continue;
      const rows = db.prepare(`SELECT * FROM "${name}"`).all();
      hash.update(
        `${name}\n${JSON.stringify(
          rows
            .map((r) =>
              JSON.stringify(r, (_, v) =>
                typeof v === "bigint" ? String(v) : v,
              ),
            )
            .sort(),
        )}\n`,
      );
    }
  });
  return hash.digest("hex");
}
