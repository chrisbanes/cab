// Cleans up after an earlier live Jira qualification run without running a journey. With --run it deletes
// the run's Jira issues on banes-team.atlassian.net (found by its label and summary; when the credential may
// not delete, it removes `cab-ready` instead) and closes the run's GitLab merge request and deletes its
// `cab/` branch on banes3/Banes-project. With --issue it cleans up one Jira issue only. Nothing else is
// touched. Re-runnable: each resource is read back, and a run already cleaned up reports nothing to do.
// Run manually after `npm run build`, with the four variables set:
//   node test/delivery/jira-qualification/cleanup-jira-run.mjs --live (--run RUN_ID | --issue KAN-N) [--result ABSOLUTE_PATH]
// A 429 is waited out as in the journey. No credential is printed or stored.
import { writeFileSync } from "node:fs";
import { cleanupGitLabRun } from "../../../dist/test/delivery/gitlab-qualification/gitlab-cleanup.js";
import {
  GitLabGuard,
  livePaceMs,
} from "../../../dist/test/delivery/gitlab-qualification/gitlab-guard.js";
import { cleanupJiraRun } from "../../../dist/test/delivery/jira-qualification/jira-cleanup.js";
import {
  cleanupInvocation,
  JiraGuard,
  jiraPaceMs,
  maxJiraWrites,
} from "../../../dist/test/delivery/jira-qualification/jira-guard.js";

const { run, issue, resultPath } = cleanupInvocation(
  process.argv.slice(2),
  process.env,
);

const access = () => ({
  email: process.env.CAB_JIRA_EMAIL,
  token: process.env.CAB_JIRA_API_TOKEN,
});
const jira = await cleanupJiraRun({
  guard: new JiraGuard(maxJiraWrites, jiraPaceMs),
  fetcher: fetch,
  access,
  ...(run === undefined ? {} : { run }),
  ...(issue === undefined ? {} : { issue }),
});
const gitlab =
  run === undefined
    ? null
    : await cleanupGitLabRun({
        guard: new GitLabGuard(6, livePaceMs, 2),
        fetcher: fetch,
        token: () => process.env.CAB_GITLAB_TOKEN,
        run,
      });
const evidence = { run: run ?? null, issue: issue ?? null, jira, gitlab };
const text = JSON.stringify(evidence, null, 2);
if (resultPath) writeFileSync(resultPath, `${text}\n`);
console.log(text);
if (jira.cleanup !== "verified" || (gitlab && gitlab.cleanup !== "verified"))
  process.exitCode = 1;
