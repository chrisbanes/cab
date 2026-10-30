import { projectPrivateValuesSchema } from "../../src/operator/contracts.js";
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
  type Values,
} from "./settings-changes.js";
import {
  Aside,
  ChangeList,
  DraftCheck,
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
import {
  useDropMatchedEdits,
  useSettingsRows,
  withKeys,
} from "./settings-rows.js";
import { Alert } from "./ui/alert.js";

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
  useDropMatchedEdits(
    d,
    "repositories",
    "path",
    (r) =>
      r.keep &&
      typeof r.path === "string" &&
      known?.links.find((x) => x.repositoryId === r.repositoryId)?.path ===
        r.path,
    known,
  );
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
  const edit = useSettingsRows({
    draft: d,
    priv,
    privateRead: privateData !== undefined,
    controlId: (_, index, name) => `repository-${index}-${name}`,
    errorId: () => "repository-error",
    rowName: "repositoryId",
    onRows: (next) => {
      if (next.some((r) => !r.removed)) d.set("removeAll", false);
    },
  });
  const savedPath = (index: number, baseline: string | undefined) =>
    edit.savedValue(
      "repositories",
      index,
      "path",
      "Local repository path",
      "Local path unavailable",
      baseline,
    );
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
                          onClick={() => edit.toggleRemoved("repositories", i)}
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
                          onClick={() => edit.drop("repositories", i)}
                        >
                          Remove new repository {name}
                        </Button>
                      </div>
                    )}
                    {!r.removed && (
                      <div className="settings-fields">
                        {!r.keep &&
                          edit.input(
                            "repositories",
                            i,
                            "repositoryId",
                            "Linked repository ID",
                          )}
                        {edit.input(
                          "repositories",
                          i,
                          "ref",
                          "Linked repository ref",
                        )}
                        {r.keep
                          ? savedPath(
                              i,
                              known?.links.find(
                                (x) => x.repositoryId === r.repositoryId,
                              )?.path,
                            )
                          : edit.input(
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
                    edit.add("repositories", {
                      repositoryId: "",
                      path: "",
                      ref: "main",
                    })
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
