import type { OperatorCommand } from "../../src/operator/contracts.js";
import type { z } from "zod";
import type { sourceObservationSchema } from "../../src/operator/contracts.js";
import { useEffect, useState } from "react";
import { Button, ResourceStatus, StatusBadge } from "./components.js";
import type { ResourceState } from "./resource.js";
import type { TabProps } from "./project-config.js";
import type { ProjectConfigurationData } from "./settings-changes.js";
import type { ConfigurationDraft } from "./settings-state.js";
import {
  activationLine,
  observationLabel,
  sourceCredentialCopy,
} from "./settings-view.js";
import {
  DraftField,
  DraftMessage,
  DraftOutcome,
  Panel,
  key,
  submitDraft,
  useDraft,
  useLoadedDraft,
  type SettingsProps,
} from "./settings.js";

type Observations = z.infer<typeof sourceObservationSchema>;
interface ObservationResource {
  state: ResourceState<Observations>;
  refresh: () => void;
}

/** The one saved line of a recorded placement, in plain words. */
const placedLine = (d: ConfigurationDraft) =>
  `Saved. ${d.values.placementTitle || "The task"} now belongs to ${d.values.placementProject || "the chosen project"}.`;

export function SyncTab(p: TabProps & { observations: ObservationResource }) {
  const { data } = p,
    preview = useDraft(p.drafts, `github.preview:${p.projectId}`);
  // After a preview is recorded the next read starts a new one, so the form never stays locked.
  useLoadedDraft(
    preview,
    {
      expectedVersion: String(data.source.version),
      selectionId: data.source.selections.find((s) => s.id !== null)?.id ?? "",
      // The receipt can't say whether a selection was already active, so the save keeps
      // what the page showed when it was submitted.
      activeSelectionIds: data.source.selections.flatMap((s) =>
        s.active && s.id !== null ? [s.id] : [],
      ),
    },
    p.loadedAt,
  );
  const saved = p.drafts.saved(`github.preview:${p.projectId}`),
    activation = activationLine({
      saved,
      sourceVersion: data.source.version,
      selections: data.source.selections,
      recorded: preview.phase === "recorded",
    });
  const unsettled = p.drafts
    .unsettledPlacements(p.projectId)
    .filter((c) => !data.placements.some((row) => row.taskId === c.taskId));
  return (
    <div className="settings-split settings-split-even">
      <div className="settings-column">
        <Panel
          title="Preview and activation"
          description="Previewing a source checks it against GitHub and activates it. Activation doesn't import tasks or prove a successful sync."
        >
          {data.source.credential && !data.source.credential.usable && (
            <p className="body" role="alert">
              {sourceCredentialCopy(data.source.credential.reason)}{" "}
              <a href={`/app/projects/${p.projectId}/settings?tab=github`}>
                Set or change source credential
              </a>
            </p>
          )}
          <form
            onSubmit={(e) =>
              void submitDraft(
                e,
                preview,
                p.client,
                p.session,
                {
                  type: "github.preview",
                  key: preview.values.key,
                  projectId: p.projectId,
                  selectionId: preview.values.selectionId,
                  expectedVersion: Number(preview.values.expectedVersion),
                },
                p.refreshConfiguration,
              )
            }
          >
            <DraftField
              draft={preview}
              field="selectionId"
              label="Selection to preview"
            >
              <option value="">Choose selection</option>
              {data.source.selections
                .filter((s) => s.id !== null)
                .map((s) => (
                  <option value={s.id ?? ""} key={s.id}>
                    {s.id} ({s.kind === "project" ? "GitHub Project" : s.kind})
                    {" · "}
                    {s.active ? "active" : "inactive"}
                  </option>
                ))}
            </DraftField>
            <DraftOutcome
              draft={preview}
              client={p.client}
              session={p.session}
              label="Preview and activate selection"
              saveDisabled={data.source.credential?.usable === false}
              refresh={p.refreshConfiguration}
              review={() => preview.adoptVersion(data.source.version)}
              success={activation ? activation.line : null}
            >
              {activation?.refresh && <RefreshObservations {...p} />}
            </DraftOutcome>
            {preview.phase === "conflict" && preview.errors.credentialRef && (
              <a href={`/app/projects/${p.projectId}/settings?tab=github`}>
                Set or change source credential
              </a>
            )}
          </form>
        </Panel>
        <SourceObservations {...p} />
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
/** The next step of an activation: one request for observations, then a read of them. */
function RefreshObservations(
  p: SettingsProps & { observations: ObservationResource },
) {
  const [notice, setNotice] = useState(""),
    [pending, setPending] = useState(false);
  return (
    <>
      <Button
        type="button"
        variant="secondary"
        disabled={pending}
        onClick={async () => {
          setPending(true);
          setNotice("Observation refresh requested.");
          try {
            await p.client.refreshSources(p.session.csrfToken);
            setNotice("Observation request completed.");
            p.observations.refresh();
          } catch {
            setNotice(
              "Observation refresh unconfirmed. Read observations again or deliberately request another refresh.",
            );
          } finally {
            setPending(false);
          }
        }}
      >
        Refresh source observations
      </Button>
      {notice && <p className="body">{notice}</p>}
    </>
  );
}
function SourceObservations(
  p: SettingsProps & {
    projectId: string;
    data: ProjectConfigurationData;
    observations: ObservationResource;
  },
) {
  const resource = p.observations,
    [notice, setNotice] = useState(""),
    [pending, setPending] = useState(false);
  // Withheld ids all read null, so a null never identifies one configuration row.
  const selection = (id: string | null) =>
    id === null ? undefined : p.data.source.selections.find((s) => s.id === id);
  const descriptor = (id: string | null) => selection(id)?.descriptor;
  return (
    <Panel
      title="Source observations"
      description="Refresh requests observations for all enabled sources in this installation. An attempt is separate from successful provider sync; it creates no domain receipt."
    >
      <ResourceStatus
        label="Source observations"
        state={resource.state}
        retry={resource.refresh}
      />
      {resource.state.data?.data.projects
        .find((r) => r.projectId === p.projectId)
        ?.selections.map((s, i) => (
          <article className="settings-row" key={s.selectionId ?? i}>
            <div className="settings-row-heading">
              <div>
                <h3 className="small-heading">
                  {[
                    s.selectionId ?? "Selection unavailable",
                    descriptor(s.selectionId),
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </h3>
                <p className="body">
                  {s.selectionId ?? "Selection unavailable"}: {s.state}. Newest
                  attempt: {s.lastAttemptAt ?? "unavailable"}. Successful sync:{" "}
                  {s.lastSuccessfulAt ?? "unavailable"}.
                </p>
              </div>
              <StatusBadge>{observationLabel(s)}</StatusBadge>
              {selection(s.selectionId) && (
                <StatusBadge>
                  {selection(s.selectionId)?.active ? "Active" : "Inactive"}
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
          </article>
        ))}
      <Button
        type="button"
        variant="secondary"
        disabled={pending}
        onClick={async () => {
          setPending(true);
          setNotice("Observation refresh requested.");
          try {
            await p.client.refreshSources(p.session.csrfToken);
            setNotice(
              "Observation request completed. Review complete, partial and unavailable states below.",
            );
            resource.refresh();
          } catch {
            setNotice(
              "Observation refresh unconfirmed. Read observations again or deliberately request another refresh.",
            );
          } finally {
            setPending(false);
          }
        }}
      >
        Request installation-wide source observations
      </Button>
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
    <Panel title="Placement submission outcome">
      <p className="body">
        Original project {p.command.projectId}, task {p.command.taskId},
        submitted task version {p.command.expectedVersion}, chosen project{" "}
        {p.command.chosenProjectId}. Current conflict observations cannot
        confirm this submission.
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
    d = useDraft(p.drafts, `github.place:${c.taskId}`);
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
        Matched by{" "}
        {c.choices.map((r) => r.name ?? "Name unavailable").join(" and ")}. New
        work is held until you choose its project. Permissions are never
        combined.
      </p>
      <form
        onSubmit={(e) => {
          d.set("placementOriginProjectId", p.projectId);
          // The conflict row is gone once this is recorded, so keep the words for the saved line.
          d.set("placementTitle", c.title ?? "");
          d.set(
            "placementProject",
            c.choices.find((r) => r.id === d.values.chosenProjectId)?.name ??
              "",
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
              {r.name ?? "Name unavailable"}
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
