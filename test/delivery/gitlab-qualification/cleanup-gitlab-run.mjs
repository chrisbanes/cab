// Cleans up after an earlier live qualification run without running a journey: closes the merge requests
// the run created (found by its run id, or one by its IID) and deletes their `cab/` branches on
// banes3/Banes-project, nothing else. Run manually after `npm run build`, with CAB_GITLAB_TOKEN set:
//   node test/delivery/gitlab-qualification/cleanup-gitlab-run.mjs --live (--run RUN_ID | --mr IID) [--result ABSOLUTE_PATH]
// A 429 is waited out as in the journey. The credential is never printed or stored.
import { writeFileSync } from "node:fs";
import { cleanupGitLabRun } from "../../../dist/test/delivery/gitlab-qualification/gitlab-cleanup.js";
import {
  cleanupInvocation,
  GitLabGuard,
  livePaceMs,
  maxWrites,
} from "../../../dist/test/delivery/gitlab-qualification/gitlab-guard.js";

const { run, mr, resultPath } = cleanupInvocation(
  process.argv.slice(2),
  process.env,
);

const evidence = await cleanupGitLabRun({
  guard: new GitLabGuard(maxWrites, livePaceMs),
  fetcher: fetch,
  token: () => process.env.CAB_GITLAB_TOKEN,
  ...(run === undefined ? {} : { run }),
  ...(mr === undefined ? {} : { mr }),
});
const text = JSON.stringify(evidence, null, 2);
if (resultPath) writeFileSync(resultPath, `${text}\n`);
console.log(text);
if (evidence.cleanup !== "verified" || evidence.found === 0)
  process.exitCode = 1;
