import type { ReactNode } from "react";
import { Button, StatusBadge } from "./components.js";
import type { TabProps } from "./project-config.js";
import {
  nextSelectionId,
  parseRows,
  removesAllAccess,
  sourceChanges,
  sourceCommand,
  sourceRowsFrom,
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
  ReferenceInput,
  SavedNotice,
  key,
  locked,
  reloadDraft,
  submitDraft,
  useDraft,
  useLoadedDraft,
} from "./settings.js";
import { Alert } from "./ui/alert.js";
import { Input } from "./ui/input.js";
import { NativeSelect } from "./ui/native-select.js";

const withKeys = (rows: object[]) =>
  JSON.stringify(rows.map((r) => ({ ...r, rowKey: key() })));
const kindLabel = (kind: unknown) =>
  kind === "repository"
    ? "Repository"
    : kind === "project"
      ? "GitHub Project"
      : "Search";

export function SourceTab(p: TabProps) {
  const { data, projectId } = p,
    draftKey = `github.configure:${projectId}`,
    d = useDraft(p.drafts, draftKey);
  const loaded = sourceRowsFrom(data.source);
  const initial: Values = {
    expectedVersion: String(data.source.version),
    referenceMode: "preserve",
    credentialRef: "",
    selections: withKeys(loaded.selections),
    conditions: withKeys(loaded.conditions),
    mode: loaded.mode,
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
  const lines = sourceChanges(data.source, v),
    removesAll = removesAllAccess(data.source, v),
    blocked =
      loaded.incomplete || lines.length === 0 || (removesAll && !v.removeAll);
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
  const input = (field: string, index: number, name: string, label: string) => (
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
        value={String(parseRows(v[field])[index]?.[name] ?? "")}
        onChange={(e) => update(field, index, { [name]: e.target.value })}
      />
    </label>
  );
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
          sourceCommand(projectId, v),
          p.refreshConfiguration,
        )
      }
    >
      {loaded.incomplete && (
        <Alert variant="destructive" role="alert">
          A saved source or repository link cannot be shown here, so this form
          cannot keep it. Use the advanced source editor.
        </Alert>
      )}
      <div className="settings-split">
        <div className="settings-column">
          <Panel
            title="1 · Discovery sources"
            description="Private search queries and filters stay hidden; remove a source and add a new one to change it. New sources are added inactive."
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
                        <p className="metadata muted">
                          {r.kind === "search"
                            ? "Private query kept"
                            : r.kind === "project"
                              ? `${r.descriptor} · Filter kept · private`
                              : String(r.descriptor)}
                        </p>
                      </div>
                      <StatusBadge tone={r.removed ? "warning" : "neutral"}>
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
                  </div>
                ) : (
                  <div className="settings-row" key={String(r.rowKey)}>
                    <div className="settings-row-heading">
                      <h3 className="small-heading">{String(r.id)}</h3>
                      <StatusBadge>New · inactive</StatusBadge>
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
                          <p className="metadata muted">
                            Local path:{" "}
                            {r.replacePath ? "replacing" : "Kept · private"}
                          </p>
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
                          Remove repository {name}
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
                        {r.keep && (
                          <label
                            className="body check-field"
                            htmlFor={`replace-path-${i}`}
                          >
                            <Input
                              id={`replace-path-${i}`}
                              type="checkbox"
                              className="native-check size-5 shrink-0 p-0 accent-foreground"
                              checked={Boolean(r.replacePath)}
                              onChange={(e) =>
                                update("repositories", i, {
                                  replacePath: e.target.checked,
                                  path: "",
                                })
                              }
                            />
                            Replace path for {name}
                          </label>
                        )}
                        {(!r.keep || r.replacePath) &&
                          input(
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
            <ReferenceInput draft={d} />
          </Panel>
        </div>
        <div className="settings-column">
          <Panel
            title="2 · Readiness matching"
            description="Readiness admits work; it never grants repository access."
          >
            <fieldset
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
              {!data.source.readiness && (
                <p className="metadata muted">
                  Saved readiness is unavailable; saving replaces it with these
                  conditions.
                </p>
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
          </Panel>
          <ChangeList lines={lines}>
            {removesAll && (
              <>
                <Alert variant="destructive" role="alert">
                  Saving removes every linked repository from{" "}
                  {data.project.name ?? "this project"}. Confirm to save.
                </Alert>
                <DraftCheck
                  draft={d}
                  field="removeAll"
                  label="Remove all repository access"
                />
              </>
            )}
            <p className="metadata muted">
              Saving imports no tasks and activates nothing. Preview a new
              source in Sync & placement to activate it.
            </p>
          </ChangeList>
          <Aside
            title="Source boundary"
            items={[
              "Saving replaces configuration only. It imports no tasks, activates no selection and resumes no work.",
              "Activation is a separate preview step in Sync & placement.",
              "Private values stay hidden; replacing one is explicit.",
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
        onRecorded={p.refreshConfiguration}
      />
      {d.phase === "conflict" && (
        <Button
          type="button"
          variant="secondary"
          onClick={() => d.adoptVersion(data.source.version)}
        >
          Review latest source revision
        </Button>
      )}
      <SavedNotice
        saved={p.drafts.saved(draftKey)}
        label="Saved GitHub source"
      />
    </form>
  );
}
