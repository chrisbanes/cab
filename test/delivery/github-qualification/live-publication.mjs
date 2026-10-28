// Bounded live qualification of task commit publication: a real task worktree, Ensemble's coordinator
// and HTTPS push for a first commit, `pr.create` on the assigned branch, then a repair push, then
// recovery from two harness-made outside commits: one overwritten, one adopted and pushed on top of.
// Run manually after `npm run build`:
//   node test/delivery/github-qualification/live-publication.mjs --live --manifest ABS --grant ABS [--result ABS]
// Writes only to the maintainer-owned fixture repository (one scratch branch, one draft PR, two outside
// commits on that branch) under the named manifest and grant. The GitHub credential comes in-process from the product's `ghToken()` and
// reaches only the push child's environment and the guarded REST client; it is never printed or stored.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { ghToken } from "../../../dist/src/standalone/gh-credential.js";
import { PublicationGuard } from "../../../dist/test/delivery/github-qualification/publication-fixture.js";
import { runPublicationJourney } from "../../../dist/test/delivery/github-qualification/publication-journey.js";

const args = process.argv.slice(2);
const argument = (flag) => {
  const index = args.indexOf(flag);
  return index < 0 ? undefined : args[index + 1];
};
const resultPath = argument("--result");
if (
  !args.includes("--live") ||
  !isAbsolute(argument("--manifest") ?? "") ||
  !isAbsolute(argument("--grant") ?? "") ||
  (resultPath !== undefined && !isAbsolute(resultPath)) ||
  args.length !== (resultPath === undefined ? 5 : 7)
)
  throw new Error(
    "Refusing execution: require --live --manifest ABSOLUTE_PATH --grant ABSOLUTE_PATH [--result ABSOLUTE_PATH]",
  );

// Validation happens before credential access, process creation or provider requests.
const guard = new PublicationGuard(
  readFileSync(argument("--manifest"), "utf8"),
  JSON.parse(readFileSync(argument("--grant"), "utf8")),
);
const fullName = guard.manifest.repository.fullName;

const credential = await ghToken();
if (!("token" in credential))
  throw new Error(`Credential unavailable: ${credential.state}`);

// Independent readbacks go through the gh CLI's own authentication, not this process's token.
const gh = (path, jq) => {
  try {
    return execFileSync("gh", ["api", path, "--jq", jq], {
      encoding: "utf8",
      env: { ...process.env, GH_PROMPT_DISABLED: "1" },
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
};
const evidence = await runPublicationJourney({
  guard,
  token: credential.token,
  cloneUrl: `https://github.com/${fullName}.git`,
  readRef: (branch) =>
    gh(`repos/${fullName}/git/ref/heads/${branch}`, ".object.sha"),
  readPrHead: (number) => gh(`repos/${fullName}/pulls/${number}`, ".head.sha"),
});
evidence.source = {
  revision: execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim(),
  node: process.version,
};
const text = JSON.stringify(evidence, null, 2);
if (resultPath) writeFileSync(resultPath, `${text}\n`);
console.log(text);
if (
  evidence.publication !== "passed" ||
  evidence.overwrite !== "passed" ||
  evidence.adopt !== "passed" ||
  evidence.cleanup !== "verified"
)
  process.exitCode = 1;
