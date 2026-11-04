import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { OperatorWebBundle } from "../../src/standalone/operator-web.js";

/** A validated static shell for tests of the HTTP/API boundary, without a browser build. */
export async function syntheticOperatorBundle(directory: string) {
  const path = join(directory, "synthetic-operator");
  await mkdir(join(path, "assets"), { recursive: true });
  await writeFile(join(path, "index.html"), "<!doctype html><html></html>");
  return OperatorWebBundle.open(path);
}
