/** The task page's four tabs; the active one is page state, never a route. */
export const taskTabs = [
  ["overview", "Overview"],
  ["files", "Files"],
  ["changes", "Changes"],
  ["review", "Review"],
] as const;
export type TaskTab = (typeof taskTabs)[number][0];
export const tabIds: readonly TaskTab[] = taskTabs.map(([id]) => id);

const sectionTabs: Record<string, TaskTab> = {
  files: "files",
  changes: "changes",
  "local-review": "review",
};

/** The tab whose panel holds a section; Overview holds the rest. */
export const tabForSection = (section: string): TaskTab =>
  sectionTabs[section] ?? "overview";

/**
 * The tab a link opens on, from its query and fragment, or null for the default.
 * `section` wins, then the fragment, then the inspection and selection parameters.
 */
export function tabForLocation(path: string, hash = ""): TaskTab | null {
  const [beforeHash = "", fragment = ""] = path.split("#");
  const params = new URLSearchParams(beforeHash.split("?")[1] ?? "");
  const section = params.get("section") ?? (fragment || hash.slice(1));
  if (section) return tabForSection(section);
  if (params.has("path")) return "files";
  if (params.has("target") || params.has("base")) return "changes";
  if (params.has("review")) return "review";
  // A named result, source or assignment is shown on the Overview.
  if (["result", "source", "assignment"].some((p) => params.has(p)))
    return "overview";
  return null;
}

/** Where on the Overview a link into the conversation lands. */
export type ConversationTarget =
  | { kind: "latest" }
  | { kind: "assignment"; id: string }
  | { kind: "request"; id: string };

/**
 * The conversation place a link names, or null when it names none. `#history` and
 * `?section=history` are the former History links and mean the same as `conversation`;
 * a request is reached through the conversation only when the link names it, since
 * otherwise `?request=` opens its form in the attention card.
 */
export function conversationTarget(
  path: string,
  hash = "",
): ConversationTarget | null {
  const [beforeHash = "", fragment = ""] = path.split("#");
  const params = new URLSearchParams(beforeHash.split("?")[1] ?? "");
  const named = params.get("section") ?? (fragment || hash.slice(1));
  const place = named === "history" || named === "conversation";
  const request = params.get("request"),
    assignment = params.get("assignment");
  if (request && place) return { kind: "request", id: request };
  // An exact inspection, result or source link keeps its own target.
  const other = [
    "path",
    "target",
    "base",
    "review",
    "result",
    "source",
    "record",
  ].some((p) => params.has(p));
  if (assignment && (place || (!named && !other)))
    return { kind: "assignment", id: assignment };
  return place ? { kind: "latest" } : null;
}
