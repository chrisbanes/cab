import { type ReactNode, useEffect, useRef, useState } from "react";
import type { z } from "zod";
import {
  type CheckoutVerification,
  gitLabProjectsSchema,
  type OperatorCommand,
} from "../../src/operator/contracts.js";
import type { OperatorClient } from "./api.js";
import { Button } from "./components.js";
import { FolderPicker } from "./folder-picker.js";
import { verificationCopy } from "./setup-model.js";
import { Input } from "./ui/input.js";
import { NativeSelect } from "./ui/native-select.js";

/** One GitLab repository row: chosen from the host's discovered projects. */
export interface GitLabRow {
  id: string;
  host: string;
  repositoryId: string;
  projectPath: string;
  ref: string;
  path: string;
}
const emptyGitLabRow = (host: string): GitLabRow => ({
  id: crypto.randomUUID(),
  host,
  repositoryId: "",
  projectPath: "",
  ref: "",
  path: "",
});

// ConfigurationDraft holds scalar values, so rows travel as one JSON string field.
export const gitLabRowsToDraft = (rows: GitLabRow[]) => JSON.stringify(rows);
export function gitLabRowsFromDraft(value: unknown): GitLabRow[] {
  try {
    const rows = JSON.parse(String(value ?? "[]")) as GitLabRow[];
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}
/** A row with no project and no folder is left out of the command. */
const blank = (r: GitLabRow) => !r.repositoryId && !r.path.trim();

/**
 * The create command with the GitLab rows appended after its GitHub rows, so
 * the GitHub row count (`rowIndex.length` in setup) offsets the GitLab rows' error paths.
 */
export function withGitLabRepositories(
  command: OperatorCommand,
  rows: GitLabRow[],
): { command: OperatorCommand; rowIndex: number[] } {
  const included = rows.flatMap((r, i) => (blank(r) ? [] : [i]));
  if (command.type !== "project.create" || !included.length)
    return { command, rowIndex: [] };
  return {
    command: {
      ...command,
      repositories: [
        ...(command.repositories ?? []),
        ...included.map((i) => {
          const r = rows[i] as GitLabRow;
          return {
            codeHost: "gitlab" as const,
            host: r.host,
            projectPath: r.projectPath,
            repositoryId: r.repositoryId,
            path: r.path.trim(),
            ref: r.ref.trim(),
          };
        }),
      ],
    },
    rowIndex: included,
  };
}

type Projects =
  | Extract<
      z.infer<typeof gitLabProjectsSchema>["data"],
      { state: "ready" | "unavailable" }
    >
  | { state: "loading" };
type Verification =
  | { state: "checking" }
  | CheckoutVerification["data"]
  | { state: "failed" };

const Labelled = ({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) => (
  // Each control carries the same text as its aria-label.
  <div className="field body">
    {label}
    {children}
  </div>
);

const unavailableCopy = (reason: string) =>
  reason === "unconfigured"
    ? "No GitLab credential is configured for this host."
    : `GitLab projects can't be listed: ${reason.replaceAll("-", " ")}.`;

/** GitLab repository rows for guided setup. Nothing is stored until Create. */
export function GitLabSetupRows({
  client,
  csrfToken,
  disabled,
  hosts,
  rows,
  setRows,
  rejected,
}: {
  client: OperatorClient;
  csrfToken: string;
  disabled: boolean;
  hosts: string[];
  rows: GitLabRow[];
  setRows: (rows: GitLabRow[]) => void;
  /** The service rejected this field of GitLab row `index`. */
  rejected: (index: number, field: string) => boolean;
}) {
  const [projects, setProjects] = useState<Record<string, Projects>>({});
  const requested = useRef(new Set<string>());
  const wanted = [...new Set(rows.map((r) => r.host).filter(Boolean))];
  // biome-ignore lint/correctness/useExhaustiveDependencies: each host is listed once per visit.
  useEffect(() => {
    for (const host of wanted) {
      if (requested.current.has(host)) continue;
      requested.current.add(host);
      setProjects((p) => ({ ...p, [host]: { state: "loading" } }));
      client
        .read(
          `/api/operator/discovery/gitlab-projects?host=${encodeURIComponent(host)}`,
          gitLabProjectsSchema,
        )
        .then(
          (r) => setProjects((p) => ({ ...p, [host]: r.data })),
          () =>
            setProjects((p) => ({
              ...p,
              [host]: { state: "unavailable", reason: "unreadable" },
            })),
        );
    }
  }, [wanted.join("\n"), client]);
  const [verifications, setVerifications] = useState<
    Record<string, { key: string; result: Verification }>
  >({});
  const verify = (row: GitLabRow) => {
    if (!row.path.trim() || !row.projectPath || !row.ref.trim()) return;
    const k = `${row.path}\n${row.host}/${row.projectPath}\n${row.ref}`;
    setVerifications((v) => ({
      ...v,
      [row.id]: { key: k, result: { state: "checking" } },
    }));
    client
      .verifyCheckout(
        {
          path: row.path.trim(),
          repository: {
            codeHost: "gitlab",
            host: row.host,
            projectPath: row.projectPath,
          },
          ref: row.ref.trim(),
        },
        csrfToken,
      )
      .then(
        (r) => r.data,
        (): Verification => ({ state: "failed" }),
      )
      .then((result) =>
        setVerifications((v) =>
          v[row.id]?.key === k ? { ...v, [row.id]: { key: k, result } } : v,
        ),
      );
  };
  const update = (i: number, next: GitLabRow) =>
    setRows(rows.map((r, j) => (j === i ? next : r)));
  return (
    <>
      {rows.map((row, i) => {
        const list = projects[row.host];
        const ready = list?.state === "ready" ? list : null;
        const v = verifications[row.id];
        const result =
          v?.key === `${row.path}\n${row.host}/${row.projectPath}\n${row.ref}`
            ? v.result
            : undefined;
        const expected = {
          owner: row.host,
          name: row.projectPath,
          ref: row.ref,
        };
        const copy =
          result?.state === "rejected"
            ? result.reason === "origin-provider"
              ? `This checkout's origin is not on ${row.host}, so it can't be matched to ${row.projectPath}.`
              : verificationCopy(result, expected)
            : null;
        return (
          <fieldset
            key={row.id}
            className="setup-row"
            aria-label={`GitLab repository row ${i + 1}`}
          >
            <div className="settings-fields">
              <Labelled label="GitLab host">
                <NativeSelect
                  aria-label="GitLab host"
                  className="control"
                  disabled={disabled}
                  value={row.host}
                  onChange={(e) =>
                    update(i, {
                      ...emptyGitLabRow(e.target.value),
                      id: row.id,
                    })
                  }
                >
                  {hosts.map((h) => (
                    <option key={h} value={h}>
                      {h}
                    </option>
                  ))}
                </NativeSelect>
              </Labelled>
              <Labelled label="GitLab project">
                <NativeSelect
                  aria-label="GitLab project"
                  className="control"
                  aria-invalid={rejected(i, "repositoryId")}
                  disabled={disabled || list?.state === "loading"}
                  value={row.repositoryId}
                  onChange={(e) => {
                    const p = ready?.projects.find(
                      (x) => x.repositoryId === e.target.value,
                    );
                    const next = p
                      ? {
                          ...row,
                          repositoryId: p.repositoryId,
                          projectPath: p.projectPath,
                          ref: p.defaultBranch,
                        }
                      : {
                          ...emptyGitLabRow(row.host),
                          id: row.id,
                          path: row.path,
                        };
                    update(i, next);
                    verify(next);
                  }}
                >
                  <option value="">Choose a project</option>
                  {ready?.projects.map((p) => (
                    <option key={p.repositoryId} value={p.repositoryId}>
                      {p.projectPath}
                    </option>
                  ))}
                </NativeSelect>
              </Labelled>
              <p className="metadata muted">
                {list?.state === "unavailable"
                  ? unavailableCopy(list.reason)
                  : ready
                    ? `Discovered from ${row.host} · ${ready.projects.length} projects${ready.truncated ? " (more exist; the first are listed)" : ""}`
                    : "Loading projects…"}
              </p>
              {row.projectPath && (
                <Labelled label="GitLab ref">
                  <Input
                    aria-label="GitLab ref"
                    className="control"
                    aria-invalid={rejected(i, "ref")}
                    disabled={disabled}
                    value={row.ref}
                    onChange={(e) => update(i, { ...row, ref: e.target.value })}
                  />
                </Labelled>
              )}
            </div>
            {row.projectPath && (
              <div className="setup-path">
                <Labelled label="GitLab checkout path">
                  <Input
                    aria-label="GitLab checkout path"
                    className="control"
                    aria-invalid={rejected(i, "path") || Boolean(copy)}
                    disabled={disabled}
                    value={row.path}
                    placeholder="~/src/repository"
                    onChange={(e) =>
                      update(i, { ...row, path: e.target.value })
                    }
                    onBlur={() => verify(row)}
                  />
                </Labelled>
                <FolderPicker
                  client={client}
                  csrfToken={csrfToken}
                  path={row.path}
                  disabled={disabled}
                  expected={null}
                  onUse={(path) => {
                    const next = { ...row, path };
                    update(i, next);
                    verify(next);
                  }}
                  trigger={
                    <Button type="button" variant="secondary">
                      Choose GitLab folder…
                    </Button>
                  }
                />
                <p
                  className={
                    copy || rejected(i, "path")
                      ? "error-text metadata"
                      : "metadata muted"
                  }
                  role="status"
                >
                  {copy ??
                    (rejected(i, "path")
                      ? "This folder no longer matches. Choose it again."
                      : result?.state === "verified"
                        ? `Verified on this Mac: git checkout · origin ${result.origin} · ${row.ref} available.`
                        : result?.state === "checking"
                          ? "Checking on this Mac…"
                          : "The service checks the checkout's origin and ref on this Mac.")}
                </p>
              </div>
            )}
            <div>
              <Button
                type="button"
                variant="secondary"
                disabled={disabled}
                onClick={() => setRows(rows.filter((_, j) => j !== i))}
              >
                Remove GitLab repository {i + 1}
              </Button>
            </div>
          </fieldset>
        );
      })}
      {hosts.length > 0 && rows.length < 20 && (
        <div>
          <Button
            type="button"
            variant="secondary"
            disabled={disabled}
            onClick={() =>
              setRows([...rows, emptyGitLabRow(hosts[0] as string)])
            }
          >
            Add a GitLab repository
          </Button>
        </div>
      )}
    </>
  );
}
