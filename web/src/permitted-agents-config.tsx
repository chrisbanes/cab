import { type Values, savedCandidates } from "./settings-changes.js";
import { Input } from "./ui/input.js";
import type { TabProps } from "./project-config.js";
import {
  ChangeList,
  DraftOutcome,
  Panel,
  locked,
  reloadDraft,
  submitDraft,
  useDraft,
  useLoadedDraft,
} from "./settings.js";

export function PermittedAgentsTab(p: TabProps) {
  const { data, projectId } = p,
    d = useDraft(p.drafts, `permitted-agents:${projectId}`, p.readOnly),
    initial: Values = {
      expectedVersion: String(data.routing.version),
      candidateProfileIds: savedCandidates(data),
    };
  useLoadedDraft(d, initial, p.loadedAt);
  const permitted = Array.isArray(d.values.candidateProfileIds)
      ? d.values.candidateProfileIds
      : [],
    current = savedCandidates(data),
    lines = [
      ...permitted
        .filter((id) => !current.includes(id))
        .map(
          (id) =>
            `Agent added: ${data.profiles.find((r) => r.id === id)?.name ?? "Name unavailable"}`,
        ),
      ...current
        .filter((id) => !permitted.includes(id))
        .map(
          (id) =>
            `Agent removed: ${data.profiles.find((r) => r.id === id)?.name ?? "Name unavailable"}`,
        ),
    ];
  return (
    <Panel
      title="Permitted agents"
      description="These are the agents the project lead may delegate to, whether routing is on or off. Routing chooses only from this list."
    >
      <form
        onSubmit={(e) =>
          void submitDraft(
            e,
            d,
            p.client,
            p.session,
            {
              type: "routing.configure",
              key: d.values.key,
              projectId,
              expectedVersion: Number(d.values.expectedVersion),
              enabled: data.routing.enabled,
              candidateProfileIds: permitted.filter(
                (id) => !data.profiles.find((r) => r.id === id)?.revoked,
              ),
            },
            p.refreshConfiguration,
          )
        }
      >
        <fieldset className="settings-candidates" disabled={locked(d)}>
          <legend className="small-heading">Permitted agents</legend>
          {data.profiles.map((r) => (
            <label
              key={r.id}
              className="check-field body"
              htmlFor={`permitted-${r.id}`}
            >
              <Input
                id={`permitted-${r.id}`}
                type="checkbox"
                className="native-check size-5 shrink-0 p-0 accent-foreground"
                checked={!r.revoked && permitted.includes(r.id)}
                disabled={r.revoked}
                onChange={(e) =>
                  d.set(
                    "candidateProfileIds",
                    e.target.checked
                      ? [...permitted, r.id]
                      : permitted.filter((id) => id !== r.id),
                  )
                }
              />
              {[r.name ?? "Name unavailable", r.summary]
                .filter(Boolean)
                .join(" · ")}
              {r.revoked ? " (revoked)" : ""}
            </label>
          ))}
        </fieldset>
        <ChangeList lines={lines} />
        <DraftOutcome
          draft={d}
          client={p.client}
          session={p.session}
          label="Save permitted agents"
          saveDisabled={lines.length === 0}
          discard={() => reloadDraft(d, initial)}
          refresh={p.refreshConfiguration}
          review={() => d.adoptLatest(data.routing.version, initial)}
        />
      </form>
    </Panel>
  );
}
