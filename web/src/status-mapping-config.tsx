import { useCallback, useEffect, useRef, useState } from "react";
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
  type StatusMappingEvent,
} from "../../src/core/status-mapping-contracts.js";
import {
  type FieldRead,
  statusFieldNodeId,
  statusMappingPlan,
} from "./status-mapping-draft.js";
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
const fieldErrorPath = (event: StatusMappingEvent) => `mapping.events.${event}`;

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
  // Option ids belong to one Project: another Project starts from Nothing, the saved one from its mapping.
  const shown = useRef(project);
  // biome-ignore lint/correctness/useExhaustiveDependencies: only a change of the chosen Project resets the options.
  useEffect(() => {
    if (shown.current === project) return;
    shown.current = project;
    for (const e of statusMappingEvents)
      d.set(e, (project === saved?.projectNodeId && saved.events[e]) || "");
  }, [project]);
  const fieldRead: FieldRead =
      read && read.project === project ? read.read : { state: "loading" },
    status = fieldRead.state === "ready" ? fieldRead.status : null,
    fieldNodeId = statusFieldNodeId(fieldRead);
  const granted = new Set(
    view.granted
      .filter((g) => g.projectNodeId === project)
      .flatMap((g) => (g.fieldNodeId === fieldNodeId ? g.optionNodeIds : [])),
  );
  const optionName = (id: string) =>
    status?.options.find((o) => o.optionNodeId === id)?.name ?? id;
  const selectionName = (id: string) => {
      const found = view.selections.find((s) => s.id === id);
      return found ? p.selectionName(found) : id;
    },
    unavailable = view.availability === "unavailable",
    // Without its Project source the saved mapping can only be cleared.
    clearing = unavailable && saved !== null,
    plan = statusMappingPlan({
      saved,
      clearing,
      values: d.values,
      selection,
      fieldNodeId,
      optionName,
      selectionName,
    }),
    lines = plan.lines;
  const command = {
    type: "status-mapping.configure",
    key: d.values.key,
    projectId,
    expectedVersion: Number(d.values.expectedVersion),
    mapping: plan.mapping,
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
              ? "Writes the Project's Status from cab's work events"
              : "Not set · cab does not change the Project's Status"
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
                !plan.ready,
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
            {!clearing && fieldRead.state === "loading" && (
              <p className="metadata muted" role="status">
                Reading this Project's Status options. Nothing can be saved
                until they are listed.
              </p>
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
              saveDisabled={lines.length === 0 || !plan.ready}
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
