import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  composerOptionsSchema,
  type OperatorCommand,
  projectConfigurationSchema,
} from "../../src/operator/contracts.js";
import { readinessSchema } from "../../src/operator/readiness.js";
import { ActionLink, Button } from "./components.js";
import { useOperatorResource } from "./resource.js";
import { DraftMessage, key, type SettingsProps, useDraft } from "./settings.js";
import { type ReadinessRead, readyCheckItems } from "./setup-model.js";
import type { ConfigurationDraft } from "./settings-state.js";

/** Frames 146–147: what creation saved, what would make work wait, and Resume or Keep paused. */
export function ReadyCheck({
  settings: p,
  draft,
  created,
  navigate,
}: {
  settings: SettingsProps;
  /** The recorded `project.create` draft; its confirmation heads the check. */
  draft: ConfigurationDraft;
  created: Extract<OperatorCommand, { type: "project.create" }>;
  navigate: (href: string) => void;
}) {
  const { projectId } = created;
  // The project's current lead, which another tab may change while this check is open.
  const [lead, setLead] = useState(created.leadProfileId ?? null);
  // Server time of the last conflict review: nothing read before it may unlock Resume.
  const [since, setSince] = useState(0);
  const csrf = p.session.csrfToken;
  const scope = `${csrf}:${projectId}`;
  const readiness = useOperatorResource(
    scope,
    useCallback(
      (signal: AbortSignal) =>
        p.client.read("/api/operator/readiness", readinessSchema, signal),
      [p.client],
    ),
  );
  const options = useOperatorResource(
    scope,
    useCallback(
      (signal: AbortSignal) =>
        p.client.read(
          `/api/operator/projects/${projectId}/composer-options`,
          composerOptionsSchema,
          signal,
        ),
      [p.client, projectId],
    ),
  );
  // Its own key: the project configuration General tab loads into `project.configure:<id>`.
  const resume = useDraft(p.drafts, `project.resume:${projectId}`);
  // A recorded create is version 1 (see matchesConfigurationReceipt).
  useEffect(
    () => resume.initialize({ key: key(), expectedVersion: "1" }),
    [resume],
  );
  const root = useRef<HTMLElement>(null);
  useEffect(() => root.current?.focus(), []);
  const waitsRoot = useRef<HTMLDivElement>(null);
  const waits = useId();

  // A read from before the last review counts as not read yet, so a failed or superseded
  // re-read keeps the check waiting instead of judging the current lead on old data.
  const read: ReadinessRead = readiness.state.error
    ? { state: "unavailable" }
    : readiness.state.data && readiness.state.data.observedAt >= since
      ? { state: "ready", checks: readiness.state.data.data.checks }
      : { state: "loading" };
  const { items, checking, blocked, capacityFull } = readyCheckItems({
    leadProfileId: lead,
    workspace:
      p.workspace && p.workspace.observedAt >= since ? p.workspace.data : null,
    readiness: read,
    capacity: options.state.data?.data.capacity ?? null,
  });
  const open = () => {
    p.refresh();
    navigate(`/app/tasks/new?project=${encodeURIComponent(projectId)}`);
  };
  const busy = ["pending", "recorded", "conflict"].includes(resume.phase);

  return (
    <section
      ref={root}
      tabIndex={-1}
      className="setup-ready"
      aria-label="Ready check"
    >
      <DraftMessage
        draft={draft}
        success={`Created ${created.name}. It's paused.`}
      >
        <ul className="body setup-recorded">
          <li>Nothing has run.</li>
          <li>
            {created.instructions
              ? "Instructions saved."
              : "No instructions yet."}
          </li>
          <li>
            Repository access:{" "}
            {created.repositories?.length
              ? `${created.repositories
                  .map((r) => `${r.owner}/${r.name} (${r.ref})`)
                  .join(", ")}, checked on this Mac`
              : "none · repository-free"}
            .
          </li>
          {created.githubProject && (
            <li>GitHub Project linked as an inactive discovery source.</li>
          )}
        </ul>
      </DraftMessage>
      <div className="setup-inline-actions">
        {resume.phase !== "unknown" && (
          <Button
            type="button"
            disabled={blocked || busy}
            aria-describedby={blocked ? waits : undefined}
            onClick={async () => {
              await resume.submit(
                p.client,
                {
                  type: "project.configure",
                  key: resume.values.key,
                  projectId,
                  expectedVersion: Number(resume.values.expectedVersion),
                  paused: false,
                },
                csrf,
              );
              if (resume.phase === "recorded") open();
            }}
          >
            {resume.phase === "pending"
              ? "Resuming…"
              : "Resume and create first task"}
          </Button>
        )}
        <ActionLink
          variant="secondary"
          href={`/app/projects/${projectId}/settings`}
        >
          Keep paused
        </ActionLink>
      </div>
      <div ref={waitsRoot} id={waits} tabIndex={-1} className="setup-waits">
        {(checking || readiness.state.pending) && (
          <p className="metadata muted">Checking readiness…</p>
        )}
        {items.length > 0 && (
          <>
            <ul className="body">
              {items.map((item) => (
                <li key={item.text}>
                  {item.text}
                  {item.fix && <p className="identifier">{item.fix}</p>}
                  {item.link && (
                    // A new tab, so this check is still here to check again.
                    <ActionLink
                      variant="secondary"
                      href={item.link.href}
                      target="_blank"
                      rel="noopener"
                    >
                      {item.link.label}
                    </ActionLink>
                  )}
                </li>
              ))}
            </ul>
            <p className="metadata muted">
              {items.some((item) => item.link) && "Links open in a new tab. "}
              Fix the item, then check again here. If you leave this page,
              resume later with the Pause project switch in project
              configuration.
            </p>
            <div>
              <Button
                type="button"
                variant="secondary"
                onClick={() => {
                  void readiness.refresh();
                  void options.refresh();
                  p.refresh();
                  // The result takes focus: the button leaves when a failed read starts again.
                  waitsRoot.current?.focus();
                }}
              >
                Check again
              </Button>
            </div>
          </>
        )}
        {capacityFull && (
          <p className="metadata muted">
            Capacity is full now, so the first task will wait for capacity.
          </p>
        )}
      </div>
      <DraftMessage
        draft={resume}
        success={null}
        check={async () => {
          await resume.reconcile(p.client, csrf);
          if (resume.phase === "recorded") open();
        }}
        review={async () => {
          // A failed read leaves the conflict and its action in place to try again.
          const latest = await p.client
            .read(
              `/api/operator/projects/${projectId}/configuration`,
              projectConfigurationSchema,
            )
            .catch(() => null);
          if (!latest) return;
          const { project } = latest.data;
          if (!project.paused) return open();
          // The lead may have changed too: judge the current one on reads made after this.
          setSince(latest.observedAt);
          setLead(project.leadProfileId);
          void readiness.refresh();
          void options.refresh();
          p.refresh();
          resume.adoptVersion(project.version);
        }}
      />
    </section>
  );
}
