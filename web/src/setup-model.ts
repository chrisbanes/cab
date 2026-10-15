/** Pure model for guided project setup: rows, the create command and fixed copy. */
import {
  type CheckoutVerification,
  type ComposerOptions,
  type DiscoveryUnavailableReason,
  executionHarnessLabels,
  type FolderListing,
  type ghLoginStateSchema,
  type OperatorCommand,
  type sourceCredentialStatusSchema,
  unsupportedRuntimeField,
  type Workspace,
} from "../../src/operator/contracts.js";
import type { ReadinessCheck } from "../../src/operator/readiness.js";
import { sourceCredentialExplanation } from "../../src/operator/source-credential.js";
import type { z } from "zod";
import { unavailableAlert } from "./execution-runtime.js";

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
/**
 * A row with nothing entered is repository-free and left out of the command. Any value the
 * form shows counts: a ref is visible in typed entry; a discovered row without a repository
 * hides its Ref field, so a ref left there does not count.
 */
export const blankRow = (r: SetupRow) =>
  !r.repositoryId &&
  !r.text.trim() &&
  !r.path.trim() &&
  !(r.source === "typed" && r.ref.trim());
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
  /** The source login setup showed as signed in; anything else records no credential. */
  sourceGh: z.infer<typeof ghLoginStateSchema> | null | undefined = null,
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
    // Omitted, never undefined, so a create without it keeps its payload hash.
    ...(sourceGh?.state === "signed-in"
      ? { sourceCredentialRef: "gh:github.com" }
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
    case "gh-not-installed":
      return "GitHub discovery is unavailable: the GitHub CLI login was chosen, but gh is not installed for the service.";
    case "gh-not-signed-in":
      return "GitHub discovery is unavailable: the GitHub CLI login was chosen, but gh is not signed in to github.com. Run gh auth login.";
    case "gh-unreadable":
      return "GitHub discovery is unavailable: the service couldn't read the GitHub CLI login.";
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

/** One thing that would make the first task wait, with the fix a readiness check gives for it. */
export interface WaitItem {
  text: string;
  fix?: string;
  link?: { label: string; href: string };
}
export type ReadinessRead =
  | { state: "loading" }
  | { state: "unavailable" }
  | { state: "ready"; checks: readonly ReadinessCheck[] };

/**
 * What the ready check says would make work wait, from reads already loaded. Every item
 * blocks Resume, and so does a readiness read that is loading or failed. Capacity never
 * blocks: it changes as other work runs, so it is only reported. Texts are fixed strings
 * (readiness reasons and fixes are privacy-safe); no profile name or path appears.
 */
export function readyCheckItems(input: {
  leadProfileId: string | null;
  workspace: Workspace["data"] | null;
  readiness: ReadinessRead;
  capacity: ComposerOptions["data"]["capacity"] | null;
}) {
  const { workspace, readiness, capacity } = input;
  const items: WaitItem[] = [];
  const runtimeLink = {
    label: "Runtime settings",
    href: "/app/settings/runtime",
  };
  // With no runtime enabled the readiness check speaks for every lead, so say it once.
  const noRuntime =
    readiness.state === "ready"
      ? readiness.checks.find(
          (c) => c.id === "runtime-enabled" && c.status === "fail",
        )
      : undefined;
  if (noRuntime?.reason && noRuntime.fix)
    items.push({
      text: noRuntime.reason,
      fix: noRuntime.fix,
      link: runtimeLink,
    });
  if (workspace) {
    const lead = workspace.profiles.find(
      (profile) => profile.id === input.leadProfileId && !profile.revoked,
    );
    if (!lead)
      items.push({
        text: "No lead profile. Tasks wait for a lead before starting.",
      });
    else {
      const harness = lead.runtime.harness;
      const status = workspace.harnesses.find((h) => h.harness === harness);
      if (
        status?.state === "unavailable" ||
        (harness === "codex" &&
          workspace.runtime.state === "unavailable" &&
          status?.state !== "not-configured")
      )
        items.push({ text: unavailableAlert({ harness }) });
      else if (status?.state === "not-configured" && !noRuntime)
        items.push({
          text: `${executionHarnessLabels[harness]} runtime isn't enabled for this service.`,
          link: runtimeLink,
        });
      // The readiness check for this is a count over every profile, so it cannot speak for
      // this lead. The service applies the same rule to the settings the workspace carries;
      // while those are unknown (before the first Claude turn) nothing can be judged.
      else if (
        status?.settings &&
        unsupportedRuntimeField(lead.runtime, status.settings)
      )
        items.push({
          text: `${executionHarnessLabels[harness]} runtime doesn't accept the lead profile's model or reasoning effort.`,
          link: {
            label: "Edit profile",
            href: `/app/profiles/${lead.id}/settings`,
          },
        });
      const own: readonly string[] =
        harness === "claude"
          ? ["claude-executable", "claude-token"]
          : ["codex-executable", "codex-login"];
      if (readiness.state === "ready")
        // A runtime that is not enabled is already one item above; its checks repeat it.
        for (const c of readiness.checks)
          if (
            own.includes(c.id) &&
            c.reason &&
            c.fix &&
            !(
              status?.state === "not-configured" &&
              c.status === "not-configured"
            )
          )
            items.push({
              text: c.reason,
              fix: c.fix,
              ...(c.id === "claude-token"
                ? {
                    link: {
                      label: "Add Claude",
                      href: "/app/settings/runtime",
                    },
                  }
                : {}),
            });
    }
  }
  if (readiness.state === "unavailable")
    items.push({ text: "Readiness couldn't be checked." });
  const checking = !workspace || readiness.state === "loading";
  return {
    items,
    checking,
    blocked: checking || items.length > 0,
    capacityFull:
      capacity !== null &&
      (capacity.projectUsage >= capacity.projectLimit ||
        capacity.globalUsage >= capacity.globalLimit),
  };
}

/** Frames 115–117b: the source credential guided setup will record, stated before Create. */
export function setupSourceCredentialCopy(
  /** `undefined` while the read is pending; `null` after a failed read. */
  sourceGh: z.infer<typeof ghLoginStateSchema> | null | undefined,
) {
  if (sourceGh === undefined) return "GitHub source credential: checking…";
  return sourceGh?.state === "signed-in"
    ? `GitHub source credential: GitHub CLI · @${sourceGh.login}. Change or clear it later in the project's GitHub source settings.`
    : `GitHub source credential: none. ${sourceGh ? "No usable GitHub CLI login was detected" : "The GitHub CLI login could not be checked"}, so the source starts without a credential and won't sync until one is set in its GitHub source settings.`;
}

/**
 * Frames 146–147: the recorded source credential from the configuration read. Informational
 * only; it never blocks Resume. `undefined` is still loading, `null` a failed read.
 */
export function sourceCredentialLine(
  projectId: string,
  source:
    | {
        credentialConfigured: boolean;
        credential?: z.infer<typeof sourceCredentialStatusSchema> | undefined;
      }
    | null
    | undefined,
): WaitItem {
  if (source === undefined)
    return { text: "GitHub source credential: checking…" };
  if (source === null)
    return { text: "GitHub source credential: status unavailable." };
  const link = {
    label: "GitHub source settings",
    href: `/app/projects/${projectId}/settings?tab=github`,
  };
  const status = source.credential;
  if (!source.credentialConfigured)
    return {
      text: "GitHub source credential: not set. The source won't sync until one is set.",
      link,
    };
  if (!status) return { text: "GitHub source credential: status unavailable." };
  const kind = status.source === "gh" ? "GitHub CLI" : "environment variable";
  if (!status.usable)
    return {
      text: `GitHub source credential: ${kind}. ${sourceCredentialExplanation(status.reason ?? "missing-credential")}`,
      link,
    };
  return {
    text:
      status.source === "gh" && status.gh.state === "signed-in"
        ? `GitHub source credential: GitHub CLI · @${status.gh.login}`
        : `GitHub source credential: ${kind}`,
  };
}
