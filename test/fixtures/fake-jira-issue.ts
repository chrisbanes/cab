import { adfParagraph, fakeJira, type JiraRequest, json } from "./fake-jira.js";

export const issueId = "10007";
export const projectId = "10000";
export const accountId = "acct-cab";
export const otherAccountId = "acct-person";
/** The Jira issue, ABC-7, the fixtures act on. */
export const target = { repositoryId: projectId, number: 7, nodeId: issueId };

interface Comment {
  id: string;
  accountId: string;
  body: unknown;
  properties: { key: string; value: unknown }[];
}
interface History {
  id: string;
  accountId: string;
  items: { field: string; to: string }[];
}
/** What one route does when it is scripted to fail. */
export interface Failure {
  /** The response status; unset throws, as a lost connection does. */
  status?: number;
  /** Whether Jira applied the write before failing. */
  apply?: boolean;
}

/**
 * A scripted Jira Cloud issue: comments, labels, transitions and changelog. Writes change its state;
 * `fail` scripts a route (`"POST comment"`) to fail with or without applying the write.
 */
export function fakeJiraIssue() {
  const state = {
    status: { id: "1", name: "To Do", category: "new" },
    labels: ["ready"] as string[],
    comments: [] as Comment[],
    history: [{ id: "500", accountId: otherAccountId, items: [] }] as History[],
    transitions: [
      { id: "31", to: { id: "9", name: "Done", category: "done" } },
    ],
    nextId: 600,
    myself: accountId,
    /** Who the next write is made by, as when a person acts in the browser. */
    writer: accountId,
    fail: {} as Record<string, Failure>,
    /** Drops the comment property a create carries, as if Jira did not keep it. */
    dropProperties: false,
  };
  const route = (request: JiraRequest) => {
    const path = request.url.pathname.replace("/rest/api/3", "");
    const tail = path.replace(`/issue/${issueId}`, "") || "issue";
    return { path, key: `${request.method} ${tail.replace(/^\//, "")}` };
  };
  const issue = () => ({
    id: issueId,
    key: "ABC-7",
    fields: {
      summary: "Issue 7",
      status: {
        id: state.status.id,
        name: state.status.name,
        statusCategory: { key: state.status.category },
      },
      labels: state.labels,
      description: adfParagraph("Body 7"),
      project: { id: projectId, key: "ABC" },
    },
  });
  const comment = (c: Comment) => ({
    id: c.id,
    author: { accountId: c.accountId },
    body: c.body,
  });
  const jira = fakeJira((request) => {
    const { path, key } = route(request);
    const scripted = state.fail[key];
    const lost = (applied: () => void) => {
      if (!scripted) return false;
      if (scripted.apply) applied();
      return true;
    };
    const failed = () =>
      scripted?.status === undefined
        ? Promise.reject(new Error("connection lost"))
        : new Response("{}", { status: scripted.status });
    const page = <T>(items: T[], name: string) => {
      const start = Number(request.url.searchParams.get("startAt") ?? 0);
      const max = Number(request.url.searchParams.get("maxResults") ?? 50);
      return json({
        startAt: start,
        total: items.length,
        [name]: items.slice(start, start + max),
      });
    };
    if (path === "/myself")
      return json({ accountId: state.myself, displayName: "cab" });
    if (key === "GET issue") return json(issue());
    if (key === "GET transitions")
      return json({
        transitions: state.transitions.map((t) => ({
          id: t.id,
          to: {
            id: t.to.id,
            statusCategory: { key: t.to.category },
          },
        })),
      });
    if (key === "GET changelog")
      return page(
        state.history.map((h) => ({
          id: h.id,
          author: { accountId: h.accountId },
          items: h.items,
        })),
        "values",
      );
    if (key === "GET comment")
      return page(state.comments.map(comment), "comments");
    if (key === "POST comment") {
      const body = request.body as {
        body: unknown;
        properties: Comment["properties"];
      };
      const create = () =>
        state.comments.push({
          id: String(state.nextId++),
          accountId: state.writer,
          body: body.body,
          properties: state.dropProperties ? [] : body.properties,
        });
      if (lost(create)) return failed();
      create();
      return json({ id: state.comments.at(-1)?.id }, { status: 201 });
    }
    if (path === "/comment/list") {
      const ids = (request.body as { ids: number[] }).ids.map(String);
      return json({
        values: state.comments
          .filter((c) => ids.includes(c.id))
          .map((c) => ({ ...comment(c), properties: c.properties })),
      });
    }
    if (key === "PUT issue") {
      const edits = (
        request.body as {
          update: { labels: { add?: string; remove?: string }[] };
        }
      ).update.labels;
      const apply = () => {
        for (const e of edits) {
          if (e.add && !state.labels.includes(e.add)) state.labels.push(e.add);
          if (e.remove)
            state.labels = state.labels.filter((l) => l !== e.remove);
        }
      };
      if (lost(apply)) return failed();
      apply();
      return new Response(null, { status: 204 });
    }
    if (key === "POST transitions") {
      const id = (request.body as { transition: { id: string } }).transition.id;
      const transition = state.transitions.find((t) => t.id === id);
      const apply = () => {
        if (!transition) return;
        state.status = transition.to;
        state.history.push({
          id: String(state.nextId++),
          accountId: state.writer,
          items: [{ field: "status", to: transition.to.id }],
        });
      };
      if (lost(apply)) return failed();
      apply();
      return new Response(null, { status: 204 });
    }
    return new Response("{}", { status: 404 });
  });
  /** The writes the site received, as `METHOD route`. */
  const writes = () =>
    jira.requests
      .map((r) => route(r).key)
      // The comment list is a POST that reads.
      .filter((key) => !key.startsWith("GET") && key !== "POST comment/list");
  return { ...jira, state, writes };
}
