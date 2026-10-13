import { useCallback, useEffect, useId, useRef } from "react";
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

  const read: ReadinessRead = readiness.state.error
    ? { state: "unavailable" }
    : readiness.state.data
      ? { state: "ready", checks: readiness.state.data.data.checks }
      : { state: "loading" };
  const { items, checking, blocked, capacityFull } = readyCheckItems({
    leadProfileId: created.leadProfileId ?? null,
    workspace: p.workspace?.data ?? null,
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
        {checking && <p className="metadata muted">Checking readiness…</p>}
        {items.length > 0 && (
          <ul className="body">
            {items.map((item) => (
              <li key={item.text}>
                {item.text}
                {item.fix && <p className="identifier">{item.fix}</p>}
                {item.link && (
                  <ActionLink variant="secondary" href={item.link.href}>
                    {item.link.label}
                  </ActionLink>
                )}
              </li>
            ))}
          </ul>
        )}
        {read.state === "unavailable" && (
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              void readiness.refresh();
              // Retry leaves while it reads, so the focus moves to the result.
              waitsRoot.current?.focus();
            }}
          >
            Retry
          </Button>
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
          if (latest.data.project.paused)
            resume.adoptVersion(latest.data.project.version);
          else open();
        }}
      />
    </section>
  );
}
