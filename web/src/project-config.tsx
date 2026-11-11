import { projectSchema } from "../../src/operator/contracts.js";
import { ProjectLifecyclePanel, DeletedProject } from "./project-lifecycle.js";
import { sourceCredentialSummary } from "./settings-view.js";
import { Circle, CircleCheck, CirclePause } from "lucide-react";
import { useCallback, useId, useRef, useState } from "react";
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
import {
  localListeningAppliesNote,
  localListeningLimit,
  projectLocalListeningLine,
} from "../../src/operator/local-listening-copy.js";
import {
  skipSandboxAppliesNote,
  skipSandboxGrantLines,
  skipSandboxRisk,
  skipSandboxSupersededLine,
  projectSkipSandboxLine,
} from "../../src/operator/skip-sandbox-copy.js";
import {
  ActionLink,
  Button,
  ResourceStatus,
  StatusBadge,
} from "./components.js";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "./ui/dialog.js";
import { useOperatorResource } from "./resource.js";
import { RoutingTab } from "./routing-config.js";
import { PermittedAgentsTab } from "./permitted-agents-config.js";
import {
  privateField,
  projectChanges,
  type ProjectConfigurationData,
  type Values,
} from "./settings-changes.js";
import {
  diagnosticCaptureAppliesNote,
  diagnosticCaptureLabels,
  diagnosticCaptureLine,
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
  sendDraft,
  submitDraft,
  useDraft,
  useHeaderRefresh,
  useLoadedDraft,
  editable,
  locked,
  textHold,
  usePrivateValues,
  type SettingsProps,
} from "./settings.js";
import { DeliveryTab } from "./delivery-config.js";
import { InstructionProposalsTab } from "./instruction-proposal.js";
import { RepositoryTab } from "./repository-config.js";
import { SourceTab } from "./source-config.js";
import { readinessAnchor } from "./observation-counts.js";
import { SyncTab } from "./sync-placement.js";
import { JiraSourceTab } from "./jira-source.js";
import { NativeSelect } from "./ui/native-select.js";
import type { ObservationResource } from "./sync-placement.js";

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
  const { projectId } = p;
  const lifecycleLoader = useCallback(
    (signal: AbortSignal) =>
      p.client.read(
        `/api/operator/projects/${projectId}`,
        projectSchema,
        signal,
      ),
    [p.client, projectId],
  );
  const lifecycle = useOperatorResource(
    `${p.session.csrfToken}:${projectId}:lifecycle`,
    lifecycleLoader,
  );
  useHeaderRefresh(p.refreshNonce, () => {
    void lifecycle.refresh();
  });
  const tab = projectTab(p.query),
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
    lifecycle.refresh();
  };
  const readOnly =
    lifecycle.state.data?.data.state !== "live" ||
    lifecycle.state.data.data.project.archived;
  const tabProps = { ...p, readOnly };
  const unsettled = p.drafts
    .unsettledPlacements(projectId)
    .filter((c) => !data?.placements.some((row) => row.taskId === c.taskId));
  if (lifecycle.state.data?.data.state === "deleted")
    return (
      <DeletedProject
        {...p}
        tombstone={lifecycle.state.data.data.tombstone}
        reload={() => {
          void lifecycle.refresh();
          p.refresh();
        }}
      />
    );
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
                href={`/projects/${projectId}/settings${t.id === "general" ? "" : `?tab=${t.id}`}`}
                aria-current={t.id === tab ? "page" : undefined}
              >
                {t.label}
              </a>
            ))}
          </nav>
          {tab === "routing" ? (
            <RoutingTab
              {...tabProps}
              data={data}
              loadedAt={resource.state.fetchedAt}
              refreshConfiguration={refreshConfiguration}
            />
          ) : tab === "permitted-agents" ? (
            <PermittedAgentsTab
              {...tabProps}
              data={data}
              loadedAt={resource.state.fetchedAt}
              refreshConfiguration={refreshConfiguration}
            />
          ) : tab === "repositories" ? (
            <RepositoryTab
              {...tabProps}
              data={data}
              loadedAt={resource.state.fetchedAt}
              refreshConfiguration={refreshConfiguration}
            />
          ) : tab === "source" ? (
            <TaskSourceTab
              key={`${projectId}:${p.query}`}
              {...tabProps}
              data={data}
              query={p.query}
              loadedAt={resource.state.fetchedAt}
              refreshConfiguration={refreshConfiguration}
              observations={observations}
            />
          ) : tab === "delivery" ? (
            <DeliveryTab
              {...tabProps}
              data={data}
              loadedAt={resource.state.fetchedAt}
              refreshConfiguration={refreshConfiguration}
            />
          ) : tab === "instruction-proposals" ? (
            <InstructionProposalsTab
              key={projectId}
              {...tabProps}
              data={data}
              loadedAt={resource.state.fetchedAt}
              refreshConfiguration={refreshConfiguration}
            />
          ) : tab === "sync" ? (
            <SyncTab
              {...tabProps}
              data={data}
              loadedAt={resource.state.fetchedAt}
              refreshConfiguration={refreshConfiguration}
              observations={observations}
            />
          ) : (
            <GeneralTab
              {...tabProps}
              data={data}
              loadedAt={resource.state.fetchedAt}
              refreshConfiguration={refreshConfiguration}
            />
          )}
          {lifecycle.state.data?.data.state === "live" && (
            <ProjectLifecyclePanel
              {...p}
              data={lifecycle.state.data.data}
              loadedAt={lifecycle.state.fetchedAt}
              reload={refreshConfiguration}
            />
          )}
        </>
      )}
    </div>
  );
}

function TaskSourceTab(
  p: TabProps & { query: string; observations: ObservationResource },
) {
  const trackerId = useId();
  const locked = p.data.source.selections.length > 0;
  const saved = p.data.source.tracker === "jira" ? "jira" : "github";
  const preferred =
    !locked && new URLSearchParams(p.query).get("tracker") === "jira"
      ? "jira"
      : saved;
  const [choice, setChoice] = useState({
    version: p.data.source.version,
    tracker: preferred,
  });
  const tracker = locked
    ? saved
    : choice.version === p.data.source.version
      ? choice.tracker
      : preferred;
  return (
    <>
      <Panel
        title="Task source"
        description="Choose the issue tracker that supplies this project's tasks. Repository code hosts are configured separately."
      >
        <label className="field body" htmlFor={trackerId}>
          <span>Issue tracker</span>
          <NativeSelect
            id={trackerId}
            aria-label="Issue tracker"
            className="control"
            value={tracker}
            disabled={locked || p.readOnly}
            onChange={(e) =>
              setChoice({
                version: p.data.source.version,
                tracker: e.target.value,
              })
            }
            aria-describedby="tracker-choice-note"
          >
            <option value="github">GitHub</option>
            <option value="jira">Jira Cloud</option>
          </NativeSelect>
        </label>
        <p id="tracker-choice-note" className="metadata muted">
          {locked
            ? `Current tracker: ${saved === "jira" ? "Jira Cloud" : "GitHub"}. Remove all saved selections, including inactive ones, before changing tracker. Imported tasks also prevent a tracker change.`
            : "The tracker is recorded when you save its source configuration. Imported tasks prevent a tracker change."}
        </p>
      </Panel>
      {tracker === "jira" ? <JiraSourceTab {...p} /> : <SourceTab {...p} />}
    </>
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
  if (tab === "permitted-agents")
    return withSaved(
      admission,
      saved("permitted-agents", data.routing.version),
    );
  if (tab === "repositories")
    return withSaved(
      "Repository links are the checkouts workspaces and delivery use.",
      saved("repositories.configure", data.repositories.version),
    );
  if (tab === "delivery")
    return withSaved(
      data.delivery?.credentialConfigured
        ? "Delivery credential configured."
        : "No delivery credential configured.",
      data.delivery ? saved("delivery.configure", data.delivery.version) : null,
    );
  if (tab === "source")
    return [
      saved(
        data.source.tracker === "jira" ? "jira.configure" : "github.configure",
        data.source.version,
      ),
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

/** Phone-first summary: what is true now and the next step. Hidden on desktop. */
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
          <a href={`/projects/${projectId}/settings?tab=source`}>
            Set or change source credential
          </a>
        )}
        {next === readinessNextStep && (
          <a
            href={`/projects/${projectId}/settings?tab=source#${readinessAnchor}`}
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
    d = useDraft(p.drafts, draftKey, p.readOnly);
  const initial: Values = {
    name: data.project.name ?? "",
    leadProfileId: data.project.leadProfileId ?? "",
    paused: data.project.paused,
    ...(data.commandNetworkAccess === undefined
      ? {}
      : { commandNetworkAccess: data.commandNetworkAccess }),
    ...(data.localListening === undefined
      ? {}
      : { localListening: data.localListening }),
    ...(data.dangerouslySkipSandbox === undefined
      ? {}
      : { dangerouslySkipSandbox: data.dangerouslySkipSandbox }),
    ...(data.diagnosticCapture === undefined
      ? {}
      : { diagnosticCapture: data.diagnosticCapture }),
    ...(data.reasoningSummaries === undefined
      ? {}
      : { reasoningSummaries: data.reasoningSummaries }),
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
    ...(data.localListening !== undefined &&
    Boolean(v.localListening) !== data.localListening
      ? { localListening: Boolean(v.localListening) }
      : {}),
    ...(data.dangerouslySkipSandbox !== undefined &&
    Boolean(v.dangerouslySkipSandbox) !== data.dangerouslySkipSandbox
      ? { dangerouslySkipSandbox: Boolean(v.dangerouslySkipSandbox) }
      : {}),
    ...(data.diagnosticCapture !== undefined &&
    v.diagnosticCapture !== data.diagnosticCapture
      ? { diagnosticCapture: v.diagnosticCapture }
      : {}),
    ...(data.reasoningSummaries !== undefined &&
    v.diagnosticCapture !== "baseline" &&
    Boolean(v.reasoningSummaries) !== data.reasoningSummaries
      ? { reasoningSummaries: Boolean(v.reasoningSummaries) }
      : {}),
    ...privateField("instructions", v.instructions, revealed),
  });
  const [confirmSkip, setConfirmSkip] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  const skipping = data.dangerouslySkipSandbox === true;
  const turnsOnSkip =
    data.dangerouslySkipSandbox === false && Boolean(v.dangerouslySkipSandbox);
  return (
    <div className="settings-split">
      <div className="settings-column">
        <Panel title="General" description="Each section saves on its own.">
          <form
            ref={form}
            onSubmit={(e) => {
              // Turning the sandbox off for the project needs an explicit confirmation first.
              if (turnsOnSkip && !holdSave && !d.readOnly) {
                e.preventDefault();
                setConfirmSkip(true);
                return;
              }
              void submitDraft(
                e,
                d,
                p.client,
                p.session,
                command(),
                p.refreshConfiguration,
                {},
                holdSave,
              );
            }}
          >
            <div className="settings-fields">
              <DraftField draft={d} field="name" label="Project name" />
              <DraftField draft={d} field="leadProfileId" label="Lead agent">
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
                  {skipping && ` ${skipSandboxSupersededLine}`}
                </p>
              </>
            )}
            {data.localListening !== undefined && (
              <>
                <DraftCheck
                  draft={d}
                  field="localListening"
                  label="Local listening"
                  toggle
                />
                <p className="metadata muted">
                  {projectLocalListeningLine(data.localListening)}{" "}
                  {localListeningAppliesNote} {localListeningLimit}
                  {skipping && ` ${skipSandboxSupersededLine}`}
                </p>
              </>
            )}
            {data.dangerouslySkipSandbox !== undefined && (
              <>
                <DraftCheck
                  draft={d}
                  field="dangerouslySkipSandbox"
                  label="Skip sandbox (dangerous)"
                  toggle
                />
                <p className="metadata muted">
                  {projectSkipSandboxLine(data.dangerouslySkipSandbox)}{" "}
                  {skipSandboxAppliesNote} {skipSandboxGrantLines.join(" ")}{" "}
                  {skipSandboxRisk}
                </p>
              </>
            )}
            {data.diagnosticCapture === undefined ? (
              // No control: nothing may look selected when the service does not report a mode.
              <p className="body">
                Diagnostic capture: <strong>Not reported</strong>
              </p>
            ) : (
              <DraftField
                draft={d}
                field="diagnosticCapture"
                label="Diagnostic capture"
              >
                {Object.entries(diagnosticCaptureLabels).map(([id, label]) => (
                  <option key={id} value={id}>
                    {label}
                  </option>
                ))}
              </DraftField>
            )}
            <p className="metadata muted">
              {diagnosticCaptureLine(data.diagnosticCapture)}
              {data.diagnosticCapture && ` ${diagnosticCaptureAppliesNote}`}
            </p>
            {data.reasoningSummaries !== undefined && (
              <>
                <DraftCheck
                  draft={d}
                  field="reasoningSummaries"
                  label="Reasoning summaries"
                  toggle
                  checked={
                    v.diagnosticCapture === "baseline"
                      ? false
                      : Boolean(v.reasoningSummaries)
                  }
                  disabled={v.diagnosticCapture !== "enhanced"}
                />
                <p className="metadata muted">
                  {v.diagnosticCapture !== "enhanced" &&
                    "Requires enhanced diagnostic capture. Saving Baseline turns this setting off. "}
                  Applies to later admitted turns. Runtime reasoning capture is
                  not implemented; no reasoning is collected.
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
          {data.reasoningSummaries !== undefined && <DeleteReasoning {...p} />}
          <Dialog open={confirmSkip} onOpenChange={setConfirmSkip}>
            <DialogContent role="alertdialog" className="stop-dialog">
              <DialogTitle>Skip the sandbox for this project?</DialogTitle>
              <DialogDescription className="body">
                {skipSandboxRisk} {skipSandboxAppliesNote}
              </DialogDescription>
              <div className="stop-dialog-actions">
                <Button
                  type="button"
                  variant="destructive"
                  onClick={() => {
                    setConfirmSkip(false);
                    if (form.current)
                      void sendDraft(
                        form.current,
                        d,
                        p.client,
                        p.session,
                        command(),
                        p.refreshConfiguration,
                      );
                  }}
                >
                  Skip sandbox
                </Button>
                <DialogClose asChild>
                  <Button type="button" variant="secondary">
                    Cancel
                  </Button>
                </DialogClose>
              </div>
            </DialogContent>
          </Dialog>
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
            <a key="tasks" href={`/projects/${projectId}`}>
              Project tasks
            </a>,
          ]}
        />
      </div>
    </div>
  );
}

function DeleteReasoning(p: TabProps) {
  const [open, setOpen] = useState(false);
  const d = useDraft(
    p.drafts,
    `project.reasoning.delete:${p.projectId}`,
    p.readOnly,
  );
  const initial = { expectedVersion: String(p.data.project.version) };
  useLoadedDraft(d, initial, p.loadedAt);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next && !locked(d)) reloadDraft(d, initial);
        setOpen(next);
      }}
    >
      <DialogTrigger asChild>
        <Button type="button" variant="secondary" disabled={p.readOnly}>
          Delete collected reasoning…
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogTitle>Delete collected reasoning?</DialogTitle>
        <DialogDescription>
          Deletes this project's collected reasoning summaries. This cannot be
          undone. The setting stays unchanged. No reasoning is collected yet, so
          there is currently nothing to erase.
        </DialogDescription>
        <form
          onSubmit={(e) =>
            void submitDraft(
              e,
              d,
              p.client,
              p.session,
              {
                type: "project.reasoning.delete",
                key: d.values.key,
                projectId: p.projectId,
                expectedVersion: Number(d.values.expectedVersion),
                confirmed: true,
              },
              p.refreshConfiguration,
            )
          }
        >
          <DraftOutcome
            draft={d}
            client={p.client}
            session={p.session}
            label="Delete collected reasoning"
            success="Collected reasoning cleared."
            refresh={p.refreshConfiguration}
            review={() => d.adoptLatest(p.data.project.version, initial)}
          />
        </form>
        <DialogClose asChild>
          <Button type="button" variant="secondary">
            Close
          </Button>
        </DialogClose>
      </DialogContent>
    </Dialog>
  );
}

function CredentialReferences({
  projectId,
  data,
}: {
  projectId: string;
  data: ProjectConfigurationData;
}) {
  const page = `/projects/${projectId}/settings`;
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
      description="Routing uses env:NAME. GitHub sources accept a GitHub CLI login or env:NAME; Jira uses site credentials. Values stay server-side."
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
        `Task source · ${data.source.tracker === "jira" ? "Jira Cloud" : "GitHub"}`,
        sourceCredentialSummary(data.source),
        source,
        `${page}?tab=source`,
        "Change in Task source",
      )}
      {row(
        "Delivery policy, authority grants and required checks",
        "Edit policy and scoped authority in Delivery",
        null,
        `${page}?tab=delivery`,
        "Change in Delivery",
      )}
    </Panel>
  );
}
