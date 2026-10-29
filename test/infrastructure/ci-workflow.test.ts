import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

const { ciFailures } = (await import(
  pathToFileURL(resolve("scripts/check-ci-results.mjs")).href
)) as {
  ciFailures(jobs: unknown, full: boolean, run?: boolean): string[];
};
const { previousNightlyRun, nightlyChanged, docsOnly } = (await import(
  pathToFileURL(resolve("scripts/check-changes.mjs")).href
)) as {
  docsOnly(paths: string[]): boolean;
  previousNightlyRun(
    id: string,
    fetchPage: (page: number) => Promise<{
      runs: Array<{
        id: number;
        head_sha?: string;
        status?: string;
        conclusion?: string | null;
      }>;
      hasNext: boolean;
    }>,
  ): Promise<{
    id: number;
    head_sha: string;
    status?: string;
    conclusion?: string | null;
  } | null>;
  nightlyChanged(
    sha: string,
    previous: {
      head_sha: string;
      status?: string;
      conclusion?: string | null;
    } | null,
  ): boolean;
};

test("nightly commit comparison excludes the current run and newer runs, including on reruns", async () => {
  const previous = await previousNightlyRun("20", async () => ({
    runs: [
      { id: 21, head_sha: "newer" },
      { id: 20, head_sha: "current" },
      { id: 18, head_sha: "older" },
      {
        id: 19,
        head_sha: "previous",
        status: "completed",
        conclusion: "success",
      },
    ],
    hasNext: false,
  }));
  assert.equal(previous?.id, 19);
  assert.equal(nightlyChanged("previous", previous), false);
  assert.equal(nightlyChanged("current", previous), true);
  assert.equal(nightlyChanged("first", null), true);
});

test("unchanged nightlies rerun after failure, cancellation or incomplete qualification", () => {
  for (const conclusion of [
    "failure",
    "cancelled",
    "timed_out",
    "action_required",
    "neutral",
    "skipped",
    "stale",
    null,
  ])
    assert.equal(
      nightlyChanged("same", {
        head_sha: "same",
        status: "completed",
        conclusion,
      }),
      true,
    );
  for (const status of ["queued", "in_progress", "waiting", "pending"])
    assert.equal(
      nightlyChanged("same", { head_sha: "same", status, conclusion: null }),
      true,
    );
  assert.equal(nightlyChanged("same", { head_sha: "same" }), true);
  assert.equal(
    nightlyChanged("same", {
      head_sha: "same",
      status: "in_progress",
      conclusion: "success",
    }),
    true,
  );
  assert.equal(
    nightlyChanged("same", {
      head_sha: "same",
      status: "completed",
      conclusion: "success",
    }),
    false,
  );
});

test("a failed nearest nightly cannot be masked by an older successful run", async () => {
  const previous = await previousNightlyRun("20", async () => ({
    runs: [
      { id: 18, head_sha: "same", status: "completed", conclusion: "success" },
      { id: 19, head_sha: "same", status: "completed", conclusion: "failure" },
    ],
    hasNext: false,
  }));
  assert.equal(previous?.id, 19);
  assert.equal(nightlyChanged("same", previous), true);
});

test("nightly history pagination finds the previous run and lookup errors cannot skip CI", async () => {
  const pages: number[] = [];
  const previous = await previousNightlyRun("20", async (page) => {
    pages.push(page);
    return page === 1
      ? { runs: [{ id: 21, head_sha: "newer" }], hasNext: true }
      : { runs: [{ id: 19, head_sha: "previous" }], hasNext: false };
  });
  assert.deepEqual(pages, [1, 2]);
  assert.equal(previous?.head_sha, "previous");
  assert.equal(
    await previousNightlyRun("20", async () => ({ runs: [], hasNext: false })),
    null,
  );
  await assert.rejects(
    previousNightlyRun("20", async () => {
      throw Error("API unavailable");
    }),
    /API unavailable/,
  );
  await assert.rejects(
    previousNightlyRun("20", async () => ({
      runs: [{ id: 19 }],
      hasNext: false,
    })),
    /no commit SHA/,
  );
});
test("pull requests skip checks only when every change is untested documentation", () => {
  assert.equal(docsOnly(["README.md", "docs/adr/1021-profile.md"]), true);
  for (const paths of [
    [],
    ["README.md", "src/index.ts"],
    ["docs/adr/diagram.png"],
    ["test/fixtures/notes.md"],
    ["design/DESIGN.md"],
  ])
    assert.equal(docsOnly(paths), false, paths.join());
  // Documents read by tests (quoted paths, not comments) must not be skippable.
  const docs = readdirSync("test", { recursive: true, encoding: "utf8" })
    .filter(
      (path) =>
        /\.(ts|mjs)$/.test(path) && !path.endsWith("ci-workflow.test.ts"),
    )
    .flatMap(
      (path) =>
        readFileSync(join("test", path), "utf8").match(
          /(?<=["'`](?:\.\.\/)*)docs\/[\w./-]+/g,
        ) ?? [],
    );
  assert.ok(docs.length);
  for (const doc of docs.filter((d) => d.endsWith(".md") || !d.includes(".")))
    assert.equal(
      docsOnly([doc.endsWith(".md") ? doc : `${doc}/any.md`]),
      false,
      doc,
    );
});
function successful(full: boolean) {
  return {
    changes: { result: "success" },
    quality: { result: "success" },
    suites: { result: "success" },
    "service-node26": { result: full ? "skipped" : "success" },
    "compatibility-node26": { result: full ? "success" : "skipped" },
  };
}
test("aggregate check accepts complete PR and compatibility runs", () => {
  assert.deepEqual(ciFailures(successful(false), false), []);
  assert.deepEqual(ciFailures(successful(true), true), []);
});
test("unchanged nightly and documentation-only skips require a successful change gate and every test job skipped", () => {
  const skipped = Object.fromEntries(
    Object.keys(successful(true)).map((name) => [
      name,
      { result: name === "changes" ? "success" : "skipped" },
    ]),
  );
  assert.deepEqual(ciFailures(skipped, true, false), []);
  assert.deepEqual(ciFailures(skipped, false, false), []);
  for (const name of Object.keys(skipped)) {
    assert.ok(
      ciFailures({ ...skipped, [name]: { result: "failure" } }, true, false)
        .length,
    );
    assert.ok(
      ciFailures({ ...skipped, [name]: { result: "failure" } }, false, false)
        .length,
    );
    const missing = { ...skipped };
    delete missing[name];
    assert.ok(ciFailures(missing, true, false).length);
    assert.ok(ciFailures(missing, false, false).length);
  }
});
test("failed, cancelled, missing and unexpectedly skipped applicable jobs cannot pass check", () => {
  for (const full of [false, true]) {
    const expected = successful(full);
    for (const [name, entry] of Object.entries(expected)) {
      if (entry.result !== "success") continue;
      for (const result of ["failure", "cancelled", "skipped", "pending"])
        assert.ok(
          ciFailures({ ...expected, [name]: { result } }, full).length,
          `${name} ${result}`,
        );
      const missing: Record<string, { result: string }> = { ...expected };
      delete missing[name];
      assert.ok(ciFailures(missing, full).length);
    }
    assert.ok(
      ciFailures({ ...expected, extra: { result: "success" } }, full).length,
    );
  }
  assert.ok(ciFailures(null, false).length);
  assert.ok(ciFailures([], false).length);
});
