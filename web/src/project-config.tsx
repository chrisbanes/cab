import { sourceCredentialSummary } from "./settings-view.js";
import { Circle, CircleCheck, CirclePause } from "lucide-react";
import { useCallback } from "react";
import {
  projectConfigurationSchema,
  projectPrivateValuesSchema,
  sourceObservationSchema,
} from "../../src/operator/contracts.js";
import {
  projectLabel,
  workspaceLabels,
} from "../../src/operator/project-labels.js";
import {
  commandNetworkAppliesNote,
  commandNetworkDisclosure,
  projectCommandNetworkLine,
} from "../../src/operator/command-network-copy.js";
import { ActionLink, ResourceStatus, StatusBadge } from "./components.js";
import { useOperatorResource } from "./resource.js";
import { RoutingTab } from "./routing-config.js";
import {
  privateField,
  projectChanges,
  type ProjectConfigurationData,
  type Values,
} from "./settings-changes.js";
import {
  plural,
  projectStateSummary,
  projectTab,
  readinessNextStep,
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
  PrivateTextField,
  reloadDraft,
  revealedText,
  submitDraft,
  useDraft,
  useHeaderRefresh,
  useLoadedDraft,
  editable,
  textHold,
  usePrivateValues,
  type SettingsProps,
} from "./settings.js";
import { SourceTab } from "./source-config.js";
import { readinessAnchor } from "./observation-counts.js";
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
  const labels = workspaceLabels(p.workspace);
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
            <StatusBadge
              tone="idle"
              icon={data.project.paused ? CirclePause : CircleCheck}
            >
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
              (r) => projectLabel(labels, r.id, r.name).text,
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
              observations={observations}
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
    ? "Paused: new tasks wait to start."
    : "Existing start rules still apply.";
  const withSaved = (line: string, savedAt: string | null) =>
    savedAt ? `${line} ${savedAt}.` : line;
  if (tab === "routing")
    return withSaved(
      data.project.paused
        ? `Paused: new tasks wait to start. Routing changes do not resume ${data.project.name ?? "this project"}.`
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
        {next === readinessNextStep && (
          <a
            href={`/app/projects/${projectId}/settings?tab=github#${readinessAnchor}`}
          >
            Check readiness conditions
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
    ...(data.commandNetworkAccess === undefined
      ? {}
      : { commandNetworkAccess: data.commandNetworkAccess }),
    expectedVersion: String(data.project.version),
  };
  useLoadedDraft(d, initial, p.loadedAt);
  const priv = usePrivateValues(
    p.client,
    p.session,
    `/api/operator/projects/${projectId}/private-values`,
    projectPrivateValuesSchema,
    {
      loaded: data.project.version,
      version: (r) => r.data.project.version,
      edit: typeof d.values.instructions === "string" && editable(d.phase),
      refreshLoaded: p.refreshConfiguration,
    },
  );
  const revealed = revealedText(
    priv.state,
    (r) => ({
      version: r.data.project.version,
      text: r.data.project.instructions,
    }),
    data.project.version,
  );
  const lines = projectChanges(data, d.values, revealed);
  // An edit is compared with the saved text before it is sent; until that read is current, wait.
  const holdSave =
    typeof d.values.instructions === "string" && revealed === undefined;
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
    ...(data.commandNetworkAccess !== undefined &&
    Boolean(v.commandNetworkAccess) !== data.commandNetworkAccess
      ? { commandNetworkAccess: Boolean(v.commandNetworkAccess) }
      : {}),
    ...privateField("instructions", v.instructions, revealed),
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
                {},
                holdSave,
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
            {data.commandNetworkAccess !== undefined && (
              <>
                <DraftCheck
                  draft={d}
                  field="commandNetworkAccess"
                  label="Command network access"
                  toggle
                />
                <p className="metadata muted">
                  {projectCommandNetworkLine(data.commandNetworkAccess)}{" "}
                  {commandNetworkAppliesNote} {commandNetworkDisclosure}
                </p>
              </>
            )}
            <PrivateTextField
              draft={d}
              field="instructions"
              label="Instructions"
              noun="instructions"
              revealed={revealed}
              state={priv.state}
              onReveal={priv.reveal}
            >
              <p className="metadata muted">
                Private to this signed-in session; revealing is not recorded.
                Assignments keep their captured revision until explicit Apply
                for their next turn. Emptying the field clears the instructions.
              </p>
            </PrivateTextField>
            <ChangeList lines={lines} />
            <DraftOutcome
              draft={d}
              client={p.client}
              session={p.session}
              label="Save project"
              saveDisabled={lines.length === 0}
              hold={holdSave ? textHold : undefined}
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
    configured: boolean | null,
    href: string,
    action: string,
  ) => (
    <article className="settings-row">
      <div className="settings-row-heading">
        <div>
          <h3 className="small-heading">{title}</h3>
          <p className="metadata muted">{detail}</p>
        </div>
        {configured !== null && (
          <StatusBadge tone="idle" icon={configured ? CircleCheck : Circle}>
            {configured ? "Configured" : "Unconfigured"}
          </StatusBadge>
        )}
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
        routing,
        `${page}?tab=routing`,
        "Change in Routing",
      )}
      {row(
        "GitHub source",
        sourceCredentialSummary(data.source),
        source,
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
