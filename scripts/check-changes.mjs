import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export async function previousNightlyRun(runId, fetchPage) {
  for (let page = 1; ; page++) {
    const { runs, hasNext } = await fetchPage(page);
    const previous = runs
      .filter((run) => BigInt(run.id) < BigInt(runId))
      .sort((a, b) => (BigInt(a.id) > BigInt(b.id) ? -1 : 1))[0];
    if (previous) {
      if (typeof previous.head_sha !== "string" || !previous.head_sha)
        throw Error("Previous nightly run has no commit SHA");
      return previous;
    }
    if (!hasNext) return null;
  }
}

export function nightlyChanged(sha, previous) {
  return (
    !previous ||
    previous.head_sha !== sha ||
    previous.status !== "completed" ||
    previous.conclusion !== "success"
  );
}

// Tests read these documents, so changing them still runs the checks.
const testedDocs = ["docs/design/", "docs/evidence/", "docs/operations/"];

export function docsOnly(paths) {
  return (
    paths.length > 0 &&
    paths.every(
      (path) =>
        path.endsWith(".md") &&
        (!path.includes("/") || path.startsWith("docs/")) &&
        !testedDocs.some((dir) => path.startsWith(dir)),
    )
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  let run = true;
  if (process.env.GITHUB_EVENT_NAME === "schedule") {
    const workflow = process.env.GITHUB_WORKFLOW_REF.split("@")[0]
      .split("/")
      .at(-1);
    const previous = await previousNightlyRun(
      process.env.GITHUB_RUN_ID,
      async (page) => {
        const url = new URL(
          `https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/actions/workflows/${encodeURIComponent(workflow)}/runs`,
        );
        url.search = new URLSearchParams({
          event: "schedule",
          branch: process.env.GITHUB_REF_NAME,
          per_page: "100",
          page: String(page),
        });
        const response = await fetch(url, {
          headers: {
            Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
          },
          signal: AbortSignal.timeout(10000),
        });
        if (!response.ok)
          throw Error(`Nightly history lookup failed: HTTP ${response.status}`);
        const payload = await response.json();
        if (!Array.isArray(payload.workflow_runs))
          throw Error("Invalid nightly history response");
        return {
          runs: payload.workflow_runs,
          hasNext: /rel="next"/.test(response.headers.get("link") ?? ""),
        };
      },
    );
    run = nightlyChanged(process.env.GITHUB_SHA, previous);
    console.log(
      previous
        ? `Previous nightly commit: ${previous.head_sha}`
        : "No previous nightly run",
    );
  }
  if (process.env.GITHUB_EVENT_NAME === "pull_request") {
    // The checkout is the PR merge commit; its first parent is the base branch.
    const paths = execFileSync(
      "git",
      ["diff", "--name-only", "--no-renames", "HEAD^1", "HEAD"],
      { encoding: "utf8" },
    )
      .split("\n")
      .filter(Boolean);
    run = !docsOnly(paths);
  }
  appendFileSync(process.env.GITHUB_OUTPUT, `run=${run}\n`);
  console.log(
    run
      ? "Run CI checks"
      : process.env.GITHUB_EVENT_NAME === "pull_request"
        ? "Documentation-only change; skip checks"
        : "Commit unchanged after successful previous nightly; skip checks",
  );
}
