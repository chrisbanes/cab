// Bounded live qualification of GitLab stacking on gitlab.com: three stacked tasks through the real
// service, delivery coordinator and GitLab provider on the fixture project banes3/Banes-project (id
// 88319115), with a scripted lead and no model turn. It opens a three-layer stack, merges the bottom layer
// with source-branch removal, waits for GitLab's retarget, Unstacks the top layer and merges the middle one,
// then cleans up exactly what the run created. Run manually after `npm run build`, with the GitLab CLI
// logged in to gitlab.com:
//   node test/delivery/gitlab-qualification/live-gitlab-stack.mjs --live [--result ABSOLUTE_PATH]
// The two merges into the fixture's `main` are real and irreversible. The credential is never printed or
// stored; the guard limits every request, push and fetch to the fixture, with at most 16 writes.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { glabToken } from "../../../dist/src/standalone/glab-credential.js";
import {
  cleanupWrites,
  GitLabGuard,
  livePaceMs,
  liveInvocation,
  maxWrites,
} from "../../../dist/test/delivery/gitlab-qualification/gitlab-guard.js";
import { runGitLabStackQualification } from "../../../dist/test/delivery/gitlab-qualification/gitlab-stack-journey.js";

const { resultPath } = liveInvocation(
  process.argv.slice(2),
  process.env,
  false,
);

const evidence = await runGitLabStackQualification({
  guard: new GitLabGuard(maxWrites, livePaceMs, cleanupWrites, "stack"),
  fetcher: fetch,
  source: "/Users/chris/dev/Banes-project",
  credentialRef: "glab:gitlab.com",
  glabExecutable: "glab",
  token: async () => {
    const result = await glabToken("gitlab.com");
    return "token" in result ? result.token : undefined;
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
