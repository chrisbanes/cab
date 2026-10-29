/**
 * A scripted GitLab instance for delivery tests: one project and one branch, read through an
 * injected `fetch`. Nothing here reaches a network.
 */
export function scriptedGitLabRemote(options: { repositoryId: string }) {
  const state = {
    /** The branch head the script reports; null makes the branch absent. */
    head: null as string | null,
    /** The project as the API reports it; the path may differ in case from the link. */
    project: null as unknown,
    redirect: false,
  };
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status });
  const fetcher = (async (url: string, init: RequestInit) => {
    requests.push({ url, init });
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
    return json({}, 404);
  }) as typeof fetch;
  return { state, requests, fetcher };
}
