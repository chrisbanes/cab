import { projectPrivateValuesSchema } from "../../src/operator/contracts.js";
import { noRuleText } from "../../src/operator/readiness-text.js";
import { useEffect, useState, type ReactNode } from "react";
import { CircleCheck } from "lucide-react";
import { Button, StatusBadge } from "./components.js";
import type { TabProps } from "./project-config.js";
import {
  adoptSourceRows,
  closedIssueLabels,
  duplicateSourceIds,
  kindLabel,
  nextSelectionId,
  parseRows,
  removesAllAccess,
  sourceChanges,
  sourceCommand,
  sourceRowsFrom,
  staleSourceRows,
  type SourceRow,
  type Values,
} from "./settings-changes.js";
import {
  Aside,
  ChangeList,
  DraftCheck,
  DraftField,
  DraftOutcome,
  Panel,
  key,
  locked,
  reloadDraft,
  submitDraft,
  useDraft,
  useLoadedDraft,
  usePrivateValues,
} from "./settings.js";
import { ghLoginCopy } from "./discovery-credential.js";
import {
  sourceCredentialCopy,
  sourceCredentialSummary,
} from "./settings-view.js";
import { Alert } from "./ui/alert.js";
import { Input } from "./ui/input.js";
import { NativeSelect } from "./ui/native-select.js";
import {
  ProjectFieldPicker,
  useReadinessDiscovery,
} from "./readiness-picker.js";
import { ObservationCounts, readinessAnchor } from "./observation-counts.js";
import type { ObservationResource } from "./sync-placement.js";

const withKeys = (rows: object[]) =>
  JSON.stringify(rows.map((r) => ({ ...r, rowKey: key() })));

export function SourceTab(p: TabProps & { observations: ObservationResource }) {
  const { data, projectId } = p,
    draftKey = `github.configure:${projectId}`,
    d = useDraft(p.drafts, draftKey);
  const observed = p.observations.state.data?.data.projects.find(
    (r) => r.projectId === projectId,
  );
  // Saved search queries and local paths load with the tab; they show only while read at
  // the source version now loaded, and otherwise read as unavailable until read again.
  const priv = usePrivateValues(
    p.client,
    p.session,
    `/api/operator/projects/${projectId}/private-values`,
    projectPrivateValuesSchema,
    true,
  );
  const privateData = priv.state.data?.data.source;
  const known =
    privateData?.version === data.source.version ? privateData : undefined;
  const staleKnown = privateData !== undefined && known === undefined;
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-read once per source version.
  useEffect(() => {
    if (staleKnown && !priv.state.pending) priv.refresh();
  }, [data.source.version]);
  // The panel renders after the configuration read, so the browser cannot scroll to it.
  useEffect(() => {
    if (location.hash === `#${readinessAnchor}`)
      document.getElementById(readinessAnchor)?.focus();
  }, []);
  const loaded = sourceRowsFrom(data.source);
  const initial: Values = {
    expectedVersion: String(data.source.version),
    referenceMode: "preserve",
    credentialRef: "",
    selections: withKeys(loaded.selections),
    conditions: withKeys(loaded.conditions),
    mode: loaded.mode,
    closedIssues: loaded.closedIssues,
    repositories: withKeys(loaded.repositories),
    removeAll: false,
  };
  // Row keys are regenerated per render, so the load is identified by the saved read.
  useLoadedDraft(d, initial, p.loadedAt, data.source);
  const v = d.values,
    selections = parseRows(v.selections),
    conditions = parseRows(v.conditions),
    repositories = parseRows(v.repositories),
    isLocked = locked(d);
  const lines = sourceChanges(data.source, v, known),
    removesAll = removesAllAccess(data.source, v),
    stale = staleSourceRows(data.source, v),
    duplicates = duplicateSourceIds(v),
    blocked =
      loaded.incomplete ||
      stale.length > 0 ||
      duplicates.length > 0 ||
      lines.length === 0 ||
      // An unknown saved rule is only replaced by a rule, never cleared to none.
      (data.source.readiness.kind === "unavailable" &&
        conditions.length === 0) ||
      (v.referenceMode === "gh" &&
        data.source.credential?.gh.state !== "signed-in") ||
      (removesAll && !v.removeAll);
  const readinessDiscovery = useReadinessDiscovery({
    client: p.client,
    csrfToken: p.session.csrfToken,
    enabled: conditions.some((r) => r.kind === "project-field"),
    saved: data.source.repositories.map((r) => ({
      repositoryId: r.repositoryId ?? "",
    })),
    projectIds: conditions.flatMap((r) =>
      r.kind === "project-field" && r.projectNodeId
        ? [String(r.projectNodeId)]
        : [],
    ),
  });
  const adopt = () => {
    // An unsettled save keeps its own message; nothing is loaded or discarded then.
    if (locked(d)) return;
    d.adoptLatest(data.source.version, initial, [
      ["mode", "conditions"],
      ["closedIssues"],
    ]);
    const rows = adoptSourceRows(data.source, d.values);
    if (rows.dropped.length)
      d.notice = `Loaded the latest version. ${rows.dropped.join(", ")} ${rows.dropped.length === 1 ? "was" : "were"} removed elsewhere, so your edits to ${rows.dropped.length === 1 ? "it" : "them"} were discarded.`;
    d.set("selections", rows.selections);
    d.set("repositories", rows.repositories);
  };
  const setRows = (field: string, rows: SourceRow[]) => {
    d.set(field, JSON.stringify(rows));
    if (field === "repositories" && rows.some((r) => !r.removed))
      d.set("removeAll", false);
  };
  const update = (field: string, index: number, patch: SourceRow) => {
    const rows = parseRows(v[field]);
    rows[index] = { ...rows[index], ...patch };
    setRows(field, rows);
  };
  const drop = (field: string, index: number) =>
    setRows(
      field,
      parseRows(v[field]).filter((_, i) => i !== index),
    );
  const add = (field: string, row: SourceRow) =>
    setRows(field, [...parseRows(v[field]), { ...row, rowKey: key() }]);
  const rowError = (field: string, index: number, name: string) => {
    const path = field === "conditions" ? "readiness.conditions" : field;
    return (
      d.errors[path] ||
      d.errors[`${path}.${index}.${name}`] ||
      d.errors[`${path}.${name}`]
    );
  };
  const input = (
    field: string,
    index: number,
    name: string,
    label: string,
    /** What shows until the operator edits the field. */
    fallback = "",
  ) => (
    <label className="field body" htmlFor={`source-${field}-${index}-${name}`}>
      {label}
      <Input
        className="control"
        id={`source-${field}-${index}-${name}`}
        aria-label={label}
        aria-invalid={Boolean(rowError(field, index, name))}
        aria-describedby={
          rowError(field, index, name) ? `source-${field}-error` : undefined
        }
        value={String(parseRows(v[field])[index]?.[name] ?? fallback)}
        onChange={(e) => update(field, index, { [name]: e.target.value })}
      />
    </label>
  );
  /** A saved private value, editable once read; otherwise unavailable with a way to read it again. */
  const savedValue = (
    field: string,
    index: number,
    name: "query" | "path",
    label: string,
    unavailable: string,
    baseline: string | undefined,
  ) => {
    const edited = typeof parseRows(v[field])[index]?.[name] === "string";
    if (baseline !== undefined || edited)
      return input(field, index, name, label, baseline ?? "");
    return (
      <div className="field body">
        <span>{label}</span>
        <p className="metadata muted">
          {priv.state.pending ? `Loading ${label.toLowerCase()}…` : unavailable}
        </p>
        {!priv.state.pending && (
          <div>
            <Button type="button" variant="secondary" onClick={priv.refresh}>
              Try again
            </Button>
          </div>
        )}
      </div>
    );
  };
  const errorText = (prefix: string, id: string, text: string): ReactNode =>
    Object.keys(d.errors).some((k) => k.startsWith(prefix)) && (
      <p id={id} className="body error-text" role="alert">
        {text}
      </p>
    );
  return (
    <form
      onSubmit={(e) =>
        void submitDraft(
          e,
          d,
          p.client,
          p.session,
          sourceCommand(projectId, v, known),
          p.refreshConfiguration,
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
          A saved source or repository link cannot be shown here, so this form
          cannot keep it. Use the advanced source editor.
        </Alert>
      )}
      <div className="settings-split">
        <div className="settings-column">
          <SourceCredential draft={d} source={data.source} />
          <Panel
            title="1 · Discovery sources"
            description="Search queries and local paths show here for you to edit; GitHub Project filters stay hidden. New sources are added inactive."
          >
            <fieldset disabled={isLocked} className="settings-rows">
              <legend className="sr-only">Discovery sources</legend>
              {errorText(
                "selections",
                "source-selections-error",
                "Check the new source fields.",
              )}
              {selections.map((r, i) =>
                r.keep ? (
                  <div className="settings-row" key={String(r.rowKey)}>
                    <div className="settings-row-heading">
                      <div>
                        <h3 className="small-heading">
                          {String(r.id)} · {kindLabel(r.kind)}
                        </h3>
                        {r.kind !== "search" && (
                          <p className="metadata muted">
                            {r.kind === "project"
                              ? `${r.descriptor} · Filter kept · private`
                              : String(r.descriptor)}
                          </p>
                        )}
                      </div>
                      <StatusBadge
                        tone={r.removed ? "warning" : "idle"}
                        icon={r.active && !r.removed ? CircleCheck : undefined}
                      >
                        {r.removed
                          ? "Will be removed"
                          : r.active
                            ? "Active"
                            : "Inactive"}
                      </StatusBadge>
                      <Button
                        type="button"
                        variant="secondary"
                        onClick={() =>
                          update("selections", i, { removed: !r.removed })
                        }
                      >
                        {r.removed ? `Undo remove ${r.id}` : `Remove ${r.id}`}
                      </Button>
                    </div>
                    {r.kind === "search" && !r.removed && (
                      <div className="settings-fields">
                        {savedValue(
                          "selections",
                          i,
                          "query",
                          "Search query",
                          "Query unavailable",
                          known?.searches.find((x) => x.id === r.id)?.query,
                        )}
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="settings-row" key={String(r.rowKey)}>
                    <div className="settings-row-heading">
                      <h3 className="small-heading">{String(r.id)}</h3>
                      <StatusBadge tone="idle">New · inactive</StatusBadge>
                      <Button
                        type="button"
                        variant="secondary"
                        onClick={() => drop("selections", i)}
                      >
                        Remove {String(r.id)}
                      </Button>
                    </div>
                    <div className="settings-fields">
                      <label
                        className="field body"
                        htmlFor={`selection-kind-${i}`}
                      >
                        Selection kind
                        <NativeSelect
                          className="control"
                          id={`selection-kind-${i}`}
                          aria-label="Selection kind"
                          value={String(r.kind)}
                          onChange={(e) => {
                            const kind = e.target.value;
                            const rows = parseRows(v.selections);
                            rows[i] = {
                              id: String(r.id),
                              rowKey: String(r.rowKey),
                              ...(kind === "repository"
                                ? {
                                    kind,
                                    repositoryId: "",
                                    owner: "",
                                    name: "",
                                  }
                                : kind === "project"
                                  ? { kind, projectNodeId: "", filter: "" }
                                  : { kind, query: "" }),
                            };
                            setRows("selections", rows);
                          }}
                        >
                          <option value="repository">Repository</option>
                          <option value="search">Search</option>
                          <option value="project">GitHub Project</option>
                        </NativeSelect>
                      </label>
                      {r.kind === "repository" ? (
                        <>
                          {input(
                            "selections",
                            i,
                            "repositoryId",
                            "Repository ID",
                          )}
                          {input("selections", i, "owner", "Repository owner")}
                          {input("selections", i, "name", "Repository name")}
                        </>
                      ) : r.kind === "project" ? (
                        <>
                          {input(
                            "selections",
                            i,
                            "projectNodeId",
                            "GitHub Project node ID",
                          )}
                          {input("selections", i, "filter", "Project filter")}
                        </>
                      ) : (
                        input("selections", i, "query", "Search query")
                      )}
                    </div>
                  </div>
                ),
              )}
              <div>
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() =>
                    add("selections", {
                      id: nextSelectionId(
                        data.source.selections.flatMap((s) =>
                          s.id ? [s.id] : [],
                        ),
                        selections.map((s) => String(s.id)),
                      ),
                      kind: "repository",
                      repositoryId: "",
                      owner: "",
                      name: "",
                    })
                  }
                >
                  Add source
                </Button>
              </div>
            </fieldset>
          </Panel>
          <Panel
            title="3 · Repository access"
            description="Every change is listed for review before saving. Removing all access asks for confirmation."
          >
            <fieldset
              disabled={isLocked}
              className="settings-rows"
              aria-describedby={
                d.errors.repositories ? "source-repositories-error" : undefined
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
                        </div>
                        {r.removed && (
                          <StatusBadge tone="warning">
                            Will be removed
                          </StatusBadge>
                        )}
                        <Button
                          type="button"
                          variant="secondary"
                          onClick={() =>
                            update("repositories", i, { removed: !r.removed })
                          }
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
                          onClick={() => drop("repositories", i)}
                        >
                          Remove new repository {name}
                        </Button>
                      </div>
                    )}
                    {!r.removed && (
                      <div className="settings-fields">
                        {!r.keep &&
                          input(
                            "repositories",
                            i,
                            "repositoryId",
                            "Linked repository ID",
                          )}
                        {input(
                          "repositories",
                          i,
                          "ref",
                          "Linked repository ref",
                        )}
                        {r.keep
                          ? savedValue(
                              "repositories",
                              i,
                              "path",
                              "Local repository path",
                              "Local path unavailable",
                              known?.repositories.find(
                                (x) => x.repositoryId === r.repositoryId,
                              )?.path,
                            )
                          : input(
                              "repositories",
                              i,
                              "path",
                              "New local repository path",
                            )}
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
                    add("repositories", {
                      repositoryId: "",
                      path: "",
                      ref: "main",
                    })
                  }
                >
                  Add repository
                </Button>
              </div>
              {errorText(
                "repositories",
                "source-repositories-error",
                "Check linked repository IDs, paths and refs.",
              )}
            </fieldset>
          </Panel>
        </div>
        <div className="settings-column">
          <Panel
            title="2 · Readiness matching"
            description="Readiness admits work; it never grants repository access."
          >
            {observed?.selections.map((s, i) => (
              <ObservationCounts
                key={s.selectionId ?? i}
                label={s.selectionId ?? "Selection unavailable"}
                projectId={projectId}
                rule={observed.readiness}
                counts={s.counts}
                sameTab
              />
            ))}
            <fieldset
              id={readinessAnchor}
              disabled={isLocked}
              className="settings-rows"
              tabIndex={-1}
              aria-invalid={Boolean(d.errors["readiness.conditions"])}
              aria-describedby={
                d.errors["readiness.conditions"]
                  ? "source-conditions-error"
                  : undefined
              }
            >
              <legend className="sr-only">Readiness conditions</legend>
              {errorText(
                "readiness",
                "source-conditions-error",
                "Check readiness mode and complete conditions.",
              )}
              {data.source.readiness.kind === "unavailable" ? (
                <p className="metadata muted">
                  Saved readiness is unavailable; add a condition to replace it.
                </p>
              ) : (
                conditions.length === 0 && (
                  <p className="metadata muted">
                    {noRuleText} Matching applies once a condition is added.
                  </p>
                )
              )}
              <DraftField
                draft={d}
                field="mode"
                errorField="readiness.mode"
                label="Readiness matching"
              >
                <option value="all">All conditions</option>
                <option value="any">Any condition</option>
              </DraftField>
              {conditions.map((r, i) => (
                <div className="settings-row" key={String(r.rowKey)}>
                  <div className="settings-fields">
                    <label
                      className="field body"
                      htmlFor={`condition-kind-${i}`}
                    >
                      Condition kind
                      <NativeSelect
                        className="control"
                        id={`condition-kind-${i}`}
                        aria-label="Condition kind"
                        aria-invalid={Boolean(
                          rowError("conditions", i, "kind"),
                        )}
                        aria-describedby={
                          rowError("conditions", i, "kind")
                            ? "source-conditions-error"
                            : undefined
                        }
                        value={String(r.kind)}
                        onChange={(e) => {
                          const kind = e.target.value,
                            rows = parseRows(v.conditions);
                          rows[i] = {
                            ...(kind === "label"
                              ? { kind, name: "" }
                              : {
                                  kind,
                                  projectNodeId: "",
                                  fieldNodeId: "",
                                  optionNodeId: "",
                                }),
                            rowKey: String(r.rowKey),
                          };
                          setRows("conditions", rows);
                        }}
                      >
                        <option value="label">Label</option>
                        <option value="project-field">Project field</option>
                      </NativeSelect>
                    </label>
                    {r.kind === "label" ? (
                      input("conditions", i, "name", "Ready label")
                    ) : (
                      <ProjectFieldPicker
                        index={i}
                        row={r}
                        discovery={readinessDiscovery}
                        invalid={(name) =>
                          Boolean(rowError("conditions", i, name))
                        }
                        onChange={(patch) => update("conditions", i, patch)}
                        typed={
                          <>
                            {input(
                              "conditions",
                              i,
                              "projectNodeId",
                              "Readiness Project node ID",
                            )}
                            {input(
                              "conditions",
                              i,
                              "fieldNodeId",
                              "Readiness field node ID",
                            )}
                            {input(
                              "conditions",
                              i,
                              "optionNodeId",
                              "Readiness option node ID",
                            )}
                          </>
                        }
                      />
                    )}
                  </div>
                  <div>
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={() => drop("conditions", i)}
                    >
                      Remove condition {i + 1}
                    </Button>
                  </div>
                </div>
              ))}
              <div>
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => add("conditions", { kind: "label", name: "" })}
                >
                  Add readiness condition
                </Button>
              </div>
            </fieldset>
            <DraftField
              draft={d}
              field="closedIssues"
              label="Closed GitHub issues"
            >
              {Object.entries(closedIssueLabels).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </DraftField>
            <p className="metadata muted">
              Treat closure as Done marks the task closed on GitHub, not
              delivered by Ensemble, once its work has stopped.
            </p>
          </Panel>
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
              Saving imports no tasks and activates nothing. Afterwards every
              source, kept or new, reads inactive until it is previewed in Sync
              & placement.
            </p>
          </ChangeList>
          <Aside
            title="Source boundary"
            items={[
              "Saving replaces configuration only. It imports no tasks, activates no selection and resumes no work.",
              "Activation is a separate preview step in Sync & placement.",
              "GitHub Project filters stay hidden; remove a source and add a new one to change them.",
              <a key="advanced" href={`/project/${projectId}`}>
                Open advanced source editor
              </a>,
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
        discard={() => reloadDraft(d, initial)}
        refresh={p.refreshConfiguration}
        review={adopt}
      />
    </form>
  );
}

function SourceCredential({
  draft: d,
  source,
}: {
  draft: ReturnType<typeof useDraft>;
  source: TabProps["data"]["source"];
}) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (d.phase === "recorded") setOpen(false);
  }, [d.phase]);
  const shown = open || d.values.referenceMode !== "preserve";
  const status = source.credential;
  const busy = locked(d);
  return (
    <Panel
      title="GitHub source credential"
      description="A project created in guided setup starts with the GitHub CLI login setup detected, when it was usable; otherwise choose one here. Discovery credentials are configured separately."
    >
      <div className="settings-discovery-line">
        <p className="metadata">
          {sourceCredentialSummary(source)}
          {status?.source === "gh" && status.gh.state === "signed-in"
            ? ` · @${status.gh.login}`
            : ""}
        </p>
        {!shown && (
          <div className="settings-discovery-actions">
            <Button
              type="button"
              variant="secondary"
              disabled={busy}
              onClick={() => {
                d.set("referenceMode", "gh");
                setOpen(true);
              }}
            >
              {source.credentialConfigured ? "Change" : "Set"} source credential
            </Button>
            {source.credentialConfigured && (
              <Button
                type="button"
                variant="secondary"
                disabled={busy}
                onClick={() => {
                  d.set("referenceMode", "clear");
                  d.set("credentialRef", "");
                }}
              >
                Clear source credential
              </Button>
            )}
          </div>
        )}
      </div>
      {status && !status.usable && (
        <Alert role="alert">{sourceCredentialCopy(status.reason)}</Alert>
      )}
      {shown && (
        <fieldset disabled={busy} className="settings-rows">
          <legend className="sr-only">Source credential choice</legend>
          <DraftField
            draft={d}
            field="referenceMode"
            label="Source credential choice"
          >
            <option value="gh">GitHub CLI login</option>
            <option value="set">Environment reference</option>
            <option value="clear">Clear credential</option>
          </DraftField>
          {d.values.referenceMode === "gh" && (
            <p className="body">
              {status
                ? ghLoginCopy(status.gh)
                : "GitHub CLI status unavailable"}
              . Detection does not select this login; save to choose it.
            </p>
          )}
          {d.values.referenceMode === "set" && (
            <DraftField
              draft={d}
              field="credentialRef"
              label="New environment reference"
            />
          )}
          {d.values.referenceMode === "clear" && (
            <p className="body">
              Clear keeps source definitions and task history. Source knowledge
              becomes incomplete until a credential is set and fresh reads
              succeed.
            </p>
          )}
          <p className="metadata muted">
            Use env:NAME for an environment reference. Values stay server-side.
            Agent spawn environments need a service restart after configuration
            changes. Agents with access to this Mac's keychain can run gh
            themselves.
          </p>
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              d.set("referenceMode", "preserve");
              d.set("credentialRef", "");
              setOpen(false);
            }}
          >
            Cancel credential change
          </Button>
        </fieldset>
      )}
    </Panel>
  );
}
