// Bounded live qualification of the status mapping: a scratch user-owned Project linked to the fixture
// repository, one fixture issue, and the real writer, delivery coordinator and provider writing the
// Status for two events (induced in local state, with no model turn), each read back independently.
// Run manually after `npm run build`:
//   node test/delivery/github-qualification/live-status-mapping.mjs --live --manifest ABS --grant ABS --attempt 1|2 [--result ABS]
// Each attempt creates and deletes its own Project and closes its own fixture issue. The product's
// GitHub credential comes in-process from `ghToken()` and reaches only the guarded client; `gh` runs
// under its own login, limited to the exact command shapes the guard allows. Nothing is printed or stored.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { ghToken } from "../../../dist/src/standalone/gh-credential.js";
import { StatusMappingGuard } from "../../../dist/test/delivery/github-qualification/status-mapping-fixture.js";
import { runStatusMappingJourney } from "../../../dist/test/delivery/github-qualification/status-mapping-journey.js";

const args = process.argv.slice(2);
const argument = (flag) => {
  const index = args.indexOf(flag);
  return index < 0 ? undefined : args[index + 1];
};
const resultPath = argument("--result");
const attempt = Number(argument("--attempt"));
if (
  !args.includes("--live") ||
  !isAbsolute(argument("--manifest") ?? "") ||
  !isAbsolute(argument("--grant") ?? "") ||
  !Number.isInteger(attempt) ||
  (resultPath !== undefined && !isAbsolute(resultPath)) ||
  args.length !== (resultPath === undefined ? 7 : 9)
)
  throw new Error(
    "Refusing execution: require --live --manifest ABSOLUTE_PATH --grant ABSOLUTE_PATH --attempt N [--result ABSOLUTE_PATH]",
  );

// Validation happens before credential access, process creation or provider requests.
const guard = new StatusMappingGuard(
  readFileSync(argument("--manifest"), "utf8"),
  JSON.parse(readFileSync(argument("--grant"), "utf8")),
);

const credential = await ghToken();
if (!("token" in credential))
  throw new Error(`Credential unavailable: ${credential.state}`);

const evidence = await runStatusMappingJourney({
  guard,
  token: credential.token,
  attempt,
  gh: (ghArgs) =>
    execFileSync("gh", ghArgs, {
      encoding: "utf8",
      env: { ...process.env, GH_PROMPT_DISABLED: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    }),
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
if (evidence.qualification !== "passed" || evidence.cleanup !== "verified")
  process.exitCode = 1;
