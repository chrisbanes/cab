import {
  type FocusEvent,
  type FormEvent,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { flushSync } from "react-dom";
import {
  type CheckoutVerification,
  type DiscoveryUnavailableReason,
  discoveryBranchesSchema,
  discoveryProjectsSchema,
  discoveryRepositoriesSchema,
  discoveryStatusSchema,
} from "../../src/operator/contracts.js";
import type { z } from "zod";
import { ActionLink, Button } from "./components.js";
import { runtimeErrors } from "./execution-runtime.js";
import { FolderPicker } from "./folder-picker.js";
import { ReadyCheck } from "./ready-check.js";
import {
  harnessSettings,
  emptyProfile,
  profileCreateCommand,
  RuntimeFields,
} from "./profile-config.js";
import {
  DraftField,
  DraftMessage,
  key,
  locked,
  sendDraft,
  type SettingsProps,
  useDraft,
} from "./settings.js";
import {
  blankRow,
  buildProjectCreate,
  createHold,
  discoveryReasonCopy,
  duplicateRows,
  emptyRow,
  listedProject,
  rowsFromDraft,
  rowsToDraft,
  type SetupRow,
  setupSourceCredentialCopy,
  typeRepository,
  verificationCopy,
} from "./setup-model.js";
import { discoveryUseNote, type GhLogin } from "./discovery-credential.js";
import { settingsSectionHref } from "./settings-sections.js";
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

/** What the page header needs from setup: the heading is latched for the visit. */
export type SetupHeader = { firstRun: boolean; created: boolean };

/** Guided setup recorded by one `project.create`. */
export function ProjectSetup(
  p: SettingsProps & {
    navigate: (href: string) => void;
    onHeader?: (header: SetupHeader | null) => void;
  },
) {
  const d = useDraft(p.drafts, "project.create");
  // The lead profile created inline when none exists; its own draft never meets Settings'.
  const inline = useDraft(p.drafts, "profile.create:setup");
  // A create already recorded on arrival belongs to the earlier visit: this one starts
  // clean, without showing its ready check. Unsaved input from an earlier visit is kept.
  const earlier = useRef(d.phase === "recorded");
  // Before paint, so the earlier visit's values never show.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the draft starts once, from the workspace already loaded on arrival.
  useLayoutEffect(() => {
    if (d.phase === "recorded") {
      earlier.current = false;
      d.startOperation(blank());
      inline.startOperation(emptyProfile(p.workspace));
    } else {
      d.initialize(blank());
      inline.initialize(emptyProfile(p.workspace));
    }
  }, [d, inline]);
  // The browser's leave prompt, while anything entered would be lost.
  const unsaved = (d.dirty || inline.dirty) && d.phase !== "recorded";
  useEffect(() => {
    if (!unsaved) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [unsaved]);
  const profileBox = useRef<HTMLFieldSetElement>(null);
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
  const retry = () => {
    requested.current.clear();
    setBranches({});
    requestedProjects.current.clear();
    setProjectReads({});
    setAttempt((n) => n + 1);
  };
  // The discovery offer appears only while discovery is unconfigured; discovery never uses a
  // login the operator did not choose there.
  const ghDraft = useDraft(p.drafts, "discovery.configure:setup");
  // A new visit starts clean; an unsettled login stays until it is checked.
  useEffect(() => ghDraft.startOperation({ key: key() }), [ghDraft]);
  const unconfigured =
    discovery.state === "unavailable" && discovery.reason === "unconfigured";
  const [ghLogin, setGhLogin] = useState<GhLogin | null>(null);
  // The login a new project's source would use: undefined while pending, null after a
  // failed read; neither records a credential.
  const [sourceGh, setSourceGh] = useState<GhLogin | null | undefined>();
  useEffect(() => {
    let live = true;
    p.client.read("/api/operator/discovery", discoveryStatusSchema).then(
      (r) => {
        if (!live) return;
        setGhLogin(unconfigured ? r.data.gh : null);
        setSourceGh(r.data.sourceGh);
      },
      () => {
        if (!live) return;
        setGhLogin(null);
        setSourceGh(null);
      },
    );
    return () => {
      live = false;
    };
  }, [p.client, unconfigured]);
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

  // GitHub Projects linked to every chosen repository, then their owners' others.
  // Each distinct chosen repository is read once per round (Retry starts a new round).
  const projectRepos = [...new Set(discoveredRepos)];
  const projectKey = projectRepos.join(", ");
  const [projectReads, setProjectReads] = useState<Record<string, Projects>>(
    {},
  );
  const requestedProjects = useRef(new Set<string>());
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed by the repository list; each repository is requested once per round.
  useEffect(() => {
    const round = attempt;
    for (const repo of projectRepos) {
      if (requestedProjects.current.has(repo)) continue;
      requestedProjects.current.add(repo);
      setProjectReads((x) => ({ ...x, [repo]: { state: "loading" } }));
      p.client
        .read(
          `/api/operator/discovery/projects?repository=${encodeURIComponent(repo)}`,
          discoveryProjectsSchema,
        )
        .then(
          (r) =>
            round === attemptRef.current &&
            setProjectReads((x) => ({ ...x, [repo]: r.data })),
          () =>
            round === attemptRef.current &&
            setProjectReads((x) => ({
              ...x,
              [repo]: { state: "unavailable", reason: "unreadable" },
            })),
        );
    }
  }, [projectKey, p.client, attempt]);
  const projects = aggregateProjects(
    projectRepos.map((repo) => [repo, projectReads[repo]] as const),
  );
  const chosenProject = String(d.values.githubProject ?? "");
  const projectChoiceTouched = useRef("");
  // A Project choice belongs to the repositories it was listed for: a new set starts at None.
  const listedFor = useRef(projectKey);
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset only when the Project repositories change.
  useEffect(() => {
    if (listedFor.current === projectKey || locked(d)) return;
    listedFor.current = projectKey;
    projectChoiceTouched.current = "";
    d.set("githubProject", "");
  }, [projectKey]);
  const projectList = projects?.state === "ready" ? projects : null;
  // Exactly one linked Project is preselected until the operator chooses.
  // biome-ignore lint/correctness/useExhaustiveDependencies: preselect only when a Project list lands or the repositories change.
  useEffect(() => {
    if (
      projectList &&
      projectList.linked.length === 1 &&
      !chosenProject &&
      projectChoiceTouched.current !== projectKey &&
      !locked(d)
    )
      d.set("githubProject", projectList.linked[0]?.projectNodeId ?? "");
  }, [projectList?.linked.length, projectKey, chosenProject]);

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
  const adoptListed = (r: SetupRow, fillRef = true): SetupRow => {
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
          // On screen an empty ref shows the listed default branch; the command never invents one.
          ref: r.ref.trim() || !fillRef ? r.ref : match.defaultBranch,
        }
      : r;
  };
  // Once discovery recovers, typed rows are adopted as above.
  // biome-ignore lint/correctness/useExhaustiveDependencies: adopt only when a repository list lands.
  useEffect(() => {
    if (!ready || locked(d)) return;
    const next = rows.map((r) => adoptListed(r));
    if (next.every((r, i) => r === rows[i])) return;
    // Adopted rows are edits: the service's earlier row errors no longer apply.
    d.clearErrors("repositories.");
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
    rows.map((r) => adoptListed(r, false)),
    // Only a Project the current list shows can be sent; the control is empty otherwise.
    listedProject(chosenProject, projectList),
    sourceGh,
  );
  const fieldError = (i: number, ...fields: string[]) => {
    const k = rowIndex.indexOf(i);
    return k >= 0 && fields.some((f) => d.errors[`repositories.${k}.${f}`]);
  };
  const duplicates = duplicateRows(rows);
  const update = (i: number, edited: SetupRow) => {
    // A row without a chosen repository keeps the form it was edited in, so a folder or
    // ref typed while discovery was unavailable stays visible when the list returns.
    const row: SetupRow = edited.repositoryId
      ? edited
      : { ...edited, source: sourceOf(edited) };
    // Editing a row retires the service's error for it; the next create checks again.
    const k = rowIndex.indexOf(i);
    // A row becoming blank or filled shifts the indices of the rows after it.
    if (blankRow(rows[i] ?? row) !== blankRow(row))
      d.clearErrors("repositories.");
    else if (k >= 0) d.clearErrors(`repositories.${k}.`);
    setRows(rows.map((r, j) => (j === i ? row : r)));
  };
  const recorded = d.phase === "recorded" && !earlier.current ? d.frozen : null;
  const profiles = p.workspace?.data.profiles.filter((r) => !r.revoked) ?? [];
  // Latched from the first workspace read this visit sees, so creating the first project
  // keeps its heading and Cancel target for the rest of the visit.
  const firstRunRead = useRef<boolean | null>(null);
  if (firstRunRead.current === null && p.workspace)
    firstRunRead.current = p.workspace.data.projects.length === 0;
  const firstRun = firstRunRead.current;
  const created = Boolean(recorded);
  const { onHeader } = p;
  useEffect(() => {
    if (firstRun !== null) onHeader?.({ firstRun, created });
  }, [onHeader, firstRun, created]);
  useEffect(() => () => onHeader?.(null), [onHeader]);
  // A stale lead (revoked since) keeps the select, which names it; an inline profile
  // stays until the re-read lists it.
  const inlineProfile =
    Boolean(p.workspace) &&
    profiles.length === 0 &&
    (!values.leadProfileId || inline.phase === "recorded");
  /** The created profile becomes the lead; every other setup value stays as entered. */
  const adoptProfile = () => {
    if (inline.phase === "recorded")
      d.set("leadProfileId", String(inline.values.profileId));
    p.refresh();
  };
  // Not a nested form: Enter and the button create the profile and never the project.
  const createProfile = () =>
    sendDraft(
      profileBox.current ?? document,
      inline,
      p.client,
      p.session,
      profileCreateCommand(inline.values),
      adoptProfile,
      runtimeErrors(inline.values, harnessSettings(p.workspace, inline.values)),
    );

  // Create is always drawn: held, it stays focusable with its reason, and submitting is
  // guarded on the live draft state, so a repeated click or Enter sends nothing more.
  const currentHold = () =>
    createHold({
      project: d.phase,
      profileForm: inlineProfile,
      profile: inline.phase,
      profileName: String(inline.values.name ?? ""),
    });
  const reason = currentHold();
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (currentHold()) return;
    void sendDraft(e.currentTarget, d, p.client, p.session, command, p.refresh);
  };
  const noteId = useId();

  // Step 3 sits behind "Add a repository" while discovery is unconfigured. Anything that
  // needs it (a value in a row, a rejected repository or Project, a login being saved) opens
  // it, and once open it stays open for the visit so no input is ever removed under focus.
  const rowIssue = Object.keys(d.errors).some(
    (k) => k.startsWith("repositories.") || k.startsWith("githubProject"),
  );
  const forced =
    rows.some((r) => !blankRow(r)) ||
    rowIssue ||
    ghDraft.phase === "pending" ||
    ghDraft.phase === "unknown";
  const [repoOpen, setRepoOpen] = useState(false);
  if (forced && !repoOpen) setRepoOpen(true);
  const collapsed = unconfigured && !repoOpen && !forced;
  // The one-click login is offered in step 3 whether or not Add a repository is opened.
  const offer =
    ghLogin?.state === "signed-in" &&
    unconfigured &&
    ghDraft.phase !== "unknown";
  const repoContent = useRef<HTMLDivElement>(null);
  const section = useRef<HTMLElement>(null);
  const repoContentId = useId();
  const focusFirstControl = () =>
    repoContent.current
      ?.querySelector<HTMLElement>(
        ".setup-row :is(input, select):not(:disabled)",
      )
      ?.focus();
  const openRepositories = () => {
    if (disabled) return;
    flushSync(() => setRepoOpen(true));
    focusFirstControl();
  };
  // Choosing the login replaces the controls it was chosen with while discovery is read
  // again, so focus moves into the content once that read settles.
  const focusAfterRead = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when a discovery read settles.
  useEffect(() => {
    if (!focusAfterRead.current || discovery.state === "loading") return;
    focusAfterRead.current = false;
    // Not while the operator has moved on to another field in the meantime.
    const at = document.activeElement;
    if (at && at !== document.body && !section.current?.contains(at)) return;
    focusFirstControl();
  }, [discovery.state]);
  // The browser scrolls a focused control into view, not out from under the sticky bar
  // (scroll-margin and scroll-padding only act on a control that is off screen).
  const bar = useRef<HTMLDivElement>(null);
  const clearOfBar = (e: FocusEvent<HTMLFormElement>) => {
    const target = e.target;
    // Not a dialog portalled out of the form, and not the bar itself.
    if (!e.currentTarget.contains(target) || bar.current?.contains(target))
      return;
    // After the browser's own scroll, in the same frame.
    requestAnimationFrame(() => {
      if (!bar.current) return;
      // The control and the error line under it.
      const box = (
        target.closest(".setup-field-stack") ??
        target.closest("label.field") ??
        target
      ).getBoundingClientRect();
      const hidden = box.bottom - bar.current.getBoundingClientRect().top;
      // A control taller than the free space keeps its top on screen.
      if (hidden > 0)
        window.scrollBy(0, Math.min(hidden, Math.max(box.top, 0)));
    });
  };
  // A rejection with no field to focus still has to be seen above the sticky bar.
  const outcome = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (
      (d.phase === "rejected" || d.phase === "conflict") &&
      !document.activeElement?.matches('[aria-invalid="true"]')
    )
      outcome.current?.scrollIntoView({ block: "nearest" });
  }, [d.phase]);

  if (recorded?.type === "project.create")
    return (
      <section className="settings-page setup-page">
        <ReadyCheck
          settings={p}
          draft={d}
          created={recorded}
          navigate={p.navigate}
        />
      </section>
    );

  return (
    <section className="settings-page setup-page">
      <form className="setup-grid" onSubmit={submit} onFocus={clearOfBar}>
        <div ref={outcome} className="setup-outcome">
          <DraftMessage
            draft={d}
            success={null}
            check={async () => {
              await d.reconcile(p.client, csrf);
              if (d.phase === "recorded" || d.phase === "conflict") p.refresh();
            }}
          />
        </div>
        <div className="settings-column">
          <section className="settings-panel">
            <h2 className="settings-panel-title">1 · Project and lead</h2>
            <div className="settings-fields">
              <DraftField draft={d} field="name" label="Project name" />
              {!inlineProfile && (
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
                  {/* A chosen lead revoked since keeps a visible option; create then rejects it. */}
                  {values.leadProfileId &&
                    !profiles.some((r) => r.id === values.leadProfileId) && (
                      <option value={values.leadProfileId}>
                        {p.workspace
                          ? "Lead profile unavailable"
                          : "Chosen lead (loading profiles)"}
                      </option>
                    )}
                </DraftField>
              )}
            </div>
            {inlineProfile && (
              <fieldset
                ref={profileBox}
                className="setup-profile"
                aria-label="New lead profile"
                disabled={disabled}
                onKeyDown={(e) => {
                  if (
                    e.key === "Enter" &&
                    !e.nativeEvent.isComposing &&
                    e.target instanceof HTMLInputElement
                  ) {
                    e.preventDefault();
                    void createProfile();
                  }
                }}
              >
                <p className="metadata muted">
                  No lead profiles yet. Create one here, or leave this blank and
                  choose a lead later; tasks wait for a lead before starting.
                </p>
                <div className="settings-fields">
                  <DraftField
                    draft={inline}
                    field="name"
                    label="Profile name"
                  />
                </div>
                <RuntimeFields
                  draft={inline}
                  workspace={p.workspace}
                  codexSettings={false}
                />
                <p className="metadata muted">
                  Add a summary and instructions later in Settings → Profiles.
                </p>
                {inline.phase !== "unknown" && (
                  <div>
                    <Button
                      type="button"
                      variant="secondary"
                      disabled={
                        inline.phase === "pending" ||
                        inline.phase === "recorded"
                      }
                      onClick={() => void createProfile()}
                    >
                      {inline.phase === "pending"
                        ? "Creating…"
                        : "Create profile"}
                    </Button>
                  </div>
                )}
              </fieldset>
            )}
            {/* The project's own outcome replaces this message, so one message shows. */}
            {d.phase !== "recorded" &&
              (inline.phase !== "recorded" || d.phase === "editing") && (
                <DraftMessage
                  draft={inline}
                  success="Profile created. Other setup values kept."
                  check={async () => {
                    await inline.reconcile(p.client, csrf);
                    if (
                      inline.phase === "recorded" ||
                      inline.phase === "conflict"
                    )
                      adoptProfile();
                  }}
                />
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
          <section className="settings-panel setup-repositories" ref={section}>
            <div>
              <h2 className="settings-panel-title">
                3 · Repository and GitHub · optional
              </h2>
              <p className="metadata muted">
                {collapsed
                  ? offer
                    ? "Optional. Without a repository the project is repository-free. GitHub discovery lists repositories and GitHub Projects to link."
                    : "Optional. Without a repository the project is repository-free; adding one also offers GitHub discovery."
                  : discovery.state === "unavailable"
                    ? discoveryReasonCopy(discovery.reason)
                    : "Repositories and GitHub Projects are discovered from GitHub with the read-only discovery credential. Repository access is exactly what you add here; a linked GitHub Project grants none."}
              </p>
            </div>
            {(collapsed
              ? offer
              : discovery.state === "unavailable" ||
                discoveredRepos.some(
                  (repo) => branches[repo]?.state === "unavailable",
                ) ||
                projectRepos.some(
                  (repo) => projectReads[repo]?.state === "unavailable",
                )) && (
              <div className="setup-inline-actions">
                {discovery.state === "unavailable" &&
                [
                  "unconfigured",
                  "missing-credential",
                  "gh-not-installed",
                  "gh-not-signed-in",
                ].includes(discovery.reason) ? (
                  <>
                    {offer && (
                      <Button
                        type="button"
                        aria-disabled={ghDraft.phase === "pending"}
                        className="aria-disabled:opacity-50"
                        onClick={async () => {
                          await ghDraft.submit(
                            p.client,
                            {
                              type: "discovery.configure",
                              key: ghDraft.values.key,
                              credentialRef: "gh:github.com",
                            },
                            csrf,
                          );
                          if (ghDraft.phase === "recorded") {
                            ghDraft.startOperation({ key: key() }, true);
                            focusAfterRead.current = true;
                            retry();
                          }
                        }}
                      >
                        {`Use GitHub CLI login (@${ghLogin.login})`}
                      </Button>
                    )}
                    <ActionLink
                      variant="secondary"
                      href={settingsSectionHref("github-discovery")}
                    >
                      Set discovery credential
                    </ActionLink>
                  </>
                ) : (
                  <Button type="button" variant="secondary" onClick={retry}>
                    Retry
                  </Button>
                )}
              </div>
            )}
            {ghLogin?.state === "signed-in" &&
              discovery.state === "unavailable" &&
              discovery.reason === "unconfigured" && (
                <>
                  <p className="metadata muted">
                    Signed in to github.com as @{ghLogin.login} with the GitHub
                    CLI on this Mac.
                  </p>
                  <p className="metadata muted">{discoveryUseNote}</p>
                </>
              )}
            <DraftMessage
              draft={ghDraft}
              check={async () => {
                await ghDraft.reconcile(p.client, csrf);
                if (ghDraft.phase === "recorded") {
                  ghDraft.startOperation({ key: key() }, true);
                  focusAfterRead.current = true;
                  retry();
                }
              }}
            />
            {collapsed && (
              <div>
                <Button
                  type="button"
                  variant="secondary"
                  aria-expanded="false"
                  aria-controls={repoContentId}
                  aria-disabled={disabled || undefined}
                  className="aria-disabled:opacity-50"
                  onClick={openRepositories}
                >
                  Add a repository
                </Button>
              </div>
            )}
            <div
              ref={repoContent}
              id={repoContentId}
              className="setup-repositories-content"
            >
              {!collapsed && (
                <>
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
                      pathRejected ||
                      (v?.state === "rejected" && Boolean(expected));
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
                                ready && row.repositoryId && !chosen
                                  ? "Chosen earlier · not in the current list from GitHub"
                                  : ready
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
                                  disabled={
                                    disabled || discovery.state === "loading"
                                  }
                                  value={row.repositoryId}
                                  onChange={(e) => {
                                    const value = e.target.value;
                                    if (value && value === row.repositoryId)
                                      return;
                                    // Typed entry keeps the chosen folder; the ref belonged to the old repository.
                                    if (value === typeOption) {
                                      update(i, {
                                        ...emptyRow("typed"),
                                        id: row.id,
                                        path: row.path,
                                      });
                                      return;
                                    }
                                    const r = ready?.repositories.find(
                                      (x) => x.repositoryId === value,
                                    );
                                    // No repository clears the whole row, so no hidden path or ref remains.
                                    if (!r) {
                                      update(i, {
                                        ...emptyRow("discovered"),
                                        id: row.id,
                                      });
                                      return;
                                    }
                                    // Another repository keeps the folder ("change the repository")
                                    // and checks it again against the new repository.
                                    const next: SetupRow = {
                                      ...row,
                                      source: "discovered",
                                      text: "",
                                      repositoryId: r.repositoryId,
                                      owner: r.owner,
                                      name: r.name,
                                      ref: r.defaultBranch,
                                    };
                                    update(i, next);
                                    verify(next);
                                  }}
                                >
                                  <option value="">
                                    {i === 0
                                      ? "No repository · repository-free"
                                      : "Choose a repository"}
                                  </option>
                                  {ready?.repositories.map((r) => (
                                    <option
                                      key={r.repositoryId}
                                      value={r.repositoryId}
                                    >
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
                                source === "discovered" &&
                                b?.state === "unavailable"
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
                                    {!row.ref && (
                                      <option value="">Choose a ref</option>
                                    )}
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
                                v?.state === "verified" &&
                                expected &&
                                !pathRejected
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
                                  ? {
                                      owner: row.owner,
                                      name: row.name,
                                      ref: row.ref,
                                    }
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
                    data={projects}
                    value={chosenProject}
                    onChange={(id) => {
                      projectChoiceTouched.current = projectKey;
                      d.set("githubProject", id);
                    }}
                  />
                  {rowIndex.length > 0 && (
                    <p className="metadata muted">
                      {setupSourceCredentialCopy(sourceGh)}
                    </p>
                  )}
                  {rows.length >= 20 && (
                    <p className="metadata muted">
                      A project can have up to 20 repositories.
                    </p>
                  )}
                  {rows.some((r) => !blankRow(r)) && rows.length < 20 && (
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
                </>
              )}
            </div>
          </section>
        </div>
        <aside className="setup-explainer" aria-label="What creation does">
          <h2 className="body">What creation does</h2>
          <ul className="body">
            <li>The project starts Paused. Creating it starts no execution.</li>
            <li>Repository access is exactly the list in step 3.</li>
          </ul>
        </aside>
        <div ref={bar} className="setup-submit">
          <p id={noteId} className="metadata muted">
            {reason ??
              "Saving creates a paused project; nothing runs until you resume it."}
          </p>
          <ActionLink
            variant="secondary"
            href={firstRun ? "/app" : settingsSectionHref("projects")}
          >
            Cancel
          </ActionLink>
          <Button
            type="submit"
            aria-disabled={reason ? true : undefined}
            aria-describedby={noteId}
          >
            {d.phase === "pending" ? "Creating…" : "Create paused project"}
          </Button>
        </div>
      </form>
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
  data: AggregatedProjects | null;
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
            ? `Found automatically: 1 GitHub Project linked to ${data.linked[0]?.repo ?? repo}. Linking adds an inactive discovery source; preview and readiness follow in project configuration.`
            : `${data.linked.length} GitHub Project${data.linked.length === 1 ? "" : "s"} linked to ${repo}${data.linked.length ? `: ${data.linked.map((x) => x.title).join(", ")}` : ""} · ${data.owned.length} more owned by ${data.ownerLogin}. Linking one adds an inactive discovery source; preview and readiness follow in project configuration.`;
  const partial =
    data?.state === "ready" && data.failure
      ? ` Some repositories' Projects couldn't be listed: ${discoveryReasonCopy(data.failure)}`
      : "";
  const shown =
    (list?.truncated && discoveryReady
      ? `${caption} Only the first 100 Projects of a repository or owner are listed; link another in project configuration.`
      : caption) + partial;
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
              {x.title} · linked to {x.repo}
            </option>
          ))}
          {list?.owned.map((x) => (
            <option key={x.projectNodeId} value={x.projectNodeId}>
              {x.title} · owned by {x.owner}
            </option>
          ))}
        </NativeSelect>
      )}
    </SetupField>
  );
}

type ListedProject = {
  projectNodeId: string;
  title: string;
  number: number;
};
type AggregatedProjects =
  | { state: "loading" }
  | { state: "unavailable"; reason: DiscoveryUnavailableReason }
  | {
      state: "ready";
      ownerLogin: string;
      linked: (ListedProject & { repo: string })[];
      owned: (ListedProject & { owner: string })[];
      truncated: boolean;
      /** A reason when some repositories' reads failed but others listed. */
      failure?: DiscoveryUnavailableReason;
    };
/** Linked Projects of every repository, deduplicated, then the owners' remaining ones. */
function aggregateProjects(
  entries: readonly (readonly [string, Projects | undefined])[],
): AggregatedProjects | null {
  if (!entries.length) return null;
  if (entries.some(([, r]) => !r || r.state === "loading"))
    return { state: "loading" };
  const ready = entries.flatMap(([repo, r]) =>
    r?.state === "ready" ? [{ repo, ...r }] : [],
  );
  const failed = entries.flatMap(([, r]) =>
    r?.state === "unavailable" ? [r] : [],
  )[0];
  if (!ready.length)
    return { state: "unavailable", reason: failed?.reason ?? "unreadable" };
  const seen = new Set<string>();
  const linked = ready.flatMap((r) =>
    r.linked.flatMap((x) => {
      if (seen.has(x.projectNodeId)) return [];
      seen.add(x.projectNodeId);
      return [{ ...x, repo: r.repo }];
    }),
  );
  const owned = ready.flatMap((r) =>
    r.owned.flatMap((x) => {
      if (seen.has(x.projectNodeId)) return [];
      seen.add(x.projectNodeId);
      return [{ ...x, owner: r.ownerLogin }];
    }),
  );
  return {
    state: "ready",
    ownerLogin: [...new Set(ready.map((r) => r.ownerLogin))].join(", "),
    linked,
    owned,
    truncated: ready.some((r) => r.truncated),
    ...(failed ? { failure: failed.reason } : {}),
  };
}
