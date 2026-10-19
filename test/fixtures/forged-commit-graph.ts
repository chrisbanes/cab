import { createHash } from "node:crypto";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";

/**
 * Rewrites a SHA-1 commit-graph file so `child` names `parent` as its first parent, then fixes the
 * trailing checksum. Git trusts the graph for ancestry queries without rereading the commits.
 */
export function forgeCommitGraphParent(
  path: string,
  child: string,
  parent: string,
): void {
  const file = readFileSync(path);
  const chunks = file[6] ?? 0;
  const table = new Map<string, number>();
  for (let i = 0; i < chunks; i++) {
    const at = 8 + i * 12;
    table.set(
      file.toString("ascii", at, at + 4),
      Number(file.readBigUInt64BE(at + 4)),
    );
  }
  const lookup = table.get("OIDL");
  const data = table.get("CDAT");
  const fanout = table.get("OIDF");
  if (lookup === undefined || data === undefined || fanout === undefined)
    throw new Error("unexpected commit-graph layout");
  const count = file.readUInt32BE(fanout + 255 * 4);
  const indexOf = (id: string) => {
    for (let i = 0; i < count; i++)
      if (file.toString("hex", lookup + i * 20, lookup + i * 20 + 20) === id)
        return i;
    throw new Error(`commit ${id} is not in the graph`);
  };
  // CDAT entry: tree (20), parent 1 (4), parent 2 (4), generation and date (8).
  file.writeUInt32BE(indexOf(parent), data + indexOf(child) * 36 + 20);
  file.writeUInt32BE(0x70000000, data + indexOf(child) * 36 + 24);
  const body = file.subarray(0, file.length - 20);
  const sum = createHash("sha1").update(body).digest();
  sum.copy(file, file.length - 20);
  chmodSync(path, 0o644);
  writeFileSync(path, file);
}
