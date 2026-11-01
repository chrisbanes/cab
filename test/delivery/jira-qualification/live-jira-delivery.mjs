// Bounded live qualification of Jira delivery on Jira Cloud (banes-team.atlassian.net, project KAN) with
// the merge request on gitlab.com (banes3/Banes-project): one journey through the real service, delivery
// coordinator, Jira source and writer and GitLab provider, with a scripted lead and no model turn. Two Jira
// issues (A, blocked by B) are created, A is imported, started, commented on, labelled, pushed and opened as
// a merge request keyed to it, handed back, settled and closed; then cleanup deletes the run's issues and
// closes its merge request and branch. Run manually after `npm run build`, with the four variables set:
//   node test/delivery/jira-qualification/live-jira-delivery.mjs --live [--result ABSOLUTE_PATH]
// Nothing merges. The deleted Jira issues cannot be restored; the closed merge request stays on GitLab.
// No credential is printed or stored; the guards limit every request to the fixtures, with at most 16
// Jira writes and 6 GitLab writes.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import {
  GitLabGuard,
  livePaceMs,
} from "../../../dist/test/delivery/gitlab-qualification/gitlab-guard.js";
import {
  JiraGuard,
  jiraPaceMs,
  liveInvocation,
  maxJiraWrites,
} from "../../../dist/test/delivery/jira-qualification/jira-guard.js";
import { runJiraQualification } from "../../../dist/test/delivery/jira-qualification/jira-journey.js";

const { resultPath } = liveInvocation(process.argv.slice(2), process.env);

const evidence = await runJiraQualification({
  jira: new JiraGuard(maxJiraWrites, jiraPaceMs),
  gitlab: new GitLabGuard(6, livePaceMs, 2),
  jiraFetcher: fetch,
  gitlabFetcher: fetch,
  source: "/Users/chris/dev/Banes-project",
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
