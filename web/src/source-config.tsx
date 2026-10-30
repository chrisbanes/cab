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
  nextSelectionId,
  parseRows,
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
  DraftField,
  DraftOutcome,
  Panel,
  locked,
  reloadDraft,
  submitDraft,
  useDraft,
  sourceHold,
  useLoadedDraft,
  usePrivateValues,
} from "./settings.js";
import { ghLoginCopy } from "./discovery-credential.js";
import {
  draftSourceName,
  type SourceNaming,
  sourceCredentialCopy,
  sourceCredentialSummary,
  savedLine,
  sourceStatusLine,
} from "./settings-view.js";
import { OutcomeDetails } from "./action-feedback.js";
import { credentialReasonId, ImportPanel } from "./source-import.js";
import {
  hasProjectSource,
  savedSourceName,
  SourceHeading,
  sourceDetails,
} from "./source-names.js";
import {
  useDropMatchedEdits,
  useSettingsRows,
  withKeys,
} from "./settings-rows.js";
import { Alert } from "./ui/alert.js";
import { NativeSelect } from "./ui/native-select.js";
import {
  ProjectFieldOptions,
  ProjectFieldPicker,
  ReadinessLoginOffer,
  ReadyLabelPicker,
  useReadinessDiscovery,
} from "./readiness-picker.js";
import { ObservationCounts, readinessAnchor } from "./observation-counts.js";
import { StatusMappingPanel } from "./status-mapping-config.js";
import type { ObservationResource } from "./sync-placement.js";

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
    {
      autoLoad: true,
      loaded: data.source.version,
      version: (r) => r.data.source.version,
      refreshLoaded: p.refreshConfiguration,
    },
  );
  const privateData = priv.state.data?.data.source;
  const known =
    privateData?.version === data.source.version ? privateData : undefined;
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
  };
  // Row keys are regenerated per render, so the load is identified by the saved read.
  useLoadedDraft(d, initial, p.loadedAt, data.source);
  const v = d.values,
    selections = parseRows(v.selections),
    conditions = parseRows(v.conditions),
    isLocked = locked(d);
  // A retained query edit is compared with the saved value before it is sent.
  const holdSave =
    known === undefined &&
    selections.some((r) => r.keep && !r.removed && typeof r.query === "string");
  useDropMatchedEdits(
    d,
    "selections",
    "query",
    (r) =>
      r.keep &&
      typeof r.query === "string" &&
      known?.searches.find((x) => x.id === r.id)?.query === r.query,
    known,
  );
  const lines = sourceChanges(data.source, v, known),
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
        data.source.credential?.gh.state !== "signed-in");
  const readinessDiscovery = useReadinessDiscovery({
    client: p.client,
    csrfToken: p.session.csrfToken,
    // A saved Project source is named by the title discovery lists for it.
    enabled:
      conditions.some((r) => r.kind === "project-field") ||
      hasProjectSource(data.source),
    labels: conditions.some((r) => r.kind === "label"),
    saved: data.repositories.links.map((r) => ({
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
      d.notice = `Loaded the latest version. ${rows.dropped.join(", ")} ${rows.dropped.length === 1 ? "was" : "were"} removed or replaced elsewhere, so your edits to ${rows.dropped.length === 1 ? "it" : "them"} were discarded.`;
    d.set("selections", rows.selections);
  };
  const {
    setRows,
    update,
    toggleRemoved,
    drop,
    add,
    rowError,
    input,
    savedValue,
  } = useSettingsRows({
    draft: d,
    priv,
    privateRead: privateData !== undefined,
    controlId: (field, index, name) => `source-${field}-${index}-${name}`,
    errorId: (field) => `source-${field}-error`,
    errorPath: (field) =>
      field === "conditions" ? "readiness.conditions" : field,
    rowName: "id",
  });
  const errorText = (prefix: string, id: string, text: string): ReactNode =>
    Object.keys(d.errors).some((k) => k.startsWith(prefix)) && (
      <p id={id} className="body error-text" role="alert">
        {text}
      </p>
    );
  const naming = (s: TabProps["data"]["source"]["selections"][number]) =>
    savedSourceName(s, known, readinessDiscovery.choices);
  const savedNaming = (r: SourceRow) =>
    naming({
      id: String(r.id),
      kind: r.kind as "repository" | "search" | "project",
      descriptor: String(r.descriptor ?? "") || null,
      active: Boolean(r.active),
    });
  const observedRow = (id: unknown) =>
    observed?.selections.find((o) => o.selectionId === id);
  const projectSources = data.source.selections.filter(
    (s) => s.kind === "project" && s.descriptor,
  );
  /** The Remove and Undo names carry the S-n id, so two rows with one name stay distinct. */
  const rowName = (n: SourceNaming, id: unknown) =>
    `${n.private ? "Saved search" : n.name} (${String(id)})`;
  const details = (r: SourceRow, n: SourceNaming) =>
    sourceDetails(
      {
        id: String(r.id),
        kind: String(r.kind),
        descriptor: r.descriptor ? String(r.descriptor) : null,
      },
      n,
      observedRow(r.id),
      observed?.readiness,
    );
  // Nothing unsaved: the form is clean, so what is saved is what the page shows.
  const quiet = !isLocked && !d.dirty && lines.length === 0;
  const form = (
    <form
      onSubmit={(e) =>
        void submitDraft(
          e,
          d,
          p.client,
          p.session,
          sourceCommand(projectId, v, known),
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
          listed twice. Remove one of the rows before saving.
        </Alert>
      )}
      {loaded.incomplete && (
        <Alert variant="destructive" role="alert">
          A saved source cannot be shown here, so this form cannot keep it. Use
          the advanced source editor.
        </Alert>
      )}
      <div className="settings-split">
        <div className="settings-column">
          <Panel
            title="1 · Discovery sources"
            description="Sources are named by what they read. Search queries and local paths show here for you to edit; GitHub Project filters stay hidden."
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
                          <SourceHeading naming={savedNaming(r)} />
                        </h3>
                        <p className="body">
                          {sourceStatusLine(
                            observedRow(r.id),
                            observed?.readiness ?? { kind: "none" },
                          )}
                        </p>
                        {r.kind === "project" && (
                          <p className="metadata muted">
                            Filter kept · private
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
                        aria-label={`${r.removed ? "Undo remove" : "Remove"} ${rowName(
                          savedNaming(r),
                          r.id,
                        )}`}
                        onClick={() => toggleRemoved("selections", i)}
                      >
                        {r.removed ? "Undo remove" : "Remove"}
                      </Button>
                    </div>
                    <OutcomeDetails fields={details(r, savedNaming(r))} />
                    {r.kind === "project" && !r.removed && (
                      <ProjectFieldOptions
                        projectFields={observedRow(r.id)?.projectFields}
                      />
                    )}
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
                      <h3 className="small-heading">
                        <SourceHeading naming={draftSourceName(r)} />
                      </h3>
                      <StatusBadge tone="idle">Not saved yet</StatusBadge>
                      <Button
                        type="button"
                        variant="secondary"
                        aria-label={`Remove ${rowName(draftSourceName(r), r.id)}`}
                        onClick={() => drop("selections", i)}
                      >
                        Remove
                      </Button>
                    </div>
                    <OutcomeDetails
                      fields={[
                        ["Source ID", String(r.id)],
                        ["Kind", draftSourceName(r).kind],
                      ]}
                    />
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
              <p className="metadata muted">New sources are added inactive.</p>
            </fieldset>
          </Panel>
          <Panel
            title="2 · Readiness matching"
            description="Readiness admits work; it never grants repository access."
          >
            {observed?.selections.map((s, i) => {
              const saved = data.source.selections.find(
                (x) => x.id === s.selectionId,
              );
              return (
                <ObservationCounts
                  key={s.selectionId ?? i}
                  warningOnly
                  label={saved ? naming(saved).name : "A source"}
                  private={saved ? naming(saved).private : false}
                  projectId={projectId}
                  rule={observed.readiness}
                  counts={s.counts}
                  sameTab
                />
              );
            })}
            <ReadinessLoginOffer
              drafts={p.drafts}
              client={p.client}
              csrfToken={p.session.csrfToken}
              visible={conditions.length > 0}
              onRecorded={(moveFocus) => {
                readinessDiscovery.refresh();
                if (moveFocus)
                  document.getElementById(readinessAnchor)?.focus();
              }}
            />
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
                              ? { kind, operator: "has", name: "" }
                              : {
                                  kind,
                                  // The source's only GitHub Project is the likely one.
                                  projectNodeId:
                                    projectSources.length === 1
                                      ? String(projectSources[0]?.descriptor)
                                      : "",
                                  fieldNodeId: "",
                                  operator: "in",
                                  optionNodeIds: [],
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
                      <>
                        <label
                          className="field body"
                          htmlFor={`source-conditions-${i}-operator`}
                        >
                          Label operator
                          <NativeSelect
                            className="control"
                            id={`source-conditions-${i}-operator`}
                            aria-label="Label operator"
                            aria-invalid={Boolean(
                              rowError("conditions", i, "operator"),
                            )}
                            value={String(r.operator ?? "has")}
                            onChange={(e) =>
                              update("conditions", i, {
                                operator: e.target.value,
                              })
                            }
                          >
                            <option value="has">has</option>
                            <option value="lacks">does not have</option>
                          </NativeSelect>
                        </label>
                        <ReadyLabelPicker
                          index={i}
                          value={String(r.name ?? "")}
                          discovery={readinessDiscovery}
                          invalid={Boolean(rowError("conditions", i, "name"))}
                          onChange={(name) => update("conditions", i, { name })}
                          input={(label) =>
                            input("conditions", i, "name", label)
                          }
                        />
                      </>
                    ) : (
                      <ProjectFieldPicker
                        index={i}
                        row={r}
                        discovery={readinessDiscovery}
                        invalid={(name) =>
                          Boolean(rowError("conditions", i, name))
                        }
                        onChange={(patch) => update("conditions", i, patch)}
                        input={(name, label) =>
                          input("conditions", i, name, label)
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
                  onClick={() =>
                    add("conditions", {
                      kind: "label",
                      operator: "has",
                      name: "",
                    })
                  }
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
              delivered by cab, once its work has stopped.
            </p>
          </Panel>
        </div>
        <div className="settings-column">
          <SourceCredential draft={d} source={data.source} />
          <ChangeList lines={lines}>
            <p className="metadata muted">
              Saving imports nothing. After saving, Preview and import now
              appears here.
            </p>
          </ChangeList>
          <ImportPanel
            {...p}
            naming={naming}
            quiet={quiet}
            saved={
              savedLine(data.source.version, p.drafts.saved(draftKey)) !== null
            }
            savePhase={d.phase}
          />
          <Aside
            title="Source boundary"
            items={[
              "Saving replaces configuration only. It imports no tasks, activates no selection and resumes no work.",
              "Preview and import now previews and activates the saved sources, then refreshes them from GitHub. Sync & placement keeps later refreshes and placement, and offers Preview and import now again after a later save.",
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
        hold={holdSave ? sourceHold : undefined}
        discard={() => reloadDraft(d, initial)}
        refresh={p.refreshConfiguration}
        review={adopt}
      />
    </form>
  );
  return (
    <>
      {form}
      {data.statusMapping && (
        <StatusMappingPanel
          {...p}
          view={data.statusMapping}
          selectionName={(s) =>
            naming({
              id: s.id,
              kind: "project",
              descriptor: s.projectNodeId,
              active: s.active,
            }).name
          }
        />
      )}
    </>
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
        <Alert role="alert" id={credentialReasonId}>
          {sourceCredentialCopy(status.reason)}
        </Alert>
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
