import { z } from "zod";
import {
  type JiraGuard,
  qualificationSite,
  runJql,
  runLabel,
  summaryPattern,
} from "./jira-guard.js";
import type { CleanupRead } from "../gitlab-qualification/gitlab-cleanup.js";

const { projectId } = qualificationSite;
const { host } = qualificationSite;

export type JiraApi = (
  path: string,
  init?: { method?: "GET" | "POST" | "PUT" | "DELETE"; body?: unknown },
) => Promise<{ status: number; json: unknown }>;
export interface JiraRateLimit {
  sleep?: (ms: number) => Promise<void>;
  /** Waits for a 429 before giving up (3 by default). */
  maxRetries?: number;
  /** The longest single wait (60 s by default). */
  maxWaitMs?: number;
}
export interface JiraAccessValues {
  email: string;
  token: string;
}

/**
 * The harness's own Jira calls, as the credential's account. A 429 is waited out for the time Jira names, up
 * to the bounds; one that outlasts them is an error, not a body to parse. A body that is not JSON reads as null.
 */
export function jiraApi(
  fetcher: typeof fetch,
  access: () => JiraAccessValues | undefined,
  rateLimit: JiraRateLimit = {},
): JiraApi {
  const { maxRetries = 3, maxWaitMs = 60_000 } = rateLimit;
  const sleep =
    rateLimit.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  return async (path, init = {}) => {
    const values = access();
    if (!values) throw new Error("harness credential unavailable");
    for (let attempt = 0; ; attempt++) {
      const response = await fetcher(`https://${host}/rest/api/3${path}`, {
        method: init.method ?? "GET",
        redirect: "manual",
        headers: {
          accept: "application/json",
          authorization: `Basic ${Buffer.from(`${values.email}:${values.token}`).toString("base64")}`,
          ...(init.body === undefined
            ? {}
            : { "content-type": "application/json" }),
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      });
      if (response.status === 429) {
        await response.body?.cancel();
        if (attempt >= maxRetries) throw new Error("jira-rate-limited");
        const seconds = Number(response.headers.get("retry-after"));
        await sleep(
          Math.min(
            Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 5000,
            maxWaitMs,
          ),
        );
        continue;
      }
      const text = await response.text();
      let json: unknown = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        // Not JSON (plain text from a proxy or a limit): the status is what is reported.
      }
      return { status: response.status, json };
    }
  };
}

const labelsOf = z.object({
  fields: z.object({ labels: z.array(z.string()) }),
});

/**
 * Deletes each issue the guard recorded, on its own so one failure leaves no other behind, and reads it
 * back as gone. When the credential may not delete (403), `cab-ready` is removed instead and read back, so
 * the issue is no longer selected; that is reported as `kept-not-ready`. Cleanup is verified only when every
 * issue reads back deleted or not ready.
 */
export async function cleanUpJira(
  api: JiraApi,
  guard: JiraGuard,
  clean: (value: unknown) => string = String,
): Promise<{ cleanup: "verified" | "failed"; cleanupReads: CleanupRead[] }> {
  guard.cleaning = true;
  const reads: CleanupRead[] = [];
  for (const [id, key] of guard.issues) {
    const route = `/issue/${id}?fields=labels`;
    try {
      const deleted = await api(`/issue/${id}`, { method: "DELETE" });
      let result = (await api(route)).status === 404 ? "deleted" : "present";
      if (result === "present" && deleted.status === 403) {
        const labels = labelsOf.parse((await api(route)).json).fields.labels;
        if (labels.includes("cab-ready"))
          await api(`/issue/${id}`, {
            method: "PUT",
            body: { update: { labels: [{ remove: "cab-ready" }] } },
          });
        result = labelsOf
          .parse((await api(route)).json)
          .fields.labels.includes("cab-ready")
          ? "present"
          : "kept-not-ready";
      }
      reads.push({ resource: `issue ${key}`, result });
    } catch (error) {
      reads.push({
        resource: `issue ${key}`,
        result: `failed: ${clean(error instanceof Error ? error.message : error)}`,
      });
    }
  }
  return {
    cleanup: reads.every((r) =>
      ["deleted", "kept-not-ready"].includes(r.result),
    )
      ? "verified"
      : "failed",
    cleanupReads: reads,
  };
}

const found = z.object({
  id: z.string().regex(/^\d{1,20}$/),
  key: z.string(),
  fields: z.object({
    summary: z.string(),
    labels: z.array(z.string()),
    project: z.object({ id: z.string() }),
  }),
});

/**
 * Cleans up after an earlier run without a new journey: the issues that run created, found by its run id,
 * or one issue by key. Only an issue of the fixture project whose summary and label are a run's own is
 * touched. `found` counts what it recorded; a run already cleaned up reports 0 and nothing to do. A search
 * that has not yet caught up with a creation may miss an issue: run it again later.
 */
export async function cleanupJiraRun(options: {
  guard: JiraGuard;
  fetcher: typeof fetch;
  access: () => JiraAccessValues | undefined;
  run?: string;
  issue?: string;
  rateLimit?: JiraRateLimit;
}) {
  const { guard } = options;
  const api = jiraApi(
    guard.fetcher(options.fetcher),
    options.access,
    options.rateLimit,
  );
  let candidates: Array<z.output<typeof found>>;
  if (options.issue !== undefined) {
    guard.lookup(options.issue);
    const read = await api(
      `/issue/${options.issue}?fields=summary,labels,project`,
    );
    // Only an issue that is not there is already cleaned up; any other failure is not an answer.
    if (read.status !== 200 && read.status !== 404)
      throw new Error(`issue lookup failed: ${read.status}`);
    candidates = read.status === 200 ? [found.parse(read.json)] : [];
  } else {
    const run = String(options.run);
    guard.bindRun(run);
    const search = await api("/search/jql", {
      method: "POST",
      body: {
        jql: runJql(run),
        fields: ["summary", "labels", "project"],
        maxResults: 50,
      },
    });
    candidates = z.object({ issues: z.array(found) }).parse(search.json).issues;
  }
  for (const issue of candidates) {
    const run = summaryPattern.exec(issue.fields.summary)?.[1];
    if (
      !run ||
      (options.run !== undefined && run !== options.run) ||
      issue.fields.project.id !== projectId ||
      !issue.fields.labels.includes(runLabel(run))
    )
      continue;
    guard.recordExisting(issue.id, issue.key);
  }
  return { ...(await cleanUpJira(api, guard)), found: guard.issues.size };
}
