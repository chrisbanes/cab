// Bounded live qualification of GitLab delivery on gitlab.com: the whole path through the real service,
// delivery coordinator and GitLab provider on the fixture project banes3/Banes-project (id 88319115), with
// a scripted lead and no model turn. A credential probe, a reviewable-pr journey (push, merge request,
// ready, pipeline wake, discussion reply and resolve, handback) and a through-merge journey (an outside
// commit adopted as the recovery, a refused merge, the merge), then cleanup of exactly what the run created.
// Run manually after `npm run build`, with CAB_GITLAB_TOKEN in the environment and the GitLab CLI logged in:
//   node test/delivery/gitlab-qualification/live-gitlab-delivery.mjs --live [--result ABSOLUTE_PATH]
// The merge into the fixture's `main` is real and irreversible. Neither credential is printed or stored;
// the guard limits every request, push and fetch to the fixture, with at most 16 writes.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { glabToken } from "../../../dist/src/standalone/glab-credential.js";
import {
  GitLabGuard,
  livePaceMs,
  liveInvocation,
  maxWrites,
} from "../../../dist/test/delivery/gitlab-qualification/gitlab-guard.js";
import { runGitLabQualification } from "../../../dist/test/delivery/gitlab-qualification/gitlab-journey.js";

const { resultPath } = liveInvocation(process.argv.slice(2), process.env);

const evidence = await runGitLabQualification({
  guard: new GitLabGuard(maxWrites, livePaceMs),
  fetcher: fetch,
  source: "/Users/chris/dev/Banes-project",
  credentialRef: "glab:gitlab.com",
  glabExecutable: "glab",
  tokens: {
    env: () => process.env.CAB_GITLAB_TOKEN,
    glab: async () => {
      const result = await glabToken("gitlab.com");
      return "token" in result ? result.token : undefined;
    },
  },
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
