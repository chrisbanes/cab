import { useCallback } from "react";
import {
  codeHostCredentialsSchema,
  discoveryBranchesSchema,
  gitLabProjectsSchema,
  projectPrivateValuesSchema,
} from "../../src/operator/contracts.js";
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
  ListedChoice,
  useDropMatchedEdits,
  useKeyedReads,
  useSettingsRows,
  withKeys,
} from "./settings-rows.js";
import { gitLabUnavailableCopy } from "./gitlab-setup.js";
import { useReadinessDiscovery } from "./readiness-picker.js";
import { discoveryReasonCopy } from "./setup-model.js";
import { Alert } from "./ui/alert.js";
import { NativeSelect } from "./ui/native-select.js";
import { codeHostName, type CodeHost } from "./delivery-presentation.js";
import { repositoryLabel } from "./presentation.js";
import { FolderPicker } from "./folder-picker.js";
import { useOperatorResource } from "./resource.js";

/** The project's repository links: the checkouts workspaces, delivery and setup use. */
export function RepositoryTab(p: TabProps) {
  const { data, projectId } = p,
    draftKey = `repositories.configure:${projectId}`,
    d = useDraft(p.drafts, draftKey, p.readOnly);
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
  const fresh = repositories.filter((r) => !r.keep && !r.removed);
  // GitHub repositories are listed only while a new GitHub row needs one.
  const discovered = useReadinessDiscovery({
      client: p.client,
      csrfToken: p.session.csrfToken,
      enabled: false,
      labels: false,
      repositories: fresh.some((r) => r.codeHost !== "gitlab"),
      saved: [],
      projectIds: [],
    }).repositories,
    listed = discovered?.state === "ready" ? discovered : null;
  const chosenOf = (r: (typeof repositories)[number]) =>
    r.codeHost === "gitlab"
      ? undefined
      : listed?.repositories.find((x) => x.repositoryId === r.repositoryId);
  const branchReads = useKeyedReads(
    p.client,
    fresh.flatMap((r) => {
      const x = chosenOf(r);
      return x ? [`${x.owner}/${x.name}`] : [];
    }),
    (repo) =>
      `/api/operator/discovery/branches?repository=${encodeURIComponent(repo)}`,
    discoveryBranchesSchema,
  );
  // GitLab rows choose among the hosts with a configured credential, then that host's projects.
  const hosts = useOperatorResource(
    fresh.some((r) => r.codeHost === "gitlab") ? p.session.csrfToken : null,
    useCallback(
      (signal: AbortSignal) =>
        p.client.read(
          "/api/operator/code-host-credentials",
          codeHostCredentialsSchema,
          signal,
        ),
      [p.client],
    ),
  );
  const gitlabHosts =
    hosts.state.data?.data.credentials.map((c) => c.host) ?? [];
  const gitlabProjectReads = useKeyedReads(
    p.client,
    [
      ...new Set(
        fresh.flatMap((r) =>
          // Only a configured host is read, never text as it is typed.
          r.codeHost === "gitlab" && gitlabHosts.includes(String(r.host))
            ? [String(r.host)]
            : [],
        ),
      ),
    ],
    (host) =>
      `/api/operator/discovery/gitlab-projects?host=${encodeURIComponent(host)}`,
    gitLabProjectsSchema,
  );
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
  /** A new row's identity fields differ by host, so a switch starts them over. */
  const setCodeHost = (index: number, gitlab: boolean) => {
    const next = parseRows(v.repositories);
    const {
      codeHost: _c,
      host: _h,
      projectPath: _p,
      ...rest
    } = next[index] ?? {};
    next[index] = {
      ...rest,
      repositoryId: "",
      ...(gitlab ? { codeHost: "gitlab", host: "", projectPath: "" } : {}),
    };
    edit.setRows("repositories", next);
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
                const name = r.unavailable
                  ? `Unavailable saved repository link ${i + 1}`
                  : r.keep
                    ? repositoryLabel(
                        String(r.repositoryId),
                        data.repositories.links,
                      )
                    : String(r.repositoryId || `row ${i + 1}`);
                const chosen = chosenOf(r);
                // Branches are listed for a new row's chosen GitHub repository, as in setup.
                const branches =
                  !r.keep && chosen
                    ? branchReads[`${chosen.owner}/${chosen.name}`]
                    : undefined;
                const gitlabProjects =
                  !r.keep &&
                  r.codeHost === "gitlab" &&
                  gitlabHosts.includes(String(r.host))
                    ? gitlabProjectReads[String(r.host)]
                    : undefined;
                const readyProjects =
                  gitlabProjects?.state === "ready"
                    ? gitlabProjects.projects
                    : null;
                const invalid = (field: string) =>
                  Boolean(edit.rowError("repositories", i, field));
                return (
                  <div className="settings-row" key={String(r.rowKey)}>
                    {r.keep ? (
                      <div className="settings-row-heading">
                        <div>
                          <h3 className="small-heading">{name}</h3>
                          <p className="metadata muted">
                            {r.unavailable ? (
                              "Kept unless you remove it."
                            ) : (
                              <>
                                {codeHostName(r.codeHost as CodeHost)} ·{" "}
                                {r.host}
                              </>
                            )}
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
                    {!r.removed && !r.unavailable && (
                      <div className="settings-fields">
                        {!r.keep && (
                          <>
                            <label
                              className="field body"
                              htmlFor={`repository-${i}-codeHost`}
                            >
                              Code host
                              <NativeSelect
                                className="control"
                                id={`repository-${i}-codeHost`}
                                aria-label="Code host"
                                value={
                                  r.codeHost === "gitlab" ? "gitlab" : "github"
                                }
                                onChange={(e) =>
                                  setCodeHost(i, e.target.value === "gitlab")
                                }
                              >
                                <option value="github">GitHub</option>
                                <option value="gitlab">GitLab</option>
                              </NativeSelect>
                            </label>
                            {r.codeHost === "gitlab" ? (
                              <>
                                <ListedChoice
                                  id={`repository-${i}-hostChoice`}
                                  label="GitLab host"
                                  empty="Choose a host"
                                  value={String(r.host ?? "")}
                                  options={
                                    gitlabHosts.length ? gitlabHosts : null
                                  }
                                  onChoose={(host) =>
                                    edit.update("repositories", i, {
                                      host,
                                      repositoryId: "",
                                      projectPath: "",
                                    })
                                  }
                                  typed={edit.input(
                                    "repositories",
                                    i,
                                    "host",
                                    gitlabHosts.length
                                      ? "Other GitLab host"
                                      : "GitLab host",
                                  )}
                                />
                                <ListedChoice
                                  id={`repository-${i}-projectChoice`}
                                  label="GitLab project"
                                  empty="Choose a project"
                                  value={String(r.repositoryId ?? "")}
                                  options={
                                    readyProjects?.map((x) => ({
                                      value: x.repositoryId,
                                      label: x.projectPath,
                                    })) ?? null
                                  }
                                  note={
                                    // A failed read is unreadable, as setup reports it.
                                    gitlabProjects === null ||
                                    gitlabProjects?.state === "unavailable"
                                      ? gitLabUnavailableCopy(
                                          gitlabProjects?.reason ??
                                            "unreadable",
                                        )
                                      : undefined
                                  }
                                  invalid={invalid("repositoryId")}
                                  onChoose={(id) => {
                                    const x = readyProjects?.find(
                                      (x) => x.repositoryId === id,
                                    );
                                    edit.update("repositories", i, {
                                      repositoryId: id,
                                      projectPath: x?.projectPath ?? "",
                                      ...(x ? { ref: x.defaultBranch } : {}),
                                    });
                                  }}
                                  typed={
                                    <>
                                      {edit.input(
                                        "repositories",
                                        i,
                                        "projectPath",
                                        "GitLab project path",
                                      )}
                                      {edit.input(
                                        "repositories",
                                        i,
                                        "repositoryId",
                                        "GitLab project ID",
                                      )}
                                    </>
                                  }
                                />
                              </>
                            ) : (
                              <ListedChoice
                                id={`repository-${i}-repositoryChoice`}
                                label="Repository"
                                empty="Choose a repository"
                                value={String(r.repositoryId ?? "")}
                                options={
                                  listed?.repositories.map((x) => ({
                                    value: x.repositoryId,
                                    label: `${x.owner}/${x.name}`,
                                  })) ?? null
                                }
                                note={
                                  discovered?.state === "unavailable"
                                    ? `${
                                        // Setup's unconfigured copy asks for owner/name; this field takes the node ID.
                                        discovered.reason === "unconfigured"
                                          ? "GitHub discovery is unavailable: no discovery credential is configured."
                                          : discoveryReasonCopy(
                                              discovered.reason,
                                            )
                                      } Enter the repository's node ID.`
                                    : undefined
                                }
                                invalid={invalid("repositoryId")}
                                onChoose={(id) => {
                                  const x = listed?.repositories.find(
                                    (x) => x.repositoryId === id,
                                  );
                                  edit.update("repositories", i, {
                                    repositoryId: id,
                                    ...(x ? { ref: x.defaultBranch } : {}),
                                  });
                                }}
                                typed={edit.input(
                                  "repositories",
                                  i,
                                  "repositoryId",
                                  "Linked repository ID",
                                )}
                              />
                            )}
                          </>
                        )}
                        <ListedChoice
                          id={`repository-${i}-refChoice`}
                          label="Ref"
                          empty="Choose a branch"
                          value={String(r.ref ?? "")}
                          options={
                            branches?.state === "ready"
                              ? branches.branches
                              : null
                          }
                          invalid={invalid("ref")}
                          onChoose={(ref) =>
                            edit.update("repositories", i, { ref })
                          }
                          typed={edit.input(
                            "repositories",
                            i,
                            "ref",
                            "Linked repository ref",
                          )}
                        />
                        {r.keep
                          ? edit.savedValue(
                              "repositories",
                              i,
                              "path",
                              "Local repository path",
                              "Local path unavailable",
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
                        {!r.keep && (
                          <div>
                            <FolderPicker
                              client={p.client}
                              csrfToken={p.session.csrfToken}
                              path={String(r.path ?? "")}
                              disabled={isLocked}
                              expected={
                                chosen
                                  ? {
                                      owner: chosen.owner,
                                      name: chosen.name,
                                      ref: String(r.ref ?? ""),
                                    }
                                  : null
                              }
                              onUse={(path) =>
                                edit.update("repositories", i, { path })
                              }
                              trigger={
                                <Button type="button" variant="secondary">
                                  Choose folder…
                                </Button>
                              }
                            />
                          </div>
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
                  {Object.values(d.errors).find((e) =>
                    /^Repository \d+: /.test(e),
                  ) ?? "Check linked repository IDs, paths and refs."}
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
              "Repository links are project configuration: workspaces, delivery and setup read them. Links are GitHub on github.com or GitLab on a host you name.",
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
