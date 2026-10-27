import type { OperatorCommand } from "../../src/operator/contracts.js";
import type { z } from "zod";
import type { sourceObservationSchema } from "../../src/operator/contracts.js";
import { useEffect, useState } from "react";
import { CircleCheck } from "lucide-react";
import { Button, ResourceStatus, StatusBadge } from "./components.js";
import { ObservationCounts } from "./observation-counts.js";
import type { ResourceState } from "./resource.js";
import type { TabProps } from "./project-config.js";
import type { ProjectConfigurationData } from "./settings-changes.js";
import {
  projectLabel,
  workspaceLabels,
} from "../../src/operator/project-labels.js";
import type { ConfigurationDraft } from "./settings-state.js";
import { OutcomeDetails } from "./action-feedback.js";
import { credentialReasonId, ImportPanel } from "./source-import.js";
import { Alert } from "./ui/alert.js";
import {
  SourceHeading,
  sourceDetails,
  useSavedSourceNames,
} from "./source-names.js";
import {
  type SourceNaming,
  sourceCredentialCopy,
  sourceStatusLine,
} from "./settings-view.js";
import {
  DraftField,
  DraftMessage,
  DraftOutcome,
  Panel,
  key,
  submitDraft,
  useDraft,
  type SettingsProps,
} from "./settings.js";

type Observations = z.infer<typeof sourceObservationSchema>;
export interface ObservationResource {
  state: ResourceState<Observations>;
  refresh: () => void;
}

/** The one saved line of a recorded placement, in plain words. */
const placedLine = (d: ConfigurationDraft) =>
  `Saved. ${d.values.placementTitle || "The task"} now belongs to ${d.values.placementProject || "the chosen project"}.`;

export function SyncTab(p: TabProps & { observations: ObservationResource }) {
  const { data } = p,
    naming = useSavedSourceNames(p);
  const unsettled = p.drafts
    .unsettledPlacements(p.projectId)
    .filter((c) => !data.placements.some((row) => row.taskId === c.taskId));
  return (
    <div className="settings-split settings-split-even">
      <div className="settings-column">
        {data.source.credential?.usable === false && (
          <Alert role="alert" id={credentialReasonId}>
            {sourceCredentialCopy(data.source.credential.reason)}{" "}
            <a href={`/app/projects/${p.projectId}/settings?tab=github`}>
              Set or change source credential
            </a>
          </Alert>
        )}
        <ImportPanel
          {...p}
          naming={naming}
          quiet
          saved={false}
          savePhase="editing"
          inactiveOnly
        />
        <SourceObservations {...p} naming={naming} />
      </div>
      <div className="settings-column">
        {data.placements.map((c) => (
          <PlacementConfiguration key={c.taskId} {...p} placement={c} />
        ))}
        {unsettled.map((command) => (
          <UnsettledPlacement key={command.taskId} {...p} command={command} />
        ))}
        {p.drafts
          .recordedPlacements(p.projectId)
          // A task still listed here shows its line on its own row, so each saves once.
          .filter(
            (placed) =>
              !data.placements.some(
                (row) =>
                  placed.frozen?.type === "github.place" &&
                  row.taskId === placed.frozen.taskId,
              ),
          )
          .map((placed) => (
            <DraftMessage
              key={placed.receipt?.key}
              draft={placed}
              success={placedLine(placed)}
            />
          ))}
        {data.placements.length === 0 && unsettled.length === 0 && (
          <Panel
            title="Source placement"
            description="No task is matched by more than one project, and no placement outcome is waiting to be checked."
          />
        )}
      </div>
    </div>
  );
}
function SourceObservations(
  p: SettingsProps & {
    projectId: string;
    data: ProjectConfigurationData;
    observations: ObservationResource;
    naming: (
      s: ProjectConfigurationData["source"]["selections"][number],
    ) => SourceNaming;
  },
) {
  const resource = p.observations,
    [notice, setNotice] = useState(""),
    [pending, setPending] = useState(false);
  // Withheld ids all read null, so a null never identifies one configuration row.
  const selection = (id: string | null) =>
    id === null ? undefined : p.data.source.selections.find((s) => s.id === id);
  const observed = resource.state.data?.data.projects.find(
    (r) => r.projectId === p.projectId,
  );
  return (
    <Panel
      title="Source sync"
      description="Refresh checks every enabled source in this installation."
    >
      <ResourceStatus
        label="Sources"
        state={resource.state}
        retry={resource.refresh}
      />
      {observed?.selections.map((s, i) => {
        const saved = selection(s.selectionId),
          naming = saved
            ? p.naming(saved)
            : { name: "Selection unavailable", kind: "", private: false },
          details = sourceDetails(
            {
              id: s.selectionId,
              kind: saved?.kind ?? "",
              descriptor: saved?.descriptor ?? null,
            },
            naming,
            s,
            observed.readiness,
          );
        return (
          <article className="settings-row" key={s.selectionId ?? i}>
            <div className="settings-row-heading">
              <div>
                <h3 className="small-heading">
                  <SourceHeading naming={naming} />
                </h3>
                <p className="body">
                  {sourceStatusLine(s, observed.readiness)}
                </p>
              </div>
              {saved && (
                <StatusBadge
                  tone="idle"
                  icon={saved.active ? CircleCheck : undefined}
                >
                  {saved.active ? "Active" : "Inactive"}
                </StatusBadge>
              )}
              {s.credentialReason && (
                <p className="body">
                  {sourceCredentialCopy(s.credentialReason)}{" "}
                  <a href={`/app/projects/${p.projectId}/settings?tab=github`}>
                    Set or change source credential
                  </a>
                </p>
              )}
            </div>
            <OutcomeDetails fields={details} />
            <ObservationCounts
              warningOnly
              projectId={p.projectId}
              rule={observed.readiness}
              counts={s.counts}
            />
          </article>
        );
      })}
      <Button
        type="button"
        variant="secondary"
        disabled={pending}
        onClick={async () => {
          setPending(true);
          setNotice("Refresh requested.");
          try {
            await p.client.refreshSources(p.session.csrfToken);
            setNotice("Refresh finished. Check each source's state below.");
            resource.refresh();
          } catch {
            setNotice(
              "We couldn't confirm the refresh. Check the sources again before refreshing.",
            );
          } finally {
            setPending(false);
          }
        }}
      >
        Refresh all sources
      </Button>
      <p className="metadata muted">An attempt isn't a successful sync.</p>
      {notice && (
        <p className="body" role="status">
          {notice}
        </p>
      )}
    </Panel>
  );
}
function UnsettledPlacement(
  p: SettingsProps & {
    command: Extract<OperatorCommand, { type: "github.place" }>;
    refreshConfiguration: () => void;
  },
) {
  const d = useDraft(p.drafts, `github.place:${p.command.taskId}`);
  return (
    <Panel title="Placement outcome">
      <p className="body">
        Original project {p.command.projectId}, task {p.command.taskId},
        submitted task version {p.command.expectedVersion}, chosen project{" "}
        {p.command.chosenProjectId}. The current source state can't confirm this
        placement.
      </p>
      <DraftOutcome
        draft={d}
        client={p.client}
        session={p.session}
        label="Placement pending"
        refresh={p.refreshConfiguration}
        success={placedLine(d)}
      />
    </Panel>
  );
}
function PlacementConfiguration(
  p: SettingsProps & {
    projectId: string;
    placement: ProjectConfigurationData["placements"][number];
    refreshConfiguration: () => void;
  },
) {
  const c = p.placement,
    d = useDraft(p.drafts, `github.place:${c.taskId}`),
    labels = workspaceLabels(p.workspace),
    choiceText = (r: (typeof c.choices)[number]) =>
      projectLabel(labels, r.id, r.name).text;
  useEffect(
    () =>
      d.initialize({
        key: key(),
        expectedVersion: String(c.version),
        chosenProjectId: "",
        placementOriginProjectId: p.projectId,
      }),
    [d, c.version, p.projectId],
  );
  return (
    <Panel
      title="Conflicting source placement"
      description={`${c.title ?? "Task title unavailable"}; task version ${c.version}.`}
    >
      <p className="body">
        Matched by {c.choices.map(choiceText).join(" and ")}. New work is held
        until you choose its project. Permissions are never combined.
      </p>
      <form
        onSubmit={(e) => {
          d.set("placementOriginProjectId", p.projectId);
          // The conflict row is gone once this is recorded, so keep the words for the saved line.
          d.set("placementTitle", c.title ?? "");
          d.set(
            "placementProject",
            c.choices
              .filter((r) => r.id === d.values.chosenProjectId)
              .map(choiceText)[0] ?? "",
          );
          void submitDraft(
            e,
            d,
            p.client,
            p.session,
            {
              type: "github.place",
              key: d.values.key,
              projectId: c.projectId,
              taskId: c.taskId,
              chosenProjectId: d.values.chosenProjectId,
              expectedVersion: Number(d.values.expectedVersion),
            },
            p.refreshConfiguration,
          );
        }}
      >
        <DraftField draft={d} field="chosenProjectId" label="Placement project">
          <option value="">Choose actual membership</option>
          {c.choices.map((r) => (
            <option key={r.id} value={r.id}>
              {choiceText(r)}
            </option>
          ))}
        </DraftField>
        <DraftOutcome
          draft={d}
          client={p.client}
          session={p.session}
          label="Record placement"
          refresh={p.refreshConfiguration}
          review={() => d.adoptVersion(c.version)}
          success={placedLine(d)}
        />
        <a href={`/task/${c.taskId}`}>Advanced source review controls</a>
      </form>
      <p className="metadata muted">
        Recording a placement does not start work or grant repository access;
        admission rules still apply.
      </p>
    </Panel>
  );
}
