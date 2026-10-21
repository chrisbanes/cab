import { useCallback, useEffect, useState } from "react";
import { discoveryProjectFieldsSchema } from "../../src/operator/contracts.js";
import type { ProjectConfigurationData } from "./settings-changes.js";
import {
  statusEventHints,
  statusMappingBoundary,
  statusEventLabels,
  statusMappingCaveat,
} from "../../src/operator/status-mapping-copy.js";
import {
  statusMappingEvents,
  type StatusMapping,
  type StatusMappingEvent,
} from "../../src/core/status-mapping-contracts.js";
import { Alert } from "./ui/alert.js";
import { Button } from "./components.js";
import type { TabProps } from "./project-config.js";
import {
  Aside,
  DraftField,
  DraftOutcome,
  Panel,
  locked,
  reloadDraft,
  submitDraft,
  useDraft,
  useLoadedDraft,
} from "./settings.js";
import type { Values } from "./settings-changes.js";

type StatusView = NonNullable<ProjectConfigurationData["statusMapping"]>;
type Field = {
  fieldNodeId: string;
  name: string;
  options: { optionNodeId: string; name: string }[];
};
/** The Project's single-select `Status` field as GitHub lists it now. */
type FieldRead =
  | { state: "loading" }
  | { state: "unavailable" }
  | { state: "ready"; status: Field | null };

const fieldErrorPath = (event: StatusMappingEvent) => `mapping.events.${event}`;

/** The draft's mapping, or `null` for none: no event names an option. */
export function draftMapping(
  v: Values,
  selection: StatusView["selections"][number] | undefined,
  fieldNodeId: string | undefined,
): StatusMapping | null {
  if (!selection || !fieldNodeId) return null;
  const events = Object.fromEntries(
    statusMappingEvents.map((e) => [e, String(v[e] ?? "") || null]),
  ) as StatusMapping["events"];
  return Object.values(events).every((o) => o === null)
    ? null
    : {
        selectionId: selection.id,
        projectNodeId: selection.projectNodeId,
        fieldNodeId,
        events,
      };
}

/** One line per event whose mapped option changed, naming the options. */
export function statusMappingChanges(
  saved: StatusMapping | null,
  next: StatusMapping | null,
  optionName: (id: string) => string,
  selectionName: (id: string) => string,
): string[] {
  if (!next) return saved ? ["Clears the status mapping."] : [];
  const lines: string[] = [];
  if (saved?.selectionId !== next.selectionId)
    lines.push(`Maps Status of ${selectionName(next.selectionId)}.`);
  for (const event of statusMappingEvents) {
    const was = saved?.events[event] ?? null,
      now = next.events[event];
    if (was !== now)
      lines.push(
        `${statusEventLabels[event]}: ${now ? `sets Status to ${optionName(now)}` : "writes nothing"}.`,
      );
  }
  return lines;
}

export function StatusMappingPanel(
  p: TabProps & {
    view: StatusView;
    /** A Project selection's name: the title discovery lists for it, else its source id. */
    selectionName: (selection: StatusView["selections"][number]) => string;
  },
) {
  const { view, projectId } = p,
    d = useDraft(p.drafts, `status-mapping.configure:${projectId}`),
    saved = view.mapping,
    firstSelection =
      view.selections.find((s) => s.active) ?? view.selections[0],
    initial: Values = {
      expectedVersion: String(view.version),
      selectionId: saved?.selectionId ?? firstSelection?.id ?? "",
      ...Object.fromEntries(
        statusMappingEvents.map((e) => [e, saved?.events[e] ?? ""]),
      ),
    };
  useLoadedDraft(d, initial, p.loadedAt, view);
  const selection = view.selections.find(
      (s) => s.id === String(d.values.selectionId),
    ),
    project = selection?.projectNodeId ?? null,
    [read, setRead] = useState<{ project: string; read: FieldRead }>();
  const [round, setRound] = useState(0);
  // The Status options come from a fresh read of the chosen Project, never from typed text.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-read when the Project, session or a retry changes.
  useEffect(() => {
    if (!project) return;
    let current = true;
    setRead({ project, read: { state: "loading" } });
    p.client
      .read(
        `/api/operator/discovery/project-fields?project=${encodeURIComponent(project)}`,
        discoveryProjectFieldsSchema,
      )
      .then(
        (r) =>
          current &&
          setRead({
            project,
            read:
              r.data.state === "ready"
                ? {
                    state: "ready",
                    status:
                      r.data.fields.find((f) => f.name === "Status") ?? null,
                  }
                : { state: "unavailable" },
          }),
        () => current && setRead({ project, read: { state: "unavailable" } }),
      );
    return () => {
      current = false;
    };
  }, [p.client, p.session.csrfToken, project, round]);
  const fieldRead: FieldRead =
      read && read.project === project ? read.read : { state: "loading" },
    status = fieldRead.state === "ready" ? fieldRead.status : null,
    // A saved mapping keeps its field while GitHub cannot be read.
    fieldNodeId =
      status?.fieldNodeId ??
      (saved && saved.projectNodeId === project
        ? saved.fieldNodeId
        : undefined);
  const granted = new Set(
    view.granted
      .filter((g) => g.projectNodeId === project)
      .flatMap((g) => (g.fieldNodeId === fieldNodeId ? g.optionNodeIds : [])),
  );
  const optionName = (id: string) =>
    status?.options.find((o) => o.optionNodeId === id)?.name ?? id;
  const next = draftMapping(d.values, selection, fieldNodeId),
    selectionName = (id: string) => {
      const found = view.selections.find((s) => s.id === id);
      return found ? p.selectionName(found) : id;
    },
    unavailable = view.availability === "unavailable",
    // Without its Project source the saved mapping can only be cleared.
    clearing = unavailable && saved !== null,
    lines = clearing
      ? ["Clears the status mapping."]
      : statusMappingChanges(saved, next, optionName, selectionName);
  const command = {
    type: "status-mapping.configure",
    key: d.values.key,
    projectId,
    expectedVersion: Number(d.values.expectedVersion),
    mapping: clearing ? null : next,
  };
  // Event and source errors show under their own field; the rest have no field of their own.
  const errorPaths = Object.keys(d.errors).filter(
    (k) =>
      k.startsWith("mapping") &&
      !k.startsWith("mapping.events.") &&
      !(k === "mapping.selectionId" && view.selections.length > 1),
  );
  const retry = useCallback(() => setRound((n) => n + 1), []);
  return (
    <>
      <Panel
        id="status-mapping"
        title="Status mapping"
        description={
          unavailable
            ? "Unavailable · needs a GitHub Project source"
            : saved
              ? "Writes the Project's Status from Ensemble's work events"
              : "Not set · Ensemble does not change the Project's Status"
        }
      >
        {unavailable && (
          <p className="body" role="status">
            {saved
              ? "The saved mapping's Project is no longer one of this project's sources, so nothing is written. Add that Project source again, or clear the mapping."
              : "Status mapping needs a GitHub Project source of this project. Add one under Discovery sources."}
          </p>
        )}
        {(!unavailable || clearing) && (
          <form
            onSubmit={(e) =>
              void submitDraft(
                e,
                d,
                p.client,
                p.session,
                command,
                p.refreshConfiguration,
                {},
                !fieldNodeId && next !== null,
              )
            }
          >
            {!clearing && view.selections.length > 1 && (
              <DraftField
                draft={d}
                field="selectionId"
                errorField="mapping.selectionId"
                label="Project source"
              >
                {view.selections.map((s) => (
                  <option key={s.id} value={s.id}>
                    {p.selectionName(s)}
                  </option>
                ))}
              </DraftField>
            )}
            {!clearing && fieldRead.state === "unavailable" && (
              <Alert variant="warning" role="status">
                GitHub could not list this Project's Status options right now.{" "}
                <Button type="button" variant="secondary" onClick={retry}>
                  Try again
                </Button>
              </Alert>
            )}
            {!clearing && fieldRead.state === "ready" && !status && (
              <Alert variant="warning" role="status">
                This Project has no single-select field named Status, so there
                is nothing to map.
              </Alert>
            )}
            {!clearing && (
              <fieldset className="settings-rows" disabled={locked(d)}>
                <legend className="sr-only">Status for each event</legend>
                {statusMappingEvents.map((event) => {
                  const chosen = String(d.values[event] ?? "");
                  return (
                    <div className="settings-row" key={event}>
                      <DraftField
                        draft={d}
                        field={event}
                        errorField={fieldErrorPath(event)}
                        label={statusEventLabels[event]}
                      >
                        <option value="">Nothing</option>
                        {chosen &&
                          !status?.options.some(
                            (o) => o.optionNodeId === chosen,
                          ) && <option value={chosen}>Saved option</option>}
                        {(status?.options ?? []).map((o) => (
                          <option key={o.optionNodeId} value={o.optionNodeId}>
                            {o.name}
                            {granted.has(o.optionNodeId) ? "" : " (no grant)"}
                          </option>
                        ))}
                      </DraftField>
                      <p className="metadata muted">
                        {statusEventHints[event]}
                      </p>
                    </div>
                  );
                })}
              </fieldset>
            )}
            {errorPaths.length > 0 && (
              <ul className="body error-text" role="alert">
                {errorPaths.map((k) => (
                  <li key={k}>{d.errors[k]}</li>
                ))}
              </ul>
            )}
            <section
              className="settings-changes"
              aria-label="Status mapping changes"
            >
              <h3 className="small-heading">
                Status mapping changes{lines.length ? ` · ${lines.length}` : ""}
              </h3>
              {lines.length ? (
                <ul className="body">
                  {lines.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              ) : (
                <p className="metadata muted">
                  No changes yet. Save is available once something changes.
                </p>
              )}
            </section>
            <DraftOutcome
              draft={d}
              client={p.client}
              session={p.session}
              label={clearing ? "Clear status mapping" : "Save status mapping"}
              saveDisabled={lines.length === 0}
              discard={() => reloadDraft(d, initial)}
              refresh={p.refreshConfiguration}
              review={() => d.adoptLatest(view.version, initial)}
              caveat={statusMappingCaveat}
            />
          </form>
        )}
      </Panel>
      <Aside title="Status mapping boundary" items={statusMappingBoundary} />
    </>
  );
}
