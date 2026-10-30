/** GitLab removes carriage returns and trailing whitespace from saved text. */
const saved = (text: string) =>
  text
    .replaceAll("\r", "")
    .replace(/[ \t]+$/gm, "")
    .trimEnd();

/** The credential user the scripted instance reports. */
export const gitLabUser = { id: 7 };

export interface ScriptedPipeline {
  id: number;
  sha: string;
  status: string;
  started_at: string | null;
  finished_at: string | null;
}
export interface ScriptedMergeRequest {
  id: number;
  iid: number;
  source_project_id: number;
  target_project_id: number;
  source_branch: string;
  target_branch: string;
  sha: string;
  state: string;
  title: string;
  description: string | null;
  draft: boolean;
  author: { id: number };
  diff_refs: { base_sha: string | null } | null;
  head_pipeline: ScriptedPipeline | null;
  detailed_merge_status: string | null;
  merge_when_pipeline_succeeds: boolean;
}
export interface ScriptedNote {
  id: number;
  type: string | null;
  system: boolean;
  body: string;
  author: { id: number };
  updated_at: string;
  resolvable: boolean;
  resolved?: boolean;
  resolved_by?: { id: number } | null;
  resolved_at?: string | null;
  position?: { head_sha: string | null } | null;
}
export interface ScriptedDiscussion {
  id: string;
  individual_note: boolean;
  notes: ScriptedNote[];
}

/** A merge request as GitLab's REST API reports it, in the linked project unless overridden. */
export function gitLabMergeRequest(
  fields: Partial<ScriptedMergeRequest> = {},
): ScriptedMergeRequest {
  return {
    id: 9001,
    iid: 12,
    source_project_id: 42,
    target_project_id: 42,
    source_branch: "cab/abcd1234-task",
    target_branch: "main",
    sha: "2".repeat(40),
    state: "opened",
    title: "Change",
    description: "Body",
    draft: false,
    author: { id: gitLabUser.id },
    diff_refs: { base_sha: "b".repeat(40) },
    head_pipeline: null,
    detailed_merge_status: "mergeable",
    merge_when_pipeline_succeeds: false,
    ...fields,
  };
}

/** A discussion with the given notes (resolvable, unresolved, by another user, unless overridden). */
export function gitLabDiscussion(
  id: string,
  notes: Array<Partial<ScriptedNote>>,
  fields: Partial<ScriptedDiscussion> = {},
): ScriptedDiscussion {
  return {
    id,
    individual_note: false,
    notes: notes.map((n, i) => ({
      id: Number.parseInt(id, 16) * 10 + i,
      type: "DiscussionNote",
      system: false,
      body: "note",
      author: { id: 99 },
      updated_at: "2026-01-01T00:00:00.000Z",
      resolvable: true,
      resolved: false,
      resolved_by: null,
      ...n,
    })),
    ...fields,
  };
}

/**
 * A scripted GitLab instance for delivery tests: one project, one branch, and its merge requests
 * and discussions, read and written through an injected `fetch`. Nothing here reaches a network.
 */
export function scriptedGitLabRemote(options: { repositoryId: string }) {
  const state = {
    /** Merge requests and discussions as REST reports them; a write changes them in place. */
    mergeRequests: [] as ScriptedMergeRequest[],
    discussions: [] as ScriptedDiscussion[],
    /** Rows per page for lists, to prove paging. */
    pageSize: 100,
    /** Answers a request before the script does; throwing is a lost connection. */
    intercept: undefined as
      | ((method: string, path: string) => Response | undefined)
      | undefined,
    nextId: 9100,
    /** The branch head the script reports; null makes the branch absent. */
    head: null as string | null,
    /** The project as the API reports it; the path may differ in case from the link. */
    project: null as unknown,
    redirect: false,
    /** Merge train cars by merge request IID: a car's status, absent when the request is not on the train. */
    cars: new Map<number, string>(),
    /** The status a train gives a request added to it. */
    carStatus: "fresh",
    /** A merge or train write takes effect, then its response is lost. */
    loseMergeResponse: false,
  };
  /** The merge and train writes, with their bodies. */
  const merges: Array<{
    route: "merge" | "train";
    body: Record<string, unknown>;
  }> = [];
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status });
  const paged = (rows: unknown[], url: URL) => {
    const page = Number(url.searchParams.get("page") ?? "1");
    const size = Math.min(
      state.pageSize,
      Number(url.searchParams.get("per_page") ?? "20"),
    );
    const more = page * size < rows.length;
    return new Response(
      JSON.stringify(rows.slice((page - 1) * size, page * size)),
      {
        status: 200,
        headers: more ? { "x-next-page": String(page + 1) } : {},
      },
    );
  };
  const fetcher = (async (url: string, init: RequestInit) => {
    requests.push({ url, init });
    const method = init.method ?? "GET";
    const intercepted = state.intercept?.(
      method,
      decodeURIComponent(new URL(url).pathname),
    );
    if (intercepted) return intercepted;
    if (state.redirect)
      return new Response(null, {
        status: 302,
        headers: { location: "https://evil.example/" },
      });
    const path = decodeURIComponent(new URL(url).pathname);
    const project = `/api/v4/projects/${options.repositoryId}`;
    if (path === project) return json(state.project);
    if (path.startsWith(`${project}/repository/branches/`)) {
      const branch = path.slice(`${project}/repository/branches/`.length);
      return state.head
        ? json({ name: branch, commit: { id: state.head } })
        : json({ message: "404 Branch Not Found" }, 404);
    }
    if (path === "/api/v4/user") return json(gitLabUser);
    const body = init.body ? JSON.parse(String(init.body)) : {};
    if (path === "/api/graphql") {
      const mr = state.mergeRequests.find(
        (m) => String(m.iid) === body.variables?.iid,
      );
      if (mr && /draft: false/.test(body.query)) {
        mr.draft = false;
        mr.title = String(mr.title).replace(/^Draft: /, "");
      }
      return json({ data: { mergeRequestSetDraft: { errors: [] } } });
    }
    const trainPath = `${project}/merge_trains/merge_requests/`;
    if (path.startsWith(trainPath)) {
      const iid = Number(path.slice(trainPath.length));
      const train = state.mergeRequests.find((m) => m.iid === iid);
      if (!train) return json({}, 404);
      if (method === "POST") {
        merges.push({ route: "train", body });
        if (body.sha !== train.sha) return json({}, 409);
        if (
          train.state !== "opened" ||
          train.detailed_merge_status !== "mergeable"
        )
          return json({}, 405);
        state.cars.set(iid, state.carStatus);
        // GitLab reports a request on a train as auto-merge set, and clears it when the car leaves.
        train.merge_when_pipeline_succeeds = true;
        if (state.loseMergeResponse) throw new TypeError("fetch failed");
        return json({ status: state.carStatus }, 201);
      }
      const status = state.cars.get(iid);
      return status ? json({ status }) : json({}, 404);
    }
    const requestsPath = `${project}/merge_requests`;
    if (path === requestsPath && method === "POST") {
      const id = state.nextId++;
      const mr = gitLabMergeRequest({
        id,
        iid: id - 9000,
        source_branch: body.source_branch,
        target_branch: body.target_branch,
        title: body.title,
        description: saved(String(body.description)),
        draft: /^Draft: /.test(body.title),
        ...(state.head ? { sha: state.head } : {}),
      });
      state.mergeRequests.push(mr);
      return json(mr, 201);
    }
    if (path === requestsPath) {
      const query = new URL(url).searchParams;
      return paged(
        state.mergeRequests.filter(
          (m) =>
            (!query.get("source_branch") ||
              m.source_branch === query.get("source_branch")) &&
            (!query.get("target_branch") ||
              m.target_branch === query.get("target_branch")) &&
            (!query.get("author_id") ||
              String(m.author.id) === query.get("author_id")),
        ),
        new URL(url),
      );
    }
    const mrMatch = path.match(
      new RegExp(`^${requestsPath}/([0-9]+)(?:/(.*))?$`),
    );
    const mr = state.mergeRequests.find((m) => String(m.iid) === mrMatch?.[1]);
    if (!mrMatch || !mr) return json({}, 404);
    const rest = mrMatch[2];
    if (!rest && method === "GET") return json(mr);
    if (!rest && method === "PUT") {
      if (body.title !== undefined) {
        mr.title = body.title;
        mr.draft = /^Draft: /.test(body.title);
      }
      if (body.description !== undefined)
        mr.description = saved(String(body.description));
      return json(mr);
    }
    if (rest === "merge" && method === "PUT") {
      merges.push({ route: "merge", body });
      // GitLab refuses a moved head with 409 and an unmergeable request with 405.
      if (body.sha !== mr.sha) return json({}, 409);
      if (mr.state !== "opened" || mr.detailed_merge_status !== "mergeable")
        return json({}, 405);
      mr.state = "merged";
      if (state.loseMergeResponse) throw new TypeError("fetch failed");
      return json(mr);
    }
    if (rest === "discussions") return paged(state.discussions, new URL(url));
    const discussion = rest?.match(/^discussions\/([^/]+)(\/notes)?$/);
    const found = state.discussions.find((d) => d.id === discussion?.[1]);
    if (!discussion || !found) return json({}, 404);
    if (discussion[2] && method === "POST") {
      const note: ScriptedNote = {
        id: state.nextId++,
        type: "DiscussionNote",
        system: false,
        // GitLab removes carriage returns and trailing whitespace from a note.
        body: saved(String(body.body)),
        author: { id: gitLabUser.id },
        updated_at: "2026-01-01T00:00:00.000Z",
        resolvable: true,
        resolved: false,
        resolved_by: null,
      };
      found.notes.push(note);
      return json(note, 201);
    }
    if (method === "PUT")
      // Only notes still unresolved are updated, as GitLab does.
      for (const note of found.notes)
        if (note.resolvable && !note.resolved) {
          note.resolved = true;
          note.resolved_by = { id: gitLabUser.id };
          note.resolved_at = new Date().toISOString();
        }
    return json(found);
  }) as typeof fetch;
  return { state, requests, merges, fetcher };
}
