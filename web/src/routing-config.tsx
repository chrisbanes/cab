import type { ProjectConfigurationData } from "./settings-changes.js";
import {
  routingChanges,
  routingCommand,
  savedCandidates,
  type Values,
} from "./settings-changes.js";
import { Input } from "./ui/input.js";
import type { TabProps } from "./project-config.js";
import { joinNames } from "./settings-view.js";
import {
  Aside,
  ChangeList,
  DraftCheck,
  DraftField,
  DraftOutcome,
  Panel,
  ReferenceInput,
  locked,
  reloadDraft,
  submitDraft,
  useDraft,
  useLoadedDraft,
} from "./settings.js";

const profileLabel = (r: ProjectConfigurationData["profiles"][number]) =>
  [r.name ?? "Name unavailable", r.summary].filter(Boolean).join(" · ");

export function RoutingTab(p: TabProps) {
  const { data, projectId } = p,
    draftKey = `routing.configure:${projectId}`,
    d = useDraft(p.drafts, draftKey);
  const initial: Values = {
    expectedVersion: String(data.routing.version),
    enabled: data.routing.enabled,
    candidateProfileIds: savedCandidates(data),
    replaceGuidance: false,
    guidance: "",
    referenceMode: "preserve",
    credentialRef: "",
  };
  useLoadedDraft(d, initial, p.loadedAt);
  const lines = routingChanges(data, d.values);
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
          description={`${data.routing.enabled ? "Enabled" : "Disabled"} · availability ${data.routing.availability} · credential ${data.routing.credentialConfigured ? "configured" : "unconfigured"}`}
        >
          <form
            onSubmit={(e) =>
              void submitDraft(
                e,
                d,
                p.client,
                p.session,
                routingCommand(projectId, d.values, data),
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
            <DraftCheck
              draft={d}
              field="replaceGuidance"
              label="Replace routing guidance"
            />
            <p className="metadata muted">
              Current guidance is private and never loaded into this form.
              Guidance is sent to TypeSafe; credentials and transcripts are not.
            </p>
            {d.values.replaceGuidance && (
              <DraftField
                draft={d}
                field="guidance"
                label="New routing guidance"
                multiline
              />
            )}
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
          <p className="metadata muted">
            Guidance: private · not loaded into this form
          </p>
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
