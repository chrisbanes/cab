import { projectPrivateValuesSchema } from "../../src/operator/contracts.js";
import { useEffect } from "react";
import { Button, StatusBadge } from "./components.js";
import type { TabProps } from "./project-config.js";
import {
  adoptRepositoryRows,
  duplicateRepositoryIds,
  parseRows,
  removesAllAccess,
  repositoryChanges,
  repositoryCommand,
  repositoryRowsFrom,
  staleRepositoryRows,
  type SourceRow,
  type Values,
} from "./settings-changes.js";
import {
  Aside,
  ChangeList,
  DraftCheck,
  DraftOutcome,
  Panel,
  key,
  locked,
  reloadDraft,
  submitDraft,
  useDraft,
  sourceHold,
  useLoadedDraft,
  usePrivateValues,
} from "./settings.js";
import { Alert } from "./ui/alert.js";
import { Input } from "./ui/input.js";

const withKeys = (rows: object[]) =>
  JSON.stringify(rows.map((r) => ({ ...r, rowKey: key() })));

/** The project's repository links: the checkouts workspaces, delivery and setup use. */
export function RepositoryTab(p: TabProps) {
  const { data, projectId } = p,
    draftKey = `repositories.configure:${projectId}`,
    d = useDraft(p.drafts, draftKey);
  // Saved local paths load with the tab; they show only while read at the link version now
  // loaded, and otherwise read as unavailable until read again.
  const priv = usePrivateValues(
    p.client,
    p.session,
    `/api/operator/projects/${projectId}/private-values`,
    projectPrivateValuesSchema,
    {
      autoLoad: true,
      loaded: data.repositories.version,
      version: (r) => r.data.repositories.version,
      refreshLoaded: p.refreshConfiguration,
    },
  );
  const privateData = priv.state.data?.data.repositories;
  const known =
    privateData?.version === data.repositories.version
      ? privateData
      : undefined;
  const loaded = repositoryRowsFrom(data.repositories);
  const initial: Values = {
    expectedVersion: String(data.repositories.version),
    repositories: withKeys(loaded.repositories),
    removeAll: false,
  };
  // Row keys are regenerated per render, so the load is identified by the saved read.
  useLoadedDraft(d, initial, p.loadedAt, data.repositories);
  const v = d.values,
    repositories = parseRows(v.repositories),
    isLocked = locked(d);
  // A retained path edit is compared with the saved value before it is sent.
  const holdSave =
    known === undefined &&
    repositories.some(
      (r) => r.keep && !r.removed && typeof r.path === "string",
    );
  // An edit that now equals the saved value (another writer saved the same) is no edit: drop it
  // so the form is clean and later reads apply.
  const equalsSaved = (r: SourceRow) =>
    r.keep &&
    typeof r.path === "string" &&
    known?.links.find((x) => x.repositoryId === r.repositoryId)?.path ===
      r.path;
  const matchedSaved =
    (d.phase === "editing" ||
      d.phase === "conflict" ||
      d.phase === "rejected") &&
    repositories.some(equalsSaved);
  // biome-ignore lint/correctness/useExhaustiveDependencies: act when a read makes an edit equal.
  useEffect(() => {
    if (!matchedSaved) return;
    d.set(
      "repositories",
      JSON.stringify(
        repositories.map((r) => {
          if (!equalsSaved(r)) return r;
          const { path: _v, pathBase: _b, ...rest } = r;
          return rest;
        }),
      ),
    );
  }, [matchedSaved, known]);
  const lines = repositoryChanges(data.repositories, v, known),
    removesAll = removesAllAccess(data.repositories, v),
    stale = staleRepositoryRows(data.repositories, v),
    duplicates = duplicateRepositoryIds(v),
    blocked =
      loaded.incomplete ||
      stale.length > 0 ||
      duplicates.length > 0 ||
      lines.length === 0 ||
      (removesAll && !v.removeAll);
  const adopt = () => {
    // An unsettled save keeps its own message; nothing is loaded or discarded then.
    if (locked(d)) return;
    d.adoptLatest(data.repositories.version, initial);
    const rows = adoptRepositoryRows(data.repositories, d.values);
    if (rows.dropped.length)
      d.notice = `Loaded the latest version. ${rows.dropped.join(", ")} ${rows.dropped.length === 1 ? "was" : "were"} removed or replaced elsewhere, so your edits to ${rows.dropped.length === 1 ? "it" : "them"} were discarded.`;
    d.set("repositories", rows.repositories);
  };
  const setRows = (rows: SourceRow[]) => {
    d.set("repositories", JSON.stringify(rows));
    if (rows.some((r) => !r.removed)) d.set("removeAll", false);
  };
  const update = (
    index: number,
    patch: SourceRow | undefined,
    /** The row without the patch's keys, when the patch is undefined (an edit reverted). */
    reverted?: SourceRow,
  ) => {
    const rows = parseRows(v.repositories);
    rows[index] = patch ? { ...rows[index], ...patch } : (reverted ?? {});
    setRows(rows);
  };
  /** Undoing a removal drops the marker, so the row reads exactly as it was loaded. */
  const toggleRemoved = (index: number) => {
    const rows = parseRows(v.repositories);
    const { removed, ...rest } = rows[index] ?? {};
    rows[index] = removed ? rest : { ...rest, removed: true };
    setRows(rows);
  };
  const drop = (index: number) =>
    setRows(parseRows(v.repositories).filter((_, i) => i !== index));
  const rowError = (index: number, name: string) =>
    d.errors.repositories ||
    d.errors[`repositories.${index}.${name}`] ||
    d.errors[`repositories.${name}`];
  const input = (
    index: number,
    name: string,
    label: string,
    /** What shows until the operator edits the field. */
    fallback = "",
    /** Replaces the plain row update, for a saved value that tracks its baseline. */
    change?: (value: string) => void,
  ) => (
    <label className="field body" htmlFor={`repository-${index}-${name}`}>
      {label}
      <Input
        className="control"
        id={`repository-${index}-${name}`}
        aria-label={label}
        aria-invalid={Boolean(rowError(index, name))}
        aria-describedby={
          rowError(index, name) ? "repository-error" : undefined
        }
        value={String(parseRows(v.repositories)[index]?.[name] ?? fallback)}
        onChange={(e) =>
          change
            ? change(e.target.value)
            : update(index, { [name]: e.target.value })
        }
      />
    </label>
  );
  /** A saved local path, editable once read; otherwise unavailable with a way to read it again. */
  const savedPath = (index: number, baseline: string | undefined) => {
    const row = parseRows(v.repositories)[index];
    const edited = typeof row?.path === "string";
    // The text an edit started from; typing it back removes the edit, so the row is kept again.
    const base = edited ? String(row?.pathBase ?? "") : baseline;
    const label = "Local repository path";
    const id = String(row?.repositoryId ?? "");
    if (baseline !== undefined || edited)
      return (
        <>
          {input(index, "path", label, baseline ?? "", (value) => {
            const { path: _value, pathBase: _base, ...rest } = row ?? {};
            update(
              index,
              value === (baseline ?? base ?? "")
                ? undefined
                : { path: value, pathBase: base ?? "" },
              rest,
            );
          })}
          {edited && baseline !== undefined && baseline !== base && (
            <p className="metadata muted" role="status">
              This was changed elsewhere since you started editing. Saving
              replaces it.
            </p>
          )}
          {edited &&
            baseline === undefined &&
            !priv.state.pending &&
            (priv.state.error !== null || privateData !== undefined) && (
              <p className="body error-text" role="alert">
                Couldn't check whether this changed elsewhere.{" "}
                <Button
                  type="button"
                  variant="secondary"
                  aria-label={`Try again to check the local repository path for ${id}`}
                  onClick={priv.refresh}
                >
                  Try again
                </Button>
              </p>
            )}
        </>
      );
    return (
      <div className="field body">
        <span>{label}</span>
        <p className="metadata muted">
          {priv.state.pending
            ? "Loading local repository path…"
            : "Local path unavailable"}
        </p>
        <div>
          <Button
            type="button"
            variant="secondary"
            aria-label={`Try again to load the local repository path for ${id}`}
            aria-busy={priv.state.pending || undefined}
            aria-disabled={priv.state.pending || undefined}
            onClick={() => {
              if (!priv.state.pending) priv.refresh();
            }}
          >
            Try again
          </Button>
        </div>
      </div>
    );
  };
  return (
    <form
      onSubmit={(e) =>
        void submitDraft(
          e,
          d,
          p.client,
          p.session,
          repositoryCommand(projectId, v, known),
          p.refreshConfiguration,
          {},
          holdSave,
        )
      }
    >
      {stale.length > 0 && (
        <Alert variant="destructive" role="alert">
          {stale.join(", ")} {stale.length === 1 ? "is" : "are"} no longer
          saved. Review the changes made elsewhere, or discard yours, before
          saving.
          {!locked(d) && d.phase !== "conflict" && (
            <Button type="button" variant="secondary" onClick={adopt}>
              Review changes
            </Button>
          )}
        </Alert>
      )}
      {duplicates.length > 0 && (
        <Alert variant="destructive" role="alert">
          {duplicates.join(", ")} {duplicates.length === 1 ? "is" : "are"}{" "}
          linked twice. Remove one of the rows before saving: remove the new row
          to keep the saved link, or remove the saved link to replace it.
        </Alert>
      )}
      {loaded.incomplete && (
        <Alert variant="destructive" role="alert">
          A saved repository link cannot be shown here, so this form cannot keep
          it. Use the advanced editor.
        </Alert>
      )}
      <div className="settings-split">
        <div className="settings-column">
          <Panel
            title="Repository access"
            description="Every change is listed for review before saving. Removing all access asks for confirmation. Local paths show here for you to edit."
          >
            <fieldset
              disabled={isLocked}
              className="settings-rows"
              aria-describedby={
                d.errors.repositories ? "repository-error" : undefined
              }
            >
              <legend className="sr-only">Repository access</legend>
              {repositories.map((r, i) => {
                const name = String(r.repositoryId || `row ${i + 1}`);
                return (
                  <div className="settings-row" key={String(r.rowKey)}>
                    {r.keep ? (
                      <div className="settings-row-heading">
                        <div>
                          <h3 className="small-heading">{name}</h3>
                          <p className="metadata muted">GitHub · github.com</p>
                        </div>
                        {r.removed && (
                          <StatusBadge tone="warning">
                            Will be removed
                          </StatusBadge>
                        )}
                        <Button
                          type="button"
                          variant="secondary"
                          onClick={() => toggleRemoved(i)}
                        >
                          {r.removed
                            ? `Undo remove repository ${name}`
                            : `Remove repository ${name}`}
                        </Button>
                      </div>
                    ) : (
                      <div className="settings-row-heading">
                        <StatusBadge>New repository link</StatusBadge>
                        <Button
                          type="button"
                          variant="secondary"
                          onClick={() => drop(i)}
                        >
                          Remove new repository {name}
                        </Button>
                      </div>
                    )}
                    {!r.removed && (
                      <div className="settings-fields">
                        {!r.keep &&
                          input(i, "repositoryId", "Linked repository ID")}
                        {input(i, "ref", "Linked repository ref")}
                        {r.keep
                          ? savedPath(
                              i,
                              known?.links.find(
                                (x) => x.repositoryId === r.repositoryId,
                              )?.path,
                            )
                          : input(i, "path", "New local repository path")}
                      </div>
                    )}
                  </div>
                );
              })}
              <div>
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() =>
                    setRows([
                      ...repositories,
                      {
                        repositoryId: "",
                        path: "",
                        ref: "main",
                        rowKey: key(),
                      },
                    ])
                  }
                >
                  Add repository
                </Button>
              </div>
              {Object.keys(d.errors).some((k) =>
                k.startsWith("repositories"),
              ) && (
                <p
                  id="repository-error"
                  className="body error-text"
                  role="alert"
                >
                  Check linked repository IDs, paths and refs.
                </p>
              )}
            </fieldset>
          </Panel>
        </div>
        <div className="settings-column">
          <ChangeList
            lines={
              removesAll
                ? [
                    ...lines,
                    `Removes every repository from ${data.project.name ?? "this project"}.`,
                  ]
                : lines
            }
          >
            {removesAll && (
              <DraftCheck
                draft={d}
                field="removeAll"
                label="Remove all repository access"
              />
            )}
            <p className="metadata muted">
              Saving verifies every checkout and changes no GitHub source.
            </p>
          </ChangeList>
          <Aside
            title="Repository boundary"
            items={[
              "Repository links are project configuration: workspaces, delivery and setup read them. Only GitHub on github.com is supported.",
              "Readiness never grants repository access, and saving here neither imports nor activates any source.",
            ]}
          />
        </div>
      </div>
      <DraftOutcome
        draft={d}
        client={p.client}
        session={p.session}
        label="Save changes"
        saveDisabled={blocked}
        hold={holdSave ? sourceHold : undefined}
        discard={() => reloadDraft(d, initial)}
        refresh={p.refreshConfiguration}
        review={adopt}
      />
    </form>
  );
}
