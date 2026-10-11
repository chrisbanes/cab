import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import {
  type CheckoutVerification,
  discoveryBranchesSchema,
  discoveryProjectsSchema,
  discoveryRepositoriesSchema,
} from "../../src/operator/contracts.js";
import type { z } from "zod";
import { ActionLink, Button } from "./components.js";
import { FolderPicker } from "./folder-picker.js";
import {
  DraftField,
  DraftOutcome,
  key,
  locked,
  type SettingsProps,
  submitDraft,
  useDraft,
} from "./settings.js";
import {
  blankRow,
  buildProjectCreate,
  discoveryReasonCopy,
  duplicateRows,
  emptyRow,
  rowsFromDraft,
  rowsToDraft,
  type SetupRow,
  typeRepository,
  verificationCopy,
} from "./setup-model.js";
import { Alert } from "./ui/alert.js";
import { Input } from "./ui/input.js";
import { NativeSelect } from "./ui/native-select.js";
import "./setup.css";

type Read<T extends z.ZodType> =
  z.infer<T> extends { data: infer D } ? D : never;
type Discovery =
  | Read<typeof discoveryRepositoriesSchema>
  | { state: "loading" };
type Branches = Read<typeof discoveryBranchesSchema> | { state: "loading" };
type Projects = Read<typeof discoveryProjectsSchema> | { state: "loading" };
/** Repository select value that switches a row to typed entry. */
const typeOption = "\u0000type";
type Verification =
  | { state: "checking" }
  | CheckoutVerification["data"]
  | { state: "failed" };

const blank = () => ({
  name: "",
  leadProfileId: "",
  instructions: "",
  rows: rowsToDraft([emptyRow("discovered")]),
  githubProject: "",
  projectId: key(),
  key: key(),
});
const repoOf = (r: SetupRow) =>
  r.owner && r.name ? `${r.owner}/${r.name}` : "";
/** What a verification result was computed for; stale results are not shown. */
const verificationKey = (r: SetupRow) => `${r.path}\n${repoOf(r)}\n${r.ref}`;

/** Frames 115–117b: guided setup recorded by one `project.create`. */
export function ProjectSetup(p: SettingsProps) {
  const d = useDraft(p.drafts, "project.create");
  useEffect(() => d.initialize(blank()), [d]);
  const csrf = p.session.csrfToken;
  const rows = rowsFromDraft(d.values.rows);
  const setRows = (next: SetupRow[]) => d.set("rows", rowsToDraft(next));
  const disabled = locked(d);
  const [attempt, setAttempt] = useState(0);
  const attemptRef = useRef(attempt);
  attemptRef.current = attempt;
  const [discovery, setDiscovery] = useState<Discovery>({ state: "loading" });
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-read when the session (CSRF token) or Retry changes.
  useEffect(() => {
    void attempt;
    let live = true;
    setDiscovery({ state: "loading" });
    p.client
      .read("/api/operator/discovery/repositories", discoveryRepositoriesSchema)
      .then(
        (r) => live && setDiscovery(r.data),
        () =>
          live && setDiscovery({ state: "unavailable", reason: "unreadable" }),
      );
    return () => {
      live = false;
    };
  }, [p.client, csrf, attempt]);
  const ready = discovery.state === "ready" ? discovery : null;
  // A row with nothing chosen follows the current discovery state.
  const mode: SetupRow["source"] =
    discovery.state === "unavailable" ? "typed" : "discovered";
  // A row the operator switched to typed entry stays typed.
  const sourceOf = (r: SetupRow): SetupRow["source"] =>
    r.source === "typed" ? "typed" : r.repositoryId ? "discovered" : mode;

  // Branch lists per discovered repository; nothing is stored.
  const [branches, setBranches] = useState<Record<string, Branches>>({});
  const requested = useRef(new Set<string>());
  const discoveredRepos = rows
    .filter((r) => r.source === "discovered" && repoOf(r))
    .map(repoOf);
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed by the joined repository list; each repository is requested once.
  useEffect(() => {
    const round = attempt;
    for (const repo of discoveredRepos) {
      if (requested.current.has(repo)) continue;
      requested.current.add(repo);
      setBranches((b) => ({ ...b, [repo]: { state: "loading" } }));
      p.client
        .read(
          `/api/operator/discovery/branches?repository=${encodeURIComponent(repo)}`,
          discoveryBranchesSchema,
        )
        .then(
          // A response from before a Retry never overwrites the new round.
          (r) =>
            round === attemptRef.current &&
            setBranches((b) => ({ ...b, [repo]: r.data })),
          () =>
            round === attemptRef.current &&
            setBranches((b) => ({
              ...b,
              [repo]: { state: "unavailable", reason: "unreadable" },
            })),
        );
    }
  }, [discoveredRepos.join("\n"), p.client, attempt]);

  // GitHub Projects for the first discovered repository.
  const projectRepo =
    rows.find((r) => r.source === "discovered" && repoOf(r)) ?? null;
  const projectKey = projectRepo ? repoOf(projectRepo) : "";
  const [projects, setProjects] = useState<{ repo: string; data: Projects }>({
    repo: "",
    data: { state: "loading" },
  });
  const chosenProject = String(d.values.githubProject ?? "");
  const projectChoiceTouched = useRef("");
  // A Project choice belongs to the repository it was listed for: a new one starts at None.
  const listedFor = useRef(projectKey);
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset only when the Project repository changes.
  useEffect(() => {
    if (listedFor.current === projectKey || locked(d)) return;
    listedFor.current = projectKey;
    projectChoiceTouched.current = "";
    d.set("githubProject", "");
  }, [projectKey]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-read when the repository or session changes.
  useEffect(() => {
    if (!projectKey) return;
    let live = true;
    setProjects({ repo: projectKey, data: { state: "loading" } });
    p.client
      .read(
        `/api/operator/discovery/projects?repository=${encodeURIComponent(projectKey)}`,
        discoveryProjectsSchema,
      )
      .then(
        (r) => live && setProjects({ repo: projectKey, data: r.data }),
        () =>
          live &&
          setProjects({
            repo: projectKey,
            data: { state: "unavailable", reason: "unreadable" },
          }),
      );
    return () => {
      live = false;
    };
  }, [projectKey, p.client, csrf, attempt]);
  const projectList =
    projects.repo === projectKey && projects.data.state === "ready"
      ? projects.data
      : null;
  // Frame 117: exactly one linked Project is preselected until the operator chooses.
  // biome-ignore lint/correctness/useExhaustiveDependencies: preselect only when a Project list lands or the repository changes.
  useEffect(() => {
    if (
      projectList &&
      projectList.linked.length === 1 &&
      !chosenProject &&
      projectChoiceTouched.current !== projectKey &&
      !locked(d)
    )
      d.set("githubProject", projectList.linked[0]?.projectNodeId ?? "");
  }, [projectList, projectKey]);

  // Advisory checkout verification; the service verifies again on create.
  const [verifications, setVerifications] = useState<
    Record<string, { key: string; result: Verification }>
  >({});
  const verify = (row: SetupRow) => {
    if (!row.path.trim() || !row.owner || !row.name || !row.ref.trim()) return;
    const k = verificationKey(row);
    setVerifications((v) => ({
      ...v,
      [row.id]: { key: k, result: { state: "checking" } },
    }));
    p.client
      .verifyCheckout(
        {
          path: row.path.trim(),
          repository: { owner: row.owner, name: row.name },
          ref: row.ref.trim(),
        },
        csrf,
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

  /** A typed row naming a listed repository takes its node ID; a blank typed row rejoins the list. */
  const adoptListed = (r: SetupRow): SetupRow => {
    if (!ready || r.source !== "typed") return r;
    if (blankRow(r)) return { ...r, source: "discovered" };
    const match = r.owner
      ? ready.repositories.find(
          (x) =>
            `${x.owner}/${x.name}`.toLowerCase() === repoOf(r).toLowerCase(),
        )
      : undefined;
    return match
      ? {
          ...r,
          source: "discovered",
          text: "",
          repositoryId: match.repositoryId,
          owner: match.owner,
          name: match.name,
          // An empty typed ref takes the listed default branch the Ref list shows.
          ref: r.ref.trim() ? r.ref : match.defaultBranch,
        }
      : r;
  };
  // Once discovery recovers, typed rows are adopted as above.
  // biome-ignore lint/correctness/useExhaustiveDependencies: adopt only when a repository list lands.
  useEffect(() => {
    if (!ready || locked(d)) return;
    const next = rows.map(adoptListed);
    if (next.every((r, i) => r === rows[i])) return;
    setRows(next);
    next.forEach((row, i) => {
      if (row !== rows[i] && repoOf(row)) verify(row);
    });
  }, [ready]);
  const values = {
    key: String(d.values.key ?? ""),
    projectId: String(d.values.projectId ?? ""),
    name: String(d.values.name ?? ""),
    leadProfileId: String(d.values.leadProfileId ?? ""),
    instructions: String(d.values.instructions ?? ""),
  };
  // A Project can only be linked alongside a discovered repository.
  // Submitting with Enter skips the field's blur, so listed typed rows are adopted here too.
  const { command, rowIndex } = buildProjectCreate(
    values,
    rows.map(adoptListed),
    projectKey ? chosenProject : "",
  );
  const fieldError = (i: number, ...fields: string[]) => {
    const k = rowIndex.indexOf(i);
    return k >= 0 && fields.some((f) => d.errors[`repositories.${k}.${f}`]);
  };
  const duplicates = duplicateRows(rows);
  const rejectedFields =
    d.phase === "rejected" && Object.keys(d.errors).length > 0;
  const update = (i: number, row: SetupRow) => {
    // Editing a row retires the service's error for it; the next create checks again.
    const k = rowIndex.indexOf(i);
    // A row becoming blank or filled shifts the indices of the rows after it.
    if (blankRow(rows[i] ?? row) !== blankRow(row))
      d.clearErrors("repositories.");
    else if (k >= 0) d.clearErrors(`repositories.${k}.`);
    setRows(rows.map((r, j) => (j === i ? row : r)));
  };
  const recorded = d.phase === "recorded" ? d.frozen : null;
  const profiles = p.workspace?.data.profiles.filter((r) => !r.revoked) ?? [];
  const firstRun = p.workspace?.data.projects.length === 0;

  return (
    <section className="settings-page setup-page">
      {rejectedFields && (
        <Alert variant="destructive" role="alert" className="setup-alert">
          <strong>Project not created</strong>
          <p>Fix the highlighted field. Every other value is kept.</p>
        </Alert>
      )}
      <form
        className="setup-grid"
        onSubmit={(e) =>
          void submitDraft(e, d, p.client, p.session, command, p.refresh)
        }
      >
        <div className="settings-column">
          <section className="settings-panel">
            <h2 className="settings-panel-title">1 · Project and lead</h2>
            <div className="settings-fields">
              <DraftField draft={d} field="name" label="Project name" />
              <div className="setup-field-stack">
                <DraftField
                  draft={d}
                  field="leadProfileId"
                  label="Lead profile"
                >
                  <option value="">Unconfigured</option>
                  {profiles.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name ?? "Name unavailable"}
                    </option>
                  ))}
                </DraftField>
                {profiles.length === 0 && (
                  <p className="metadata muted">
                    No lead profiles yet. Leave the lead unconfigured or create
                    one; tasks wait for a lead before starting.
                  </p>
                )}
              </div>
            </div>
            {profiles.length === 0 && (
              <div>
                <ActionLink
                  variant="secondary"
                  href="/app/settings/profiles/new"
                >
                  Create a lead profile
                </ActionLink>
              </div>
            )}
          </section>
          <section className="settings-panel">
            <div>
              <h2 className="settings-panel-title">2 · Instructions</h2>
              <p className="metadata muted">
                Private project instructions. Assignments capture them when they
                start.
              </p>
            </div>
            <DraftField
              draft={d}
              field="instructions"
              label="Instructions"
              multiline
            />
          </section>
          <section className="setup-explainer" aria-label="What creation does">
            <h2 className="body">What creation does</h2>
            <ul className="body">
              <li>
                The project starts Paused. Creating it starts no execution.
              </li>
              <li>Resume is a separate decision in project configuration.</li>
              <li>
                Routing, GitHub discovery, credential references and capacity
                overrides are configured after creation.
              </li>
              <li>Repository access is exactly the list in step 3.</li>
              <li>
                Discovery reads GitHub only. Nothing is imported until a source
                is previewed and activated.
              </li>
            </ul>
          </section>
          <div className="settings-actions setup-submit">
            <DraftOutcome
              draft={d}
              client={p.client}
              session={p.session}
              label="Create paused project"
              onRecorded={p.refresh}
            />
            {!recorded && (
              <ActionLink
                variant="secondary"
                href={firstRun ? "/app" : "/app/settings"}
              >
                Cancel
              </ActionLink>
            )}
          </div>
        </div>
        <section className="settings-panel setup-repositories">
          <div>
            <h2 className="settings-panel-title">
              3 · Repository and GitHub · optional
            </h2>
            <p className="metadata muted">
              {discovery.state === "unavailable"
                ? discoveryReasonCopy(discovery.reason)
                : "Repositories and GitHub Projects are discovered from GitHub with the read-only discovery credential. Repository access is exactly what you add here; a linked GitHub Project grants none."}
            </p>
          </div>
          {(discovery.state === "unavailable" ||
            discoveredRepos.some(
              (repo) => branches[repo]?.state === "unavailable",
            ) ||
            (projects.repo === projectKey &&
              projects.data.state === "unavailable")) && (
            <div className="setup-inline-actions">
              {discovery.state === "unavailable" &&
              (discovery.reason === "unconfigured" ||
                discovery.reason === "missing-credential") ? (
                <ActionLink variant="secondary" href="/app/settings">
                  Set discovery credential
                </ActionLink>
              ) : (
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => {
                    requested.current.clear();
                    setBranches({});
                    setAttempt((n) => n + 1);
                  }}
                >
                  Retry
                </Button>
              )}
            </div>
          )}
          {rows.map((row, i) => {
            const source = sourceOf(row);
            const expected = row.owner && row.name ? row : null;
            const v =
              verifications[row.id]?.key === verificationKey(row)
                ? verifications[row.id]?.result
                : undefined;
            const pathRejected = fieldError(i, "path");
            const pathCopy = pathRejected
              ? v && v.state === "rejected" && expected
                ? verificationCopy(v, expected)
                : v?.state === "verified"
                  ? "This folder no longer matches. Choose it again."
                  : "Check this field."
              : v?.state === "rejected" && expected
                ? verificationCopy(v, expected)
                : null;
            const pathInvalid =
              pathRejected || (v?.state === "rejected" && Boolean(expected));
            const repoError = duplicates.has(row.id)
              ? "This repository is already in the list."
              : fieldError(i, "owner", "name", "repositoryId")
                ? source === "typed"
                  ? "Enter the repository as owner/name."
                  : "Choose a repository."
                : null;
            const b = branches[repoOf(row)];
            const branchList = b?.state === "ready" ? b : null;
            const chosen =
              ready?.repositories.find(
                (r) => r.repositoryId === row.repositoryId,
              ) ?? null;
            return (
              <fieldset
                key={row.id}
                className="setup-row"
                aria-label={`Repository row ${i + 1}`}
              >
                <div className="settings-fields">
                  {source === "discovered" ? (
                    <SetupField
                      label="Repository"
                      error={repoError}
                      caption={
                        ready
                          ? ready.truncated
                            ? `Discovered from GitHub · the first ${ready.repositories.length} repositories visible to the credential. Choose "Type a repository" for one not listed.`
                            : `Discovered from GitHub · ${ready.repositories.length} repositories visible to the credential`
                          : discovery.state === "unavailable"
                            ? "Chosen from GitHub earlier · discovery is unavailable now"
                            : "Loading repositories from GitHub…"
                      }
                    >
                      {(props) => (
                        <NativeSelect
                          {...props}
                          disabled={disabled || discovery.state === "loading"}
                          value={row.repositoryId}
                          onChange={(e) => {
                            if (e.target.value === typeOption) {
                              update(i, { ...emptyRow("typed"), id: row.id });
                              return;
                            }
                            const r = ready?.repositories.find(
                              (x) => x.repositoryId === e.target.value,
                            );
                            update(i, {
                              ...row,
                              source: "discovered",
                              text: "",
                              repositoryId: r?.repositoryId ?? "",
                              owner: r?.owner ?? "",
                              name: r?.name ?? "",
                              ref: r?.defaultBranch ?? "",
                            });
                          }}
                        >
                          <option value="">
                            {i === 0
                              ? "No repository · repository-free"
                              : "Choose a repository"}
                          </option>
                          {ready?.repositories.map((r) => (
                            <option key={r.repositoryId} value={r.repositoryId}>
                              {r.owner}/{r.name}
                            </option>
                          ))}
                          {!chosen && row.repositoryId && (
                            <option value={row.repositoryId}>
                              {repoOf(row)}
                            </option>
                          )}
                          {(!ready || ready.truncated) && (
                            <option value={typeOption}>
                              Type a repository not listed…
                            </option>
                          )}
                        </NativeSelect>
                      )}
                    </SetupField>
                  ) : (
                    <SetupField
                      label="Repository (owner/name)"
                      error={repoError}
                      caption="Typed · not listed from GitHub"
                    >
                      {(props) => (
                        <Input
                          {...props}
                          disabled={disabled}
                          value={row.text}
                          onChange={(e) =>
                            update(i, {
                              ...typeRepository(row, e.target.value),
                              source: "typed",
                            })
                          }
                          // On leaving the field, a listed repository is recorded with its node ID.
                          onBlur={() => {
                            const listed = adoptListed(row);
                            if (listed !== row && listed.repositoryId) {
                              update(i, listed);
                              verify(listed);
                            }
                          }}
                        />
                      )}
                    </SetupField>
                  )}
                  {(source === "typed" || expected) && (
                    <SetupField
                      label="Ref"
                      error={
                        fieldError(i, "ref")
                          ? v?.state === "rejected" && expected
                            ? verificationCopy(v, expected)
                            : "Check this field."
                          : null
                      }
                      caption={
                        source === "discovered" && b?.state === "unavailable"
                          ? `${discoveryReasonCopy(b.reason)} Type the ref; it is checked in the local checkout.`
                          : source === "typed" || !branchList
                            ? "Typed · checked in the local checkout"
                            : branchList.truncated
                              ? "More branches than listed · type the ref; it is checked in the local checkout"
                              : "Discovered refs · default branch preselected"
                      }
                    >
                      {(props) =>
                        // Past the listing cap a ref is typed, starting from the default branch.
                        source === "discovered" &&
                        branchList &&
                        !branchList.truncated ? (
                          <NativeSelect
                            {...props}
                            disabled={disabled}
                            value={row.ref}
                            onChange={(e) =>
                              update(i, { ...row, ref: e.target.value })
                            }
                          >
                            {[
                              ...new Set([
                                chosen?.defaultBranch ?? row.ref,
                                // A typed or adopted ref outside the listed branches stays visible.
                                row.ref,
                                ...branchList.branches,
                              ]),
                            ]
                              .filter(Boolean)
                              .map((n) => (
                                <option key={n} value={n}>
                                  {n === chosen?.defaultBranch
                                    ? `${n} · default branch`
                                    : n}
                                </option>
                              ))}
                          </NativeSelect>
                        ) : (
                          <Input
                            {...props}
                            disabled={disabled}
                            value={row.ref}
                            onChange={(e) =>
                              update(i, { ...row, ref: e.target.value })
                            }
                          />
                        )
                      }
                    </SetupField>
                  )}
                </div>
                {(source === "typed" || expected) && (
                  <div className="setup-path">
                    <SetupField
                      label="Local repository path"
                      error={pathInvalid ? pathCopy : null}
                      caption={
                        v?.state === "verified" && expected && !pathRejected
                          ? verificationCopy(v, expected)
                          : v?.state === "checking"
                            ? "Checking on this Mac…"
                            : v?.state === "failed"
                              ? "This folder couldn't be checked now. The service checks again on create."
                              : "The service checks the checkout's origin and ref on this Mac."
                      }
                    >
                      {(props) => (
                        <Input
                          {...props}
                          disabled={disabled}
                          value={row.path}
                          placeholder="~/src/repository"
                          onChange={(e) =>
                            update(i, { ...row, path: e.target.value })
                          }
                          onBlur={() => verify(row)}
                        />
                      )}
                    </SetupField>
                    <FolderPicker
                      client={p.client}
                      csrfToken={csrf}
                      path={row.path}
                      disabled={disabled}
                      expected={
                        expected
                          ? { owner: row.owner, name: row.name, ref: row.ref }
                          : null
                      }
                      onUse={(path) => {
                        const next = { ...row, path };
                        update(i, next);
                        verify(next);
                      }}
                      trigger={
                        <Button type="button" variant="secondary">
                          Choose folder…
                        </Button>
                      }
                    />
                  </div>
                )}
                {i > 0 && (
                  <div>
                    <Button
                      type="button"
                      variant="secondary"
                      disabled={disabled}
                      onClick={() => {
                        // Row indices shift, so the service's row errors no longer apply.
                        d.clearErrors("repositories.");
                        setRows(rows.filter((_, j) => j !== i));
                      }}
                    >
                      Remove repository {i + 1}
                    </Button>
                  </div>
                )}
              </fieldset>
            );
          })}
          <ProjectChoice
            disabled={disabled}
            discoveryReady={Boolean(ready)}
            repo={projectKey}
            data={
              projectKey
                ? projects.repo === projectKey
                  ? projects.data
                  : { state: "loading" }
                : null
            }
            value={chosenProject}
            onChange={(id) => {
              projectChoiceTouched.current = projectKey;
              d.set("githubProject", id);
            }}
          />
          {rows.length >= 20 && (
            <p className="metadata muted">
              A project can have up to 20 repositories.
            </p>
          )}
          {!blankRow(rows[0] ?? emptyRow("typed")) && rows.length < 20 && (
            <div>
              <Button
                type="button"
                variant="secondary"
                disabled={disabled}
                onClick={() => setRows([...rows, emptyRow(mode)])}
              >
                Add another repository
              </Button>
            </div>
          )}
        </section>
      </form>
      {recorded?.type === "project.create" && (
        <Alert role="status" className="setup-recorded">
          <strong>Recorded {recorded.name} as a paused project.</strong>
          <ul className="body">
            <li>
              {recorded.instructions
                ? "Instructions saved as revision 1."
                : "No instructions yet."}
            </li>
            <li>
              Repository access:{" "}
              {recorded.repositories?.length
                ? recorded.repositories
                    .map((r) => `${r.owner}/${r.name} (${r.ref})`)
                    .join(", ")
                : "none · repository-free"}
              .
            </li>
            {recorded.githubProject && (
              <li>GitHub Project linked as an inactive discovery source.</li>
            )}
          </ul>
          <div className="setup-inline-actions">
            <ActionLink href={`/app/projects/${recorded.projectId}/settings`}>
              Open project configuration
            </ActionLink>
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                setVerifications({});
                projectChoiceTouched.current = "";
                d.startOperation(blank());
              }}
            >
              Create another project
            </Button>
          </div>
        </Alert>
      )}
    </section>
  );
}

/** A labelled control with a caption, or an error that replaces it. */
function SetupField({
  label,
  error,
  caption,
  children,
}: {
  label: string;
  error: string | null;
  caption?: ReactNode;
  children: (props: {
    id: string;
    "aria-label": string;
    className: string;
    "aria-invalid": boolean;
    "aria-describedby": string;
  }) => ReactNode;
}) {
  const id = useId();
  return (
    <div className="setup-field-stack">
      <label className="field body" htmlFor={id}>
        {label}
        {children({
          id,
          "aria-label": label,
          className: "control",
          "aria-invalid": Boolean(error),
          "aria-describedby": `${id}-note`,
        })}
      </label>
      <p
        id={`${id}-note`}
        className={error ? "error-text metadata" : "metadata muted"}
      >
        {error ?? caption}
      </p>
    </div>
  );
}

function ProjectChoice({
  disabled,
  discoveryReady,
  repo,
  data,
  value,
  onChange,
}: {
  disabled: boolean;
  discoveryReady: boolean;
  repo: string;
  data: Projects | null;
  value: string;
  onChange: (id: string) => void;
}) {
  const list = data?.state === "ready" ? data : null;
  const caption = !discoveryReady
    ? "GitHub Projects can't be listed without discovery. Set the discovery credential in Settings, then link a Project in project configuration."
    : !repo
      ? "Choose a repository to list its GitHub Projects."
      : !data || data.state === "loading"
        ? "Loading GitHub Projects…"
        : data.state === "unavailable"
          ? `${discoveryReasonCopy(data.reason)} Link a Project later in project configuration.`
          : data.linked.length === 1 && value === data.linked[0]?.projectNodeId
            ? `Found automatically: 1 GitHub Project linked to ${repo}. Linking adds an inactive discovery source; preview and readiness follow in project configuration.`
            : `${data.linked.length} GitHub Project${data.linked.length === 1 ? "" : "s"} linked to ${repo}${data.linked.length ? `: ${data.linked.map((x) => x.title).join(", ")}` : ""} · ${data.owned.length} more owned by ${data.ownerLogin}. Linking one adds an inactive discovery source; preview and readiness follow in project configuration.`;
  const shown =
    list?.truncated && discoveryReady
      ? `${caption} Only the first 100 Projects are listed; link another in project configuration.`
      : caption;
  return (
    <SetupField label="GitHub Project" error={null} caption={shown}>
      {(props) => (
        <NativeSelect
          {...props}
          disabled={disabled || !list}
          value={list ? value : ""}
          onChange={(e) => onChange(e.target.value)}
        >
          <option value="">
            {discoveryReady ? "None" : "Unavailable without discovery"}
          </option>
          {list?.linked.map((x) => (
            <option key={x.projectNodeId} value={x.projectNodeId}>
              {x.title} · linked to {repo}
            </option>
          ))}
          {list?.owned.map((x) => (
            <option key={x.projectNodeId} value={x.projectNodeId}>
              {x.title} · owned by {list.ownerLogin}
            </option>
          ))}
        </NativeSelect>
      )}
    </SetupField>
  );
}
