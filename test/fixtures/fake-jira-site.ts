import { adfParagraph, fakeJira, json } from "./fake-jira.js";

/** The statuses of the qualification project: global transitions reach each from every other. */
export const siteStatuses = [
  { id: "10003", name: "To Do", category: "new" },
  { id: "3", name: "In Progress", category: "indeterminate" },
  { id: "10004", name: "In Review", category: "indeterminate" },
  { id: "10005", name: "Done", category: "done" },
] as const;
export const siteAccount = "acct-qualification";

interface SiteIssue {
  id: string;
  key: string;
  summary: string;
  labels: string[];
  status: string;
  priority: string | null;
  description: unknown;
  /** The issues this one is blocked by, by id. */
  blockedBy: string[];
  comments: Array<{
    id: string;
    accountId: string;
    body: unknown;
    properties: unknown[];
  }>;
  history: Array<{ id: string; accountId: string; to: string }>;
}

/**
 * A scripted Jira Cloud site with the qualification project KAN: issue creation, blocker links, search,
 * transitions, comments, labels, changelog and deletion. `searchLag` hides writes from search for that
 * many searches, as Jira's index lags; `fail` answers a route with a status instead of applying it.
 */
export function fakeJiraSite(host = "banes-team.atlassian.net") {
  const state = {
    issues: new Map<string, SiteIssue>(),
    nextIssue: 2,
    nextId: 700,
    /** Searches that still answer from the index as it was before the latest writes. */
    searchLag: 0,
    indexed: [] as SiteIssue[],
    /** Whether the credential may delete issues. */
    canDelete: true,
    /** Routes (`METHOD route`) that answer with a status for their next `count` sends. */
    fail: new Map<
      string,
      { status: number; count: number; headers?: HeadersInit }
    >(),
    issueTypes: [{ id: "10002", name: "Task" }],
  };
  const status = (id: string) =>
    siteStatuses.find((s) => s.id === id) ?? siteStatuses[0];
  const view = (issue: SiteIssue, fields: string[] = []) => {
    const s = status(issue.status);
    return {
      id: issue.id,
      key: issue.key,
      fields: {
        summary: issue.summary,
        status: { id: s.id, name: s.name, statusCategory: { key: s.category } },
        labels: issue.labels,
        description: issue.description,
        project: { id: "10001", key: "KAN" },
        ...(fields.includes("issuelinks")
          ? {
              issuelinks: issue.blockedBy.flatMap((id) => {
                const other = state.issues.get(id);
                return other
                  ? [
                      {
                        type: {
                          name: "Blocks",
                          inward: "is blocked by",
                          outward: "blocks",
                        },
                        inwardIssue: {
                          id: other.id,
                          key: other.key,
                          fields: {
                            status: {
                              statusCategory: {
                                key: status(other.status).category,
                              },
                            },
                          },
                        },
                      },
                    ]
                  : [];
              }),
            }
          : {}),
        ...(issue.priority
          ? {
              customfield_10045: {
                id: issue.priority,
                value: issue.priority === "10022" ? "High" : "Low",
              },
            }
          : {}),
      },
    };
  };
  const find = (idOrKey: string) =>
    [...state.issues.values()].find(
      (i) => i.id === idOrKey || i.key === idOrKey,
    );
  const site = fakeJira((request) => {
    const path = request.url.pathname.replace("/rest/api/3", "");
    const route = `${request.method} ${path.replace(/\/\d+(?=\/|$)/g, "/:id").replace(/\/KAN-\d+(?=\/|$)/, "/:id")}`;
    const scripted = state.fail.get(route);
    if (scripted && scripted.count > 0) {
      scripted.count--;
      return new Response("rate limited\n", {
        status: scripted.status,
        ...(scripted.headers ? { headers: scripted.headers } : {}),
      });
    }
    const body = request.body as Record<string, unknown> | undefined;
    if (path === "/myself")
      return json({ accountId: siteAccount, displayName: "cab qualification" });
    if (path === "/project/10001/statuses")
      return json(
        state.issueTypes.map((type) => ({
          ...type,
          subtask: false,
          statuses: siteStatuses.map(({ id, name }) => ({ id, name })),
        })),
      );
    if (request.method === "POST" && path === "/issue") {
      const fields = (body?.fields ?? {}) as Record<string, unknown>;
      const number = state.nextIssue++;
      const issue: SiteIssue = {
        id: String(10100 + number),
        key: `KAN-${number}`,
        summary: String(fields.summary),
        labels: [...(fields.labels as string[])],
        status: "10003",
        priority:
          (fields.customfield_10045 as { id: string } | undefined)?.id ?? null,
        description: fields.description ?? null,
        blockedBy: [],
        comments: [],
        history: [],
      };
      state.issues.set(issue.id, issue);
      return json({ id: issue.id, key: issue.key }, { status: 201 });
    }
    if (request.method === "POST" && path === "/issueLink") {
      const { inwardIssue, outwardIssue } = body as {
        inwardIssue: { key: string };
        outwardIssue: { key: string };
      };
      const blocked = find(inwardIssue.key);
      const blocker = find(outwardIssue.key);
      if (!blocked || !blocker) return new Response("{}", { status: 404 });
      blocked.blockedBy.push(blocker.id);
      return new Response(null, { status: 201 });
    }
    if (request.method === "POST" && path === "/search/jql") {
      const jql = String((body as { jql: string }).jql);
      const label = /labels = "([^"]+)"/.exec(jql)?.[1];
      const fields = ((body as { fields?: string[] }).fields ?? []) as string[];
      if (state.searchLag > 0) state.searchLag--;
      else
        state.indexed = [...state.issues.values()].map((i) =>
          structuredClone(i),
        );
      // The index answers with the statuses it saw; a link reads the live linked issue, as Jira's do.
      return json({
        issues: state.indexed
          .filter((i) => !label || i.labels.includes(label))
          .map((i) => view(i, fields)),
      });
    }
    if (request.method === "POST" && path === "/jql/parse")
      return json({ queries: [{ query: "q" }] });
    if (request.method === "POST" && path === "/comment/list") {
      const ids = (body as { ids: number[] }).ids.map(String);
      return json({
        values: [...state.issues.values()]
          .flatMap((i) => i.comments)
          .filter((c) => ids.includes(c.id))
          .map((c) => ({
            id: c.id,
            author: { accountId: c.accountId },
            body: c.body,
            properties: c.properties,
          })),
      });
    }
    const match = /^\/issue\/([^/]+)(?:\/([a-z]+))?$/.exec(path);
    const issue = match ? find(match[1] ?? "") : undefined;
    if (match && !issue) return new Response("{}", { status: 404 });
    if (!match || !issue) return new Response("{}", { status: 404 });
    const part = match[2];
    const requested = (request.url.searchParams.get("fields") ?? "").split(",");
    if (request.method === "GET" && !part) return json(view(issue, requested));
    if (request.method === "DELETE" && !part) {
      if (!state.canDelete) return new Response("{}", { status: 403 });
      state.issues.delete(issue.id);
      return new Response(null, { status: 204 });
    }
    if (request.method === "PUT" && !part) {
      const edits = (
        body as { update: { labels: { add?: string; remove?: string }[] } }
      ).update.labels;
      for (const e of edits) {
        if (e.add && !issue.labels.includes(e.add)) issue.labels.push(e.add);
        if (e.remove) issue.labels = issue.labels.filter((l) => l !== e.remove);
      }
      return new Response(null, { status: 204 });
    }
    if (request.method === "GET" && part === "transitions")
      return json({
        transitions: siteStatuses
          .filter((s) => s.id !== issue.status)
          .map((s) => ({
            id: `t${s.id}`,
            to: { id: s.id, statusCategory: { key: s.category } },
          })),
      });
    if (request.method === "POST" && part === "transitions") {
      const id = (body as { transition: { id: string } }).transition.id;
      const to = siteStatuses.find((s) => `t${s.id}` === id);
      if (!to || to.id === issue.status)
        return new Response("{}", { status: 400 });
      issue.status = to.id;
      issue.history.push({
        id: String(state.nextId++),
        accountId: siteAccount,
        to: to.id,
      });
      return new Response(null, { status: 204 });
    }
    if (request.method === "GET" && part === "changelog")
      return json({
        total: issue.history.length,
        values: issue.history.map((h) => ({
          id: h.id,
          author: { accountId: h.accountId },
          items: [{ field: "status", to: h.to }],
        })),
      });
    if (request.method === "GET" && part === "comment")
      return json({
        total: issue.comments.length,
        comments: issue.comments.map((c) => ({
          id: c.id,
          author: { accountId: c.accountId },
        })),
      });
    if (request.method === "POST" && part === "comment") {
      const comment = {
        id: String(state.nextId++),
        accountId: siteAccount,
        body: (body as { body: unknown }).body ?? adfParagraph(""),
        properties: (body as { properties: unknown[] }).properties,
      };
      issue.comments.push(comment);
      return json({ id: comment.id }, { status: 201 });
    }
    return new Response("{}", { status: 404 });
  });
  /** An issue that exists before the run, such as one an earlier run left behind. */
  const add = (over: { summary: string; labels: string[] }) => {
    const number = state.nextIssue++;
    const issue: SiteIssue = {
      id: String(10100 + number),
      key: `KAN-${number}`,
      summary: over.summary,
      labels: over.labels,
      status: "10003",
      priority: null,
      description: null,
      blockedBy: [],
      comments: [],
      history: [],
    };
    state.issues.set(issue.id, issue);
    return issue;
  };
  return { ...site, state, host, find, add };
}
