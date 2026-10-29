import { createHash } from "node:crypto";
import { lstat, readdir, readFile, readlink } from "node:fs/promises";
import { join } from "node:path";

const sha256 = (bytes: Buffer | string) =>
  createHash("sha256").update(bytes).digest("hex");

/**
 * cab-tree-sha256/v1 over a release root, excluding the root manifest.json. The same
 * algorithm as scripts/package-release.mjs, which runs before any build and so keeps its
 * own copy; a test holds the two equal.
 */
export async function treeDigest(root: string): Promise<string> {
  const lines: [path: string, line: string][] = [];
  const walk = async (relative: string): Promise<void> => {
    for (const entry of await readdir(join(root, relative))) {
      const path = relative ? `${relative}/${entry}` : entry;
      if (path === "manifest.json") continue;
      if (path.includes("\n")) throw new Error(`Unsupported path ${path}`);
      const full = join(root, path);
      const stat = await lstat(full);
      if (stat.isDirectory()) await walk(path);
      else if (stat.isSymbolicLink())
        lines.push([path, `link ${await readlink(full)} ${path}\n`]);
      else if (stat.isFile())
        lines.push([
          path,
          `file ${stat.mode & 0o111 ? "0755" : "0644"} ${sha256(await readFile(full))} ${path}\n`,
        ]);
      else throw new Error(`Unsupported file type at ${path}`);
    }
  };
  await walk("");
  lines.sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  return sha256(lines.map(([, line]) => line).join(""));
}
