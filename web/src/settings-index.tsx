import { visibleProjects } from "./project-lifecycle-model.js";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import {
  ChevronDown,
  CircleCheck,
  CirclePause,
  CircleQuestionMark,
  CircleSlash,
} from "lucide-react";
import {
  projectConfigurationSchema,
  workspaceSchema,
  runtimeSettingsSchema,
  sourceObservationSchema,
} from "../../src/operator/contracts.js";
import type { OperatorClient } from "./api.js";
import {
  projectLabel,
  workspaceLabels,
} from "../../src/operator/project-labels.js";
import { ActionLink, Button, ProjectName, StatusBadge } from "./components.js";
import { GitLabCredentialsSection } from "./gitlab-credentials.js";
import { DiscoveryCredentialRow } from "./discovery-credential.js";
import { runtimeSummary } from "./execution-runtime.js";
import { RuntimeSettings } from "./recovery.js";
import { NotificationsSection } from "./notifications.js";
import { OperatorCredentialsSection } from "./operator-credentials.js";
import { ReadinessPanel } from "./readiness.js";
import { useMediaQuery } from "./use-media-query.js";
import { useOperatorResource } from "./resource.js";
import {
  SETTINGS_SECTIONS,
  type SettingsSectionId,
  settingsSection,
  settingsSectionHref,
} from "./settings-sections.js";
import type { ProjectConfigurationData } from "./settings-changes.js";
import { Panel, useHeaderRefresh, type SettingsProps } from "./settings.js";
import {
  observationLabel,
  observationSymbol,
  plural,
  repositoryLines,
  routingLine,
  selectionLine,
} from "./settings-view.js";

/** One project's configuration read: pending, loaded or failed (null). */
type ConfigState = ProjectConfigurationData | null | undefined;

/** Reads every project's configuration, at most four in flight; each fails on its own. */
function useProjectConfigurations(
  client: OperatorClient,
  scope: string,
  ids: string[],
  nonce: number | undefined,
) {
  const [configs, setConfigs] = useState<Record<string, ConfigState>>({});
  // One controller per load; a Retry shares it, so unmount or a new load cancels both.
  const current = useRef(new AbortController());
  const read = useCallback(
    (targets: string[], signal: AbortSignal) => {
      const queue = [...targets];
      const worker = async () => {
        for (let id = queue.shift(); id; id = queue.shift()) {
          const projectId = id;
          let value: ConfigState = null;
          try {
            value = (
              await client.read(
                `/api/operator/projects/${projectId}/configuration`,
                projectConfigurationSchema,
                signal,
              )
            ).data;
          } catch {
            value = null;
          }
          if (signal.aborted) return;
          setConfigs((c) => ({ ...c, [projectId]: value }));
        }
      };
      void Promise.all(Array.from({ length: 4 }, worker));
    },
    [client],
  );
  const key = ids.join(",");
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-read when the project list, scope or header Refresh changes.
  useEffect(() => {
    const abort = new AbortController();
    current.current = abort;
    read(ids, abort.signal);
    return () => abort.abort();
  }, [read, key, scope, nonce]);
  const retry = (id: string) => {
    setConfigs((c) => ({ ...c, [id]: undefined }));
    read([id], current.current.signal);
  };
  return { configs, retry };
}

const phoneQuery = "(max-width: 759px)";

/**
 * The nine Settings links. Through 759px a Sections button shows and hides the same list
 * inline; from 760px the list stays visible. One list, ordinary links: no menu roles or
 * arrow keys.
 */
export function SettingsSectionNav({
  current,
}: {
  current: SettingsSectionId | null;
}) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  const trigger = useRef<HTMLButtonElement>(null),
    list = useRef<HTMLUListElement>(null);
  // Focus on a control that a resize hides moves to its counterpart. This listener is
  // registered before `useMediaQuery`'s, so it sees the focus before the re-render.
  const refocus = useRef<"trigger" | "link" | null>(null);
  useEffect(() => {
    const media = matchMedia(phoneQuery);
    const change = () => {
      const active = document.activeElement;
      refocus.current = media.matches
        ? list.current?.contains(active)
          ? "trigger"
          : null
        : active === trigger.current
          ? "link"
          : null;
      if (media.matches) setOpen(false);
    };
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, []);
  const phone = useMediaQuery(phoneQuery);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new section closes the list on arrival.
  useEffect(() => setOpen(false), [current]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs after the layout switch renders.
  useEffect(() => {
    const target = refocus.current;
    refocus.current = null;
    if (target === "trigger") trigger.current?.focus();
    else if (target === "link")
      (
        list.current?.querySelector<HTMLElement>('[aria-current="page"]') ??
        list.current?.querySelector<HTMLElement>("a")
      )?.focus();
  }, [phone]);
  return (
    <nav className="settings-nav" aria-label="Settings sections">
      {phone && (
        <Button
          ref={trigger}
          variant="secondary"
          className="settings-nav-trigger"
          aria-expanded={open}
          aria-controls={listId}
          onClick={() => setOpen((o) => !o)}
        >
          <span>
            Sections{current ? ` · ${settingsSection(current).label}` : ""}
          </span>
          <ChevronDown aria-hidden="true" />
        </Button>
      )}
      <ul id={listId} ref={list} hidden={phone && !open}>
        {SETTINGS_SECTIONS.map((s) => (
          <li key={s.id}>
            <a
              href={settingsSectionHref(s.id)}
              aria-current={s.id === current ? "page" : undefined}
              onClick={() => setOpen(false)}
            >
              {s.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/** A Settings page: the section navigation beside one section's content. */
export function SettingsLayout({
  current,
  children,
}: {
  current: SettingsSectionId | null;
  children?: ReactNode;
}) {
  return (
    <div className="settings-page">
      <div className="settings-layout">
        <SettingsSectionNav current={current} />
        <div className="settings-content">{children}</div>
      </div>
    </div>
  );
}

/** The page for one section, mounting only that section's reads. */
export function SettingsSectionPage(
  p: SettingsProps & { section: SettingsSectionId },
) {
  const page = {
    projects: ProjectsSettings,
    runtime: RuntimeSettings,
    profiles: AgentsSettings,
    routing: RoutingSettings,
    "github-discovery": DiscoverySettings,
    "gitlab-credentials": GitLabSettings,
    "cli-credentials": OperatorCredentialsSection,
    notifications: NotificationsSection,
    readiness: ReadinessSettings,
  }[p.section];
  const Page = page as (props: SettingsProps) => ReactNode;
  return (
    <SettingsLayout current={p.section}>
      <Page {...p} />
    </SettingsLayout>
  );
}

function useUnavailable(retry: (id: string) => void) {
  return (id: string, name: string) => (
    <p className="body settings-unavailable">
      Unavailable{" "}
      <Button
        variant="secondary"
        aria-label={`Retry ${name}`}
        onClick={() => retry(id)}
      >
        Retry
      </Button>
    </p>
  );
}

function ProjectsSettings(p: SettingsProps) {
  const [showArchived, setShowArchived] = useState(false);
  const archivedLoader = useCallback(
    (signal: AbortSignal) =>
      p.client.read(
        "/api/operator/workspace?includeArchived=true",
        workspaceSchema,
        signal,
      ),
    [p.client],
  );
  const archivedWorkspace = useOperatorResource(
    showArchived ? `${p.session.csrfToken}:archived-projects` : null,
    archivedLoader,
  );
  useHeaderRefresh(p.refreshNonce, () => {
    if (showArchived) void archivedWorkspace.refresh();
  });
  const projects = visibleProjects(
      (showArchived ? archivedWorkspace.state.data : p.workspace)?.data
        .projects ?? [],
      showArchived,
    ),
    profiles = p.workspace?.data.profiles ?? [],
    projectLabels = workspaceLabels(p.workspace);
  const { configs, retry } = useProjectConfigurations(
    p.client,
    p.session.csrfToken,
    projects.map((r) => r.id),
    p.refreshNonce,
  );
  const unavailable = useUnavailable(retry);
  const observationLoader = useCallback(
      (signal: AbortSignal) =>
        p.client.read(
          "/api/operator/source-observations",
          sourceObservationSchema,
          signal,
        ),
      [p.client],
    ),
    observations = useOperatorResource(p.session.csrfToken, observationLoader);
  const runtimeLoader = useCallback(
      (signal: AbortSignal) =>
        p.client.read("/api/operator/runtime", runtimeSettingsSchema, signal),
      [p.client],
    ),
    runtime = useOperatorResource(p.session.csrfToken, runtimeLoader);
  useHeaderRefresh(p.refreshNonce, () => {
    observations.refresh();
    runtime.refresh();
  });
  const observed = observations.state.data?.data.projects;
  const runtimeData = runtime.state.data?.data;
  const heldTasks = (projectId: string) =>
    runtimeData?.projects
      .find((r) => r.project.id === projectId)
      ?.tasks.filter((t) => t.held).length ?? 0;
  const paused = projects.filter((r) => r.paused).length;
  return (
    <Panel
      id="projects"
      title="Projects"
      description={`${plural(projects.length, "project")} · ${paused} paused · repository access and GitHub discovery per project`}
      action={
        <ActionLink href="/settings/projects/new">Create project</ActionLink>
      }
    >
      <label className="body check-field">
        <input
          type="checkbox"
          checked={showArchived}
          onChange={(e) => setShowArchived(e.target.checked)}
        />
        Show archived
      </label>
      {projects.map((r) => {
        const label = projectLabel(projectLabels, r.id, r.name),
          name = label.text,
          c = configs[r.id],
          lead = profiles.find((x) => x.id === c?.project.leadProfileId)?.name;
        return (
          <article className="settings-row" key={r.id}>
            <div className="settings-row-heading">
              <h3 className="small-heading">
                <ProjectName label={label} id={r.id} />{" "}
                {r.archived && <StatusBadge>Archived</StatusBadge>}
              </h3>
              {c && (
                <span className="metadata muted">
                  Lead: {lead ?? "Unconfigured"}
                </span>
              )}
              <StatusBadge
                tone="idle"
                icon={r.paused ? CirclePause : CircleCheck}
              >
                {r.paused ? "Paused" : "Enabled"}
              </StatusBadge>
              <ActionLink
                variant="secondary"
                href={`/projects/${r.id}/settings`}
                aria-label={`Configure ${name}`}
              >
                Configure
              </ActionLink>
            </div>
            {c === undefined ? (
              <p className="metadata muted">Loading configuration…</p>
            ) : c === null ? (
              unavailable(r.id, name)
            ) : (
              <dl className="settings-facts metadata">
                <div>
                  <dt>Repository access</dt>
                  <dd>
                    {[
                      ...repositoryLines(c),
                      ...(heldTasks(r.id) ? ["execution hold recorded"] : []),
                    ].join(" · ")}
                  </dd>
                </div>
                <div>
                  <dt>Task source</dt>
                  <dd>
                    {c.source.selections.length === 0 ? (
                      c.source.tracker === "jira" ? (
                        "No Jira selections"
                      ) : (
                        "No GitHub selections"
                      )
                    ) : (
                      <ul>
                        {c.source.selections.map((s, i) => {
                          const o = observed
                            ?.find((o) => o.projectId === r.id)
                            ?.selections.find((o) => o.selectionId === s.id);
                          return (
                            <li key={s.id ?? i}>
                              <span>{selectionLine(s)}</span>
                              <StatusBadge
                                tone="idle"
                                icon={
                                  observations.state.data
                                    ? observationSymbol(o)
                                    : CircleQuestionMark
                                }
                              >
                                {observations.state.data
                                  ? observationLabel(o)
                                  : "Unavailable"}
                              </StatusBadge>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </dd>
                </div>
              </dl>
            )}
          </article>
        );
      })}
      <p className="metadata muted">
        Discovery and readiness never grant repository access; each is listed
        separately.
      </p>
    </Panel>
  );
}

function AgentsSettings(p: SettingsProps) {
  const profiles = p.workspace?.data.profiles ?? [],
    revoked = profiles.filter((r) => r.revoked).length;
  return (
    <Panel
      id="profiles"
      title="Agents"
      description={`${plural(profiles.length, "agent")} · ${revoked} revoked`}
      action={
        <ActionLink variant="secondary" href="/settings/profiles/new">
          Create agent
        </ActionLink>
      }
    >
      {profiles.map((r) => {
        const name = r.name ?? "Name unavailable";
        return (
          <article className="settings-row" key={r.id}>
            <div className="settings-row-heading">
              <div>
                <h3 className="small-heading">{name}</h3>
                <p className="metadata muted">
                  {[r.summary, `revision ${r.version}`]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
                <p className="metadata muted">
                  Runtime: {runtimeSummary(r.runtime)}
                </p>
              </div>
              <StatusBadge
                tone={r.revoked ? "warning" : "idle"}
                icon={r.revoked ? undefined : CircleCheck}
              >
                {r.revoked ? "Revoked" : "Available"}
              </StatusBadge>
              <ActionLink
                variant="secondary"
                href={`/profiles/${r.id}/settings`}
                aria-label={`Edit ${name}`}
              >
                Edit
              </ActionLink>
            </div>
          </article>
        );
      })}
    </Panel>
  );
}

function RoutingSettings(p: SettingsProps) {
  const projects = visibleProjects(p.workspace?.data.projects ?? [], false),
    projectLabels = workspaceLabels(p.workspace);
  const { configs, retry } = useProjectConfigurations(
    p.client,
    p.session.csrfToken,
    projects.map((r) => r.id),
    p.refreshNonce,
  );
  const unavailable = useUnavailable(retry);
  return (
    <Panel
      id="routing"
      title="Routing"
      description="Per project. Requires opt-in and a TypeSafe credential reference."
    >
      {projects.map((r) => {
        const label = projectLabel(projectLabels, r.id, r.name),
          name = label.text,
          c = configs[r.id];
        return (
          <article className="settings-row" key={r.id}>
            <div className="settings-row-heading">
              <div>
                <h3 className="small-heading">
                  <ProjectName label={label} id={r.id} />
                </h3>
                {c === undefined ? (
                  <p className="metadata muted">Loading…</p>
                ) : c === null ? (
                  unavailable(r.id, name)
                ) : (
                  <p className="metadata muted">{routingLine(c.routing)}</p>
                )}
              </div>
              {c && (
                <StatusBadge
                  tone="idle"
                  icon={c.routing.enabled ? CircleCheck : CircleSlash}
                >
                  {c.routing.enabled ? "Enabled" : "Disabled"}
                </StatusBadge>
              )}
              <ActionLink
                variant="secondary"
                href={`/projects/${r.id}/settings?tab=routing`}
                aria-label={`Open routing for ${name}`}
              >
                Open routing
              </ActionLink>
            </div>
          </article>
        );
      })}
    </Panel>
  );
}

function DiscoverySettings(p: SettingsProps) {
  return (
    <Panel
      id="github-discovery"
      title="GitHub discovery"
      description="Read-only credential for listing repositories, refs and GitHub Projects. It grants no repository access."
    >
      <DiscoveryCredentialRow {...p} />
    </Panel>
  );
}

function ReadinessSettings(p: SettingsProps) {
  // A discovery save from a check's repair re-reads the checks.
  const [discoveryNonce, setDiscoveryNonce] = useState(0);
  const discoveryChanged = useCallback(
    () => setDiscoveryNonce((n) => n + 1),
    [],
  );
  return (
    <ReadinessPanel
      {...p}
      refreshNonce={(p.refreshNonce ?? 0) + discoveryNonce}
      onDiscoveryChange={discoveryChanged}
    />
  );
}

function GitLabSettings(p: SettingsProps) {
  return (
    <Panel
      id="gitlab-credentials"
      title="GitLab credentials"
      description="The credential for each GitLab host: lists projects, shows the account and pushes task branches. Links and delivery grants decide what it may reach."
    >
      <GitLabCredentialsSection {...p} />
    </Panel>
  );
}
