import { sourceCredentialSummary } from "./settings-view.js";
import { useCallback } from "react";
import {
  projectConfigurationSchema,
  sourceObservationSchema,
} from "../../src/operator/contracts.js";
import { ActionLink, ResourceStatus, StatusBadge } from "./components.js";
import { useOperatorResource } from "./resource.js";
import { RoutingTab } from "./routing-config.js";
import {
  projectChanges,
  type ProjectConfigurationData,
  type Values,
} from "./settings-changes.js";
import {
  plural,
  projectStateSummary,
  projectTab,
  projectTabs,
  savedLine,
  type ProjectTab,
} from "./settings-view.js";
import {
  Aside,
  ChangeList,
  DraftCheck,
  DraftField,
  DraftOutcome,
  Panel,
  reloadDraft,
  submitDraft,
  useDraft,
  useHeaderRefresh,
  useLoadedDraft,
  type SettingsProps,
} from "./settings.js";
import { SourceTab } from "./source-config.js";
import { SyncTab } from "./sync-placement.js";

export interface TabProps extends SettingsProps {
  projectId: string;
  data: ProjectConfigurationData;
  /** When the configuration read last completed. */
  loadedAt: number | null;
  refreshConfiguration: () => void;
}

export function ProjectConfiguration(
  p: SettingsProps & { projectId: string; query: string },
) {
  const { projectId } = p,
    tab = projectTab(p.query),
    loader = useCallback(
      (signal: AbortSignal) =>
        p.client.read(
          `/api/operator/projects/${projectId}/configuration`,
          projectConfigurationSchema,
          signal,
        ),
      [p.client, projectId],
    ),
    resource = useOperatorResource(
      `${p.session.csrfToken}:${projectId}`,
      loader,
    ),
    data = resource.state.data?.data,
    observationLoader = useCallback(
      (signal: AbortSignal) =>
        p.client.read(
          "/api/operator/source-observations",
          sourceObservationSchema,
          signal,
        ),
      [p.client],
    ),
    observations = useOperatorResource(p.session.csrfToken, observationLoader);
  useHeaderRefresh(p.refreshNonce, () => {
    resource.refresh();
    observations.refresh();
  });
  const refreshConfiguration = () => {
    p.refresh();
    resource.refresh();
  };
  const unsettled = p.drafts
    .unsettledPlacements(projectId)
    .filter((c) => !data?.placements.some((row) => row.taskId === c.taskId));
  return (
    <div className="settings-page">
      <ResourceStatus
        label="Project configuration"
        state={resource.state}
        retry={resource.refresh}
      />
      {data && (
        <>
          <p className="settings-status body muted">
            <StatusBadge tone={data.project.paused ? "warning" : "neutral"}>
              {data.project.paused ? "Paused" : "Enabled"}
            </StatusBadge>{" "}
            {statusLine(tab, data, p, unsettled.length)}
          </p>
          <ProjectStateCards
            projectId={projectId}
            {...projectStateSummary(
              data,
              observations.state.data?.data ?? null,
              unsettled,
            )}
          />
          <nav
            className="settings-tabs"
            aria-label="Project configuration sections"
          >
            {projectTabs.map((t) => (
              <a
                key={t.id}
                className="control"
                href={`/app/projects/${projectId}/settings${t.id === "general" ? "" : `?tab=${t.id}`}`}
                aria-current={t.id === tab ? "page" : undefined}
              >
                {t.label}
              </a>
            ))}
          </nav>
          {tab === "routing" ? (
            <RoutingTab
              {...p}
              data={data}
              loadedAt={resource.state.fetchedAt}
              refreshConfiguration={refreshConfiguration}
            />
          ) : tab === "github" ? (
            <SourceTab
              {...p}
              data={data}
              loadedAt={resource.state.fetchedAt}
              refreshConfiguration={refreshConfiguration}
            />
          ) : tab === "sync" ? (
            <SyncTab
              {...p}
              data={data}
              loadedAt={resource.state.fetchedAt}
              refreshConfiguration={refreshConfiguration}
              observations={observations}
            />
          ) : (
            <GeneralTab
              {...p}
              data={data}
              loadedAt={resource.state.fetchedAt}
              refreshConfiguration={refreshConfiguration}
            />
          )}
        </>
      )}
    </div>
  );
}

function statusLine(
  tab: ProjectTab,
  data: ProjectConfigurationData,
  p: SettingsProps & { projectId: string },
  unknownPlacements: number,
) {
  const saved = (key: string, version: number) =>
    savedLine(version, p.drafts.saved(`${key}:${p.projectId}`));
  const admission = data.project.paused
    ? "Paused: new admission is held."
    : "Existing admission rules still apply.";
  const withSaved = (line: string, savedAt: string | null) =>
    savedAt ? `${line} ${savedAt}.` : line;
  if (tab === "routing")
    return withSaved(
      data.project.paused
        ? `Paused: new admission is held. Routing changes do not resume ${data.project.name ?? "this project"}.`
        : admission,
      saved("routing.configure", data.routing.version),
    );
  if (tab === "github")
    return [
      saved("github.configure", data.source.version),
      sourceCredentialSummary(data.source),
    ]
      .filter(Boolean)
      .join(" · ");
  if (tab === "sync")
    return data.placements.length || unknownPlacements
      ? `${plural(data.placements.length, "conflicting placement")} · ${plural(unknownPlacements, "placement outcome")} to check`
      : "No placement conflicts.";
  return withSaved(admission, saved("project.configure", data.project.version));
}

/** Phone-first summary (frame 121): what is true now and the next step. Hidden on desktop. */
function ProjectStateCards({
  state,
  next,
  projectId,
}: {
  state: string[];
  next: string;
  projectId: string;
}) {
  return (
    <div className="settings-phone-cards">
      <section className="settings-aside" aria-label="Current state">
        <h2 className="small-heading">Current state</h2>
        <ul className="body">
          {state.map((line, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: lines can repeat; the list is rebuilt from the reads.
            <li key={i}>{line}</li>
          ))}
        </ul>
      </section>
      <section className="settings-aside" aria-label="Next step">
        <h2 className="small-heading">Next step</h2>
        <p className="body">{next}</p>
        {next.includes("credential") && (
          <a href={`/app/projects/${projectId}/settings?tab=github`}>
            Set or change source credential
          </a>
        )}
      </section>
    </div>
  );
}

function GeneralTab(p: TabProps) {
  const { data, projectId } = p,
    draftKey = `project.configure:${projectId}`,
    d = useDraft(p.drafts, draftKey);
  const initial: Values = {
    name: data.project.name ?? "",
    leadProfileId: data.project.leadProfileId ?? "",
    paused: data.project.paused,
    replaceInstructions: false,
    instructions: "",
    expectedVersion: String(data.project.version),
  };
  useLoadedDraft(d, initial, p.loadedAt);
  const lines = projectChanges(data, d.values);
  const v = d.values;
  const command = () => ({
    type: "project.configure",
    key: v.key,
    projectId,
    expectedVersion: Number(v.expectedVersion),
    ...(v.name !== (data.project.name ?? "") ? { name: v.name } : {}),
    ...(Boolean(v.paused) !== data.project.paused
      ? { paused: Boolean(v.paused) }
      : {}),
    ...(v.leadProfileId !== (data.project.leadProfileId ?? "")
      ? { leadProfileId: v.leadProfileId || null }
      : {}),
    ...(v.replaceInstructions ? { instructions: v.instructions } : {}),
  });
  return (
    <div className="settings-split">
      <div className="settings-column">
        <Panel title="General" description="Each section saves on its own.">
          <form
            onSubmit={(e) =>
              void submitDraft(
                e,
                d,
                p.client,
                p.session,
                command(),
                p.refreshConfiguration,
              )
            }
          >
            <div className="settings-fields">
              <DraftField draft={d} field="name" label="Project name" />
              <DraftField draft={d} field="leadProfileId" label="Lead profile">
                <option value="">Unconfigured</option>
                {data.profiles
                  .filter(
                    (r) => !r.revoked || r.id === data.project.leadProfileId,
                  )
                  .map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name ?? "Name unavailable"}
                      {r.revoked ? " (revoked)" : ""}
                    </option>
                  ))}
              </DraftField>
            </div>
            <DraftCheck draft={d} field="paused" label="Pause project" toggle />
            <p className="metadata muted">
              Pausing lets active turns finish and holds queued and new turns.
              Unpausing never clears Stop, writer, capacity or uncertainty
              holds.
            </p>
            <DraftCheck
              draft={d}
              field="replaceInstructions"
              label="Replace instructions"
            />
            <p className="metadata muted">
              Current private instructions are never loaded into this form.
              Assignments keep their captured revision until explicit Apply for
              their next turn. An empty replacement clears them.
            </p>
            {v.replaceInstructions && (
              <DraftField
                draft={d}
                field="instructions"
                label="New instructions"
                multiline
              />
            )}
            <ChangeList lines={lines} />
            <DraftOutcome
              draft={d}
              client={p.client}
              session={p.session}
              label="Save project"
              saveDisabled={lines.length === 0}
              discard={() => reloadDraft(d, initial)}
              refresh={p.refreshConfiguration}
              review={() => d.adoptLatest(data.project.version, initial)}
            />
          </form>
        </Panel>
        <CredentialReferences projectId={projectId} data={data} />
      </div>
      <div className="settings-column">
        <Aside
          title="Saving boundary"
          items={[
            "Saving never resumes work, clears holds or grants repository access.",
            "A conflict keeps your input until you review the loaded revision.",
            "If a save's outcome is unknown, check what was saved before editing again.",
          ]}
        />
        <Aside
          title="Related"
          items={[
            <a key="tasks" href={`/app/projects/${projectId}`}>
              Project tasks
            </a>,
            <a key="advanced" href={`/project/${projectId}`}>
              Open advanced project editor
            </a>,
          ]}
        />
      </div>
    </div>
  );
}

function CredentialReferences({
  projectId,
  data,
}: {
  projectId: string;
  data: ProjectConfigurationData;
}) {
  const page = `/app/projects/${projectId}/settings`;
  const row = (
    title: string,
    detail: string,
    badge: string | null,
    href: string,
    action: string,
  ) => (
    <article className="settings-row">
      <div className="settings-row-heading">
        <div>
          <h3 className="small-heading">{title}</h3>
          <p className="metadata muted">{detail}</p>
        </div>
        {badge && <StatusBadge>{badge}</StatusBadge>}
        <ActionLink variant="secondary" href={href}>
          {action}
        </ActionLink>
      </div>
    </article>
  );
  const routing = data.routing.credentialConfigured,
    source = data.source.credentialConfigured;
  return (
    <Panel
      title="Credential and environment references"
      description="Routing uses env:NAME. GitHub sources accept a GitHub CLI login or env:NAME; values stay server-side."
    >
      {row(
        "Routing · TypeSafe",
        routing
          ? "Reference configured"
          : "Reference unconfigured · routing is unavailable until one is set",
        routing ? "Configured" : "Unconfigured",
        `${page}?tab=routing`,
        "Change in Routing",
      )}
      {row(
        "GitHub source",
        sourceCredentialSummary(data.source),
        source ? "Configured" : "Unconfigured",
        `${page}?tab=github`,
        "Change in GitHub source",
      )}
      {row(
        "Delivery policy, authority grants and required checks",
        "Not edited here",
        null,
        `/project/${projectId}`,
        "Open advanced editor",
      )}
    </Panel>
  );
}
