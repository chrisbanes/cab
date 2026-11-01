import { z } from "zod";
import {
  type RateLimitPolicy,
  fetchRateLimited,
} from "../../../src/standalone/gitlab-http.js";
import { type GitLabGuard, qualificationProject } from "./gitlab-guard.js";

const { host, id: repositoryId } = qualificationProject;
const base = `/api/v4/projects/${repositoryId}`;
const mergeRequest = z.object({
  id: z.number().int(),
  iid: z.number().int(),
  state: z.string(),
  title: z.string(),
  source_branch: z.string(),
  source_project_id: z.number().int(),
  merge_when_pipeline_succeeds: z.boolean().nullish(),
});
const mergeRequests = z.array(mergeRequest);
/** The title every merge request of a run carries; only these are ever closed by a cleanup. A merge request for a Jira task also leads with the issue key. */
const runTitle =
  /^(?:Draft: )?(?:[A-Z][A-Z0-9_]*-\d+ )?Qualification (\d{14}-[0-9a-f]{4}) [ab]$/;

export type HarnessApi = (
  path: string,
  init?: { method?: string; body?: unknown },
) => Promise<{ status: number; json: unknown }>;

/**
 * The harness's own GitLab calls, as the operator's account. A 429 is waited out as the product's calls
 * are; a body that is not JSON reads as null instead of throwing, and a 429 that outlasts the policy is
 * an error rather than a body to parse.
 */
export function harnessApi(
  fetcher: typeof fetch,
  token: () => string | undefined,
  rateLimit?: RateLimitPolicy,
): HarnessApi {
  return async (path, init = {}) => {
    const bearer = token();
    if (!bearer) throw new Error("harness credential unavailable");
    const response = await fetchRateLimited(
      fetcher,
      `https://${host}${path}`,
      () => ({
        method: init.method ?? "GET",
        redirect: "manual",
        headers: {
          authorization: `Bearer ${bearer}`,
          accept: "application/json",
          ...(init.body === undefined
            ? {}
            : { "content-type": "application/json" }),
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      }),
      rateLimit,
    );
    if (response.status === 429) throw new Error("gitlab-rate-limited");
    const text = await response.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      // Not JSON (plain text from a proxy or a limit): the status is what is reported.
    }
    return { status: response.status, json };
  };
}

export type CleanupRead = { resource: string; result: string };

/**
 * Closes the open merge requests and deletes the branches the guard recorded, each on its own so one
 * failure leaves no other behind. A merge that may still land is left open with its branch. Cleanup is
 * verified only when every resource is read back closed, merged or gone.
 */
export async function cleanUp(
  api: HarnessApi,
  guard: GitLabGuard,
  pendingMerge: { iid: number; branch: string } | null,
  clean: (value: unknown) => string = String,
): Promise<{ cleanup: "verified" | "failed"; cleanupReads: CleanupRead[] }> {
  const reads: CleanupRead[] = [];
  /** Branches under a merge that may still land: they stay with it. */
  const pendingBranches = new Set<string>();
  /** A merge request that could not be read or closed may be mid-merge, so no branch is deleted under it. */
  let unread = false;
  const attempt = async (resource: string, work: () => Promise<string>) => {
    try {
      reads.push({ resource, result: await work() });
    } catch (error) {
      if (resource.startsWith("merge_request")) unread = true;
      reads.push({
        resource,
        result: `failed: ${clean(error instanceof Error ? error.message : error)}`,
      });
    }
  };
  for (const [iid] of guard.requests)
    await attempt(`merge_request !${iid}`, async () => {
      const route = `${base}/merge_requests/${iid}`;
      const read = async () => mergeRequest.parse((await api(route)).json);
      const current = await read();
      // Locked, or queued to merge by someone, is a merge that may still land: leave it open.
      if (
        current.state === "locked" ||
        (current.state === "opened" &&
          (iid === pendingMerge?.iid || current.merge_when_pipeline_succeeds))
      ) {
        pendingBranches.add(current.source_branch);
        return "pending-merge";
      }
      if (current.state !== "opened") return current.state;
      await api(route, { method: "PUT", body: { state_event: "close" } });
      return (await read()).state;
    });
  for (const branch of guard.branches)
    await attempt(
      `branch ${branch.replace(/^cab\/.*/, "cab/<task>")}`,
      async () => {
        // A branch under a merge that may still land is left with it.
        if (pendingBranches.has(branch)) return "pending-merge";
        if (unread) return "left: a merge request could not be read or closed";
        const route = `${base}/repository/branches/${encodeURIComponent(branch)}`;
        if ((await api(route)).status === 200)
          await api(route, { method: "DELETE" });
        return (await api(route)).status === 404 ? "deleted" : "present";
      },
    );
  return {
    cleanup: reads.every((r) =>
      ["closed", "merged", "deleted", "pending-merge"].includes(r.result),
    )
      ? "verified"
      : "failed",
    cleanupReads: reads,
  };
}

/**
 * Cleans up after an earlier run without a new journey: the merge requests that run created, found by
 * its run id, or one merge request by its IID. Only a merge request titled like a run's, from a `cab/`
 * branch of the fixture project, is touched; its branch is deleted with it.
 */
export async function cleanupGitLabRun(options: {
  guard: GitLabGuard;
  fetcher: typeof fetch;
  token: () => string | undefined;
  run?: string;
  mr?: number;
  rateLimit?: RateLimitPolicy;
}) {
  const api = harnessApi(
    options.guard.fetcher(options.fetcher),
    options.token,
    options.rateLimit,
  );
  const found =
    options.mr !== undefined
      ? [
          mergeRequest.parse(
            (await api(`${base}/merge_requests/${options.mr}`)).json,
          ),
        ]
      : mergeRequests.parse(
          (
            await api(
              `${base}/merge_requests?state=all&per_page=100&search=${encodeURIComponent(`Qualification ${options.run}`)}`,
            )
          ).json,
        );
  for (const mr of found) {
    const title = runTitle.exec(mr.title);
    if (
      !title ||
      (options.run !== undefined && title[1] !== options.run) ||
      String(mr.source_project_id) !== repositoryId ||
      !mr.source_branch.startsWith("cab/")
    )
      continue;
    options.guard.recordExisting(mr.iid, mr.id, mr.source_branch);
  }
  return {
    ...(await cleanUp(api, options.guard, null)),
    found: options.guard.requests.size,
  };
}
