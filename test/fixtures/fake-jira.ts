/** A scripted Jira Cloud `fetch`: routes by method and path, and records every request. */
export interface JiraRequest {
  method: string;
  url: URL;
  headers: Headers;
  body: unknown;
  redirect: RequestRedirect | undefined;
}
export type JiraHandler = (
  request: JiraRequest,
) => Response | Promise<Response>;

export const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });

export function fakeJira(handler: JiraHandler) {
  const requests: JiraRequest[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const request: JiraRequest = {
      method: init?.method ?? "GET",
      url: new URL(String(input)),
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      redirect: init?.redirect,
    };
    requests.push(request);
    return handler(request);
  };
  return { fetcher, requests };
}

export const adfParagraph = (text: string) => ({
  type: "doc",
  version: 1,
  content: [{ type: "paragraph", content: [{ type: "text", text }] }],
});

export const jiraIssue = (
  n: number,
  over: { done?: boolean; summary?: string; description?: unknown } = {},
) => ({
  id: String(10000 + n),
  key: `ABC-${n}`,
  fields: {
    summary: over.summary ?? `Issue ${n}`,
    status: {
      id: over.done ? "9" : "1",
      name: over.done ? "Done" : "To Do",
      statusCategory: { key: over.done ? "done" : "new" },
    },
    labels: ["ready"],
    description:
      over.description === undefined
        ? adfParagraph(`Body ${n}`)
        : over.description,
    project: { id: "10000", key: "ABC" },
  },
});
