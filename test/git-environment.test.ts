import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

// ponytail: this scan reads text, so it cannot see a dynamically built command. When #914
// moves repository verification out of core it becomes "src/core does not import
// node:child_process".
const spawnsProcesses = /from\s+["']node:child_process["']/;
const namesGit = /["'`]git["'`]/;

/** Files that can start Git without calling `gitEnvironment(`. */
function unhardenedGitSpawns(sources: ReadonlyMap<string, string>): string[] {
  return [...sources]
    .filter(
      ([, text]) =>
        spawnsProcesses.test(text) &&
        namesGit.test(text) &&
        !text.includes("gitEnvironment("),
    )
    .map(([path]) => path)
    .sort();
}

function productionSources(): Map<string, string> {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const sources = new Map<string, string>();
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".ts"))
        sources.set(relative(root, path), readFileSync(path, "utf8"));
    }
  };
  walk(join(root, "src"));
  return sources;
}

test("the scan flags a Git spawn that skips the shared environment", () => {
  const raw = `import { spawn } from "node:child_process";\nspawn("git", []);`;
  const hardened = `${raw}\nconst env = gitEnvironment();`;
  assert.deepEqual(
    unhardenedGitSpawns(
      new Map([
        ["raw.ts", raw],
        ["hardened.ts", hardened],
        [
          "other.ts",
          `import { spawn } from "node:child_process";\nspawn("ps")`,
        ],
      ]),
    ),
    ["raw.ts"],
  );
});

test("every production Git spawn uses the shared hardened environment", () => {
  const sources = productionSources();
  assert.ok(sources.size > 20, "the source tree was found");
  assert.deepEqual(unhardenedGitSpawns(sources), []);

  const gitFiles = [...sources]
    .filter(([, text]) => spawnsProcesses.test(text) && namesGit.test(text))
    .map(([path]) => path)
    .sort();
  assert.deepEqual(gitFiles, [
    join("src", "core", "github-source.ts"),
    join("src", "standalone", "git-process.ts"),
  ]);
  // These callers run Git only through the shared runner.
  for (const name of [
    "workspaces",
    "workspace-inspection",
    "workspace-comparison",
    "operator-setup",
  ])
    assert.equal(
      spawnsProcesses.test(
        sources.get(join("src", "standalone", `${name}.ts`)) ?? "",
      ),
      false,
      name,
    );
});
