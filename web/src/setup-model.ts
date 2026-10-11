/** Pure model for guided project setup: rows, the create command and fixed copy. */
import type {
  CheckoutVerification,
  DiscoveryUnavailableReason,
  FolderListing,
  OperatorCommand,
} from "../../src/operator/contracts.js";

/** One repository row. A typed row keeps its raw `text`; a discovered row carries the node ID. */
export interface SetupRow {
  id: string;
  source: "discovered" | "typed";
  text: string;
  repositoryId: string;
  owner: string;
  name: string;
  ref: string;
  path: string;
}
export const emptyRow = (source: SetupRow["source"]): SetupRow => ({
  id: crypto.randomUUID(),
  source,
  text: "",
  repositoryId: "",
  owner: "",
  name: "",
  ref: "",
  path: "",
});

const segment = /^[A-Za-z0-9_.-]{1,100}$/;
/** The provisional identity of a typed repository: no node ID can be read without discovery. */
export const typedRepositoryId = (owner: string, name: string) =>
  `github.com/${owner}/${name}`.toLowerCase();
export function parseTypedRepository(text: string) {
  const parts = text.trim().split("/");
  const [owner, name] = parts;
  if (
    parts.length !== 2 ||
    !owner ||
    !name ||
    !segment.test(owner) ||
    !segment.test(name) ||
    [owner, name].some((p) => p === "." || p === "..")
  )
    return null;
  return { owner, name };
}
/** Apply typed text to a row, deriving its identity when the text is `owner/name`. */
export function typeRepository(row: SetupRow, text: string): SetupRow {
  const parsed = parseTypedRepository(text);
  return {
    ...row,
    text,
    owner: parsed?.owner ?? "",
    name: parsed?.name ?? "",
    repositoryId: parsed ? typedRepositoryId(parsed.owner, parsed.name) : "",
  };
}

// ConfigurationDraft holds scalar values, so rows travel as one JSON string field.
export const rowsToDraft = (rows: SetupRow[]) => JSON.stringify(rows);
export function rowsFromDraft(value: unknown): SetupRow[] {
  try {
    const rows = JSON.parse(String(value ?? "[]")) as SetupRow[];
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}
/** A row with nothing entered is repository-free and left out of the command. */
export const blankRow = (r: SetupRow) =>
  !r.repositoryId && !r.text.trim() && !r.path.trim();
/** Ids of rows repeating an earlier row's repository, by node ID or by `owner/name`. */
export function duplicateRows(rows: SetupRow[]) {
  const seen = new Set<string>(),
    duplicates = new Set<string>();
  for (const r of rows) {
    if (!r.repositoryId) continue;
    const keys = [r.repositoryId, `${r.owner}/${r.name}`.toLowerCase()];
    if (keys.some((k) => seen.has(k))) duplicates.add(r.id);
    for (const k of keys) seen.add(k);
  }
  return duplicates;
}

/**
 * The one `project.create` command. `rowIndex[k]` is the row behind `repositories.k`,
 * so a field path from the service maps back to the row it names.
 */
export function buildProjectCreate(
  values: {
    key: string;
    projectId: string;
    name: string;
    leadProfileId: string;
    instructions: string;
  },
  rows: SetupRow[],
  githubProjectNodeId: string,
) {
  const included = rows.flatMap((r, i) => (blankRow(r) ? [] : [i]));
  const command = {
    type: "project.create",
    key: values.key,
    projectId: values.projectId,
    name: values.name,
    leadProfileId: values.leadProfileId || null,
    ...(values.instructions.trim()
      ? { instructions: values.instructions }
      : {}),
    ...(included.length
      ? {
          repositories: included.map((i) => {
            const r = rows[i] as SetupRow;
            return {
              repositoryId: r.repositoryId,
              owner: r.owner,
              name: r.name,
              path: r.path.trim(),
              ref: r.ref.trim(),
            };
          }),
        }
      : {}),
    ...(githubProjectNodeId
      ? { githubProject: { projectNodeId: githubProjectNodeId } }
      : {}),
  } as OperatorCommand;
  return { command, rowIndex: included };
}

type Verification = CheckoutVerification["data"];
export function verificationCopy(
  result: Verification,
  expected: { owner: string; name: string; ref: string },
) {
  const repo = `${expected.owner}/${expected.name}`;
  if (result.state === "verified")
    return `Verified on this Mac: git checkout · origin ${result.origin} · ${expected.ref} available.`;
  switch (result.reason) {
    case "origin-mismatch":
      return `This folder is a checkout of ${result.origin ?? "another repository"}, not ${repo}. Choose another folder or change the repository.`;
    case "not-checkout":
      return "This folder is not a Git checkout. Choose the repository's checkout.";
    case "origin-missing":
      return `This checkout has no origin remote, so it can't be matched to ${repo}.`;
    case "origin-provider":
      return `This checkout's origin is not on github.com, so it can't be matched to ${repo}.`;
    case "ref-unavailable":
      return `Ref ${expected.ref} is not available in this checkout. Fetch it or choose another ref.`;
    case "path-invalid":
      return "Enter an existing folder as ~/… or an absolute path.";
    case "unreadable":
      return "This folder couldn't be checked. Try again or choose another folder.";
  }
}
export function folderCaption(entry: FolderListing["data"]["entries"][number]) {
  if (entry.kind === "folder") return "Folder";
  return entry.origin
    ? `Git checkout · origin ${entry.origin}${entry.branch ? ` · ${entry.branch}` : ""}`
    : "Git checkout · origin not on github.com";
}
export const folderMatches = (
  entry: FolderListing["data"]["entries"][number],
  expected: { owner: string; name: string } | null,
) =>
  Boolean(
    expected &&
      entry.origin?.toLowerCase() ===
        `${expected.owner}/${expected.name}`.toLowerCase(),
  );
export function discoveryReasonCopy(reason: DiscoveryUnavailableReason) {
  switch (reason) {
    case "unconfigured":
      return "GitHub discovery is unavailable: no discovery credential is configured, so repositories, refs and GitHub Projects can't be listed. Type the repository and ref; the service still verifies the local checkout. Repository access is exactly what you add here.";
    case "missing-credential":
      return "GitHub discovery is unavailable: the discovery credential has no value in the service environment.";
    case "unauthorized":
      return "GitHub discovery is unavailable: GitHub rejected the credential.";
    case "forbidden":
      return "GitHub discovery is unavailable: the credential can't read these lists.";
    case "rate-limited":
      return "GitHub discovery is unavailable: GitHub's rate limit was reached.";
    case "unreadable":
      return "GitHub discovery is unavailable: GitHub couldn't be read.";
  }
}

/** The folder to open first: the chosen path's parent when it is home-relative, else `~`. */
export function pickerStart(path: string) {
  const parts = path.trim().replace(/\/+$/, "").split("/");
  return parts[0] === "~" && parts.length > 1
    ? parts.slice(0, -1).join("/") || "~"
    : "~";
}

/** The chosen Project only when the current ready list shows it; otherwise nothing is linked. */
export function listedProject(
  id: string,
  list: {
    linked: readonly { projectNodeId: string }[];
    owned: readonly { projectNodeId: string }[];
  } | null,
) {
  return id &&
    list &&
    [...list.linked, ...list.owned].some((p) => p.projectNodeId === id)
    ? id
    : "";
}
