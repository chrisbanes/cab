/** The task page's five tabs; the active one is page state, never a route. */
export const taskTabs = [
  ["overview", "Overview"],
  ["files", "Files"],
  ["changes", "Changes"],
  ["review", "Review"],
  ["history", "History"],
] as const;
export type TaskTab = (typeof taskTabs)[number][0];
export const tabIds: readonly TaskTab[] = taskTabs.map(([id]) => id);

const sectionTabs: Record<string, TaskTab> = {
  files: "files",
  changes: "changes",
  "local-review": "review",
  context: "history",
  history: "history",
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
  // A named result or source shows it; an assignment alone opens its history.
  if (params.has("result") || params.has("source")) return "overview";
  if (params.has("assignment")) return "history";
  return null;
}
