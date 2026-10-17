import { projectPrivateValuesSchema } from "../../src/operator/contracts.js";
import type { ProjectConfigurationData } from "./settings-changes.js";
import {
  routingChanges,
  routingCommand,
  savedCandidates,
  type Values,
} from "./settings-changes.js";
import { Alert } from "./ui/alert.js";
import { Input } from "./ui/input.js";
import type { TabProps } from "./project-config.js";
import { joinNames } from "./settings-view.js";
import {
  Aside,
  ChangeList,
  DraftCheck,
  DraftOutcome,
  Panel,
  PrivateTextField,
  ReferenceInput,
  locked,
  reloadDraft,
  revealedText,
  submitDraft,
  useDraft,
  useLoadedDraft,
  useNewerPrivateRead,
  usePrivateValues,
} from "./settings.js";

const profileLabel = (r: ProjectConfigurationData["profiles"][number]) =>
  [r.name ?? "Name unavailable", r.summary].filter(Boolean).join(" · ");

/** TypeSafe availability in words (frame 172); disabled is the only state with routing off. */
const availabilityLabel = {
  available: "TypeSafe available",
  "missing-client-credentials": "TypeSafe unavailable",
  "no-eligible-candidates": "No eligible candidates",
  disabled: "Routing off",
} as const;

/** Why routing can't choose and who allocates instead; nothing while it can choose. */
function AvailabilityNotice({ data }: { data: ProjectConfigurationData }) {
  const { availability } = data.routing;
  if (availability === "available") return null;
  // Without a usable lead, unassigned tasks wait (project-lead-unconfigured or -revoked).
  const leadId = data.project.leadProfileId,
    profile = data.profiles.find((r) => r.id === leadId),
    lead =
      leadId !== null && !profile?.revoked
        ? (profile?.name ?? "the lead")
        : null,
    allocate = lead
      ? `New tasks without an assignee go to ${lead} to allocate.`
      : "New tasks without an assignee wait until the project has an available lead.";
  return (
    <Alert variant="warning">
      {availability === "missing-client-credentials" ? (
        <p className="body">
          <strong className="action-outcome-title">
            TypeSafe isn't available for {data.project.name ?? "this project"}.
          </strong>
          {data.routing.credentialConfigured
            ? "Routing can't use its credential reference, so it can't choose assignees."
            : "Routing has no credential reference, so it can't choose assignees."}{" "}
          {allocate}
        </p>
      ) : availability === "no-eligible-candidates" ? (
        <p className="body">
          No candidate profile can be chosen. Add an available profile.{" "}
          {allocate}
        </p>
      ) : (
        <p className="body">
          {lead
            ? `Routing is off. Every new task needs an assignee or goes to ${lead}.`
            : "Routing is off. Every new task needs an assignee or waits until the project has an available lead."}
        </p>
      )}
    </Alert>
  );
}

export function RoutingTab(p: TabProps) {
  const { data, projectId } = p,
    draftKey = `routing.configure:${projectId}`,
    d = useDraft(p.drafts, draftKey);
  const initial: Values = {
    expectedVersion: String(data.routing.version),
    enabled: data.routing.enabled,
    candidateProfileIds: savedCandidates(data),
    referenceMode: "preserve",
    credentialRef: "",
  };
  useLoadedDraft(d, initial, p.loadedAt);
  const priv = usePrivateValues(
    p.client,
    p.session,
    `/api/operator/projects/${projectId}/private-values`,
    projectPrivateValuesSchema,
  );
  const revealed = revealedText(
    priv.state,
    (r) => ({ version: r.data.routing.version, text: r.data.routing.guidance }),
    data.routing.version,
  );
  useNewerPrivateRead(
    data.routing.version,
    priv.state.data?.data.routing.version,
    priv.state.fetchedAt,
    p.refreshConfiguration,
  );
  const lines = routingChanges(data, d.values, revealed);
  const candidates = Array.isArray(d.values.candidateProfileIds)
    ? d.values.candidateProfileIds
    : [];
  const names = (ids: string[]) =>
    ids.map(
      (id) =>
        data.profiles.find((r) => r.id === id)?.name ?? "Name unavailable",
    );
  const used = names(data.routing.candidateProfileIds);
  return (
    <div className="settings-split">
      <div className="settings-column">
        <Panel
          title="Routing"
          description={`${data.routing.enabled ? "Enabled · " : ""}${availabilityLabel[data.routing.availability]} · ${data.routing.credentialConfigured ? "credential configured" : "no credential reference"}`}
        >
          <AvailabilityNotice data={data} />
          <form
            onSubmit={(e) =>
              void submitDraft(
                e,
                d,
                p.client,
                p.session,
                routingCommand(projectId, d.values, data, revealed),
                p.refreshConfiguration,
              )
            }
          >
            <DraftCheck
              draft={d}
              field="enabled"
              label="Enable routing"
              toggle
            />
            <PrivateTextField
              draft={d}
              field="guidance"
              label="Routing guidance"
              noun="routing guidance"
              revealed={revealed}
              state={priv.state}
              onReveal={priv.refresh}
            >
              <p className="metadata muted">
                Private to this signed-in session; revealing is not recorded.
                Guidance is sent to TypeSafe; credentials and transcripts are
                not.
              </p>
            </PrivateTextField>
            <fieldset className="settings-candidates" disabled={locked(d)}>
              <legend className="small-heading">Candidate profiles</legend>
              {data.profiles.map((r) => (
                <label
                  key={r.id}
                  className="check-field body"
                  htmlFor={`candidate-${r.id}`}
                >
                  <Input
                    id={`candidate-${r.id}`}
                    type="checkbox"
                    className="native-check size-5 shrink-0 p-0 accent-foreground"
                    checked={!r.revoked && candidates.includes(r.id)}
                    disabled={r.revoked}
                    onChange={(e) =>
                      d.set(
                        "candidateProfileIds",
                        e.target.checked
                          ? [...candidates, r.id]
                          : candidates.filter((id) => id !== r.id),
                      )
                    }
                  />
                  {profileLabel(r)}
                  {r.revoked ? " (revoked)" : ""}
                </label>
              ))}
            </fieldset>
            <ReferenceInput draft={d} />
            <ChangeList lines={lines} />
            <DraftOutcome
              draft={d}
              client={p.client}
              session={p.session}
              label="Save routing"
              saveDisabled={lines.length === 0}
              discard={() => reloadDraft(d, initial)}
              refresh={p.refreshConfiguration}
              review={() => d.adoptLatest(data.routing.version, initial)}
              success={
                // After the re-read, say what routing now uses; until then the saved line is plain.
                d.phase === "editing" && data.routing.enabled && used.length
                  ? `Saved. Routing now uses ${joinNames(used)}.`
                  : undefined
              }
            />
          </form>
        </Panel>
      </div>
      <div className="settings-column">
        <section className="settings-aside" aria-label="Saved routing">
          <h2 className="small-heading">Saved routing</h2>
          <p className="body">Candidates: {used.join(", ") || "None"}</p>
          <p className="metadata muted">Guidance: kept</p>
        </section>
        <Aside
          title="How routing decides"
          items={[
            "Runs only for new assignments without an explicit assignee. An explicit permitted profile is honoured without TypeSafe.",
            "Missing context, an uncertain recommendation, no suitable candidate or TypeSafe unavailability wakes the lead with the brief and evidence.",
            "Selects for fit, then queues for capacity. A busy profile is not swapped.",
            "In-scope repairs keep their assignee. Routing never grants readiness or authorises execution.",
          ]}
        />
        <Aside
          title="Related"
          items={[
            <a key="advanced" href={`/project/${projectId}`}>
              Advanced routing editor (partial edits)
            </a>,
          ]}
        />
      </div>
    </div>
  );
}
