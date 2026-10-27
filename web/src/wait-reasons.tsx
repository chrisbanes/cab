import { useEffect, useRef, useState } from "react";
import {
  projectConfigurationSchema,
  type Session,
  type Workspace,
} from "../../src/operator/contracts.js";
import {
  fixLabels,
  type HoldLine,
  type Wait,
  type WaitLink,
  waitLabels,
} from "../../src/operator/wait-reasons.js";
import type { OperatorClient } from "./api.js";
import { ActionLink, Button, StatusBadge } from "./components.js";
import { DraftMessage, key, useDraft } from "./settings.js";
import type {
  ConfigurationDraft,
  ConfigurationDrafts,
} from "./settings-state.js";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "./ui/dialog.js";
import { waitFixHref } from "./wait-fix-href.js";
import "./wait-reasons.css";

export interface WaitProps {
  client: OperatorClient;
  session: Session;
  drafts: ConfigurationDrafts;
  workspace: Workspace | null;
  /** Re-read whatever shows the waits after Resume project is recorded. */
  onChanged: () => void;
}

const linkHref = (link: WaitLink, taskId: string | null) =>
  link.kind === "task"
    ? `/app/tasks/${link.id}`
    : link.kind === "request"
      ? // Request waits are approvals; they are decided in the task's request view.
        `/app/tasks/${taskId}?request=${encodeURIComponent(link.id)}`
      : link.kind === "source"
        ? link.url
        : link.kind === "recovery"
          ? `/app/assignments/${link.assignmentId}/recovery`
          : "/app/tasks?state=Running&ready=any";

/** An assignment whose recovery page a hold line links. */
export interface RecoveryAssignment {
  assignmentId: string;
  /** Null when the profile name is withheld, as in Settings. */
  name: string | null;
}

/** One wait's Fix, or the links to what blocks it; holds never get a Fix. */
function WaitAction({
  wait,
  taskId,
  primary,
  p,
  resume,
  holds,
}: {
  wait: Wait;
  taskId: string | null;
  primary: boolean;
  p: WaitProps;
  resume: ConfigurationDraft;
  /** Names of the holds that outlast Resume project. */
  holds?: readonly string[] | undefined;
}) {
  const variant = primary ? "primary" : "secondary";
  if (wait.fix?.kind === "resume-project")
    return (
      <ResumeProjectFix
        p={p}
        draft={resume}
        projectId={wait.fix.projectId}
        variant={variant}
        holds={holds}
      />
    );
  if (wait.fix)
    return (
      <ActionLink variant={variant} href={waitFixHref(wait.fix)}>
        Fix: {fixLabels[wait.fix.kind]}
      </ActionLink>
    );
  return (
    <>
      {wait.links.map((link) => (
        <ActionLink
          key={`${link.kind}:${"id" in link ? link.id : "assignmentId" in link ? link.assignmentId : link.label}`}
          variant="secondary"
          href={linkHref(link, taskId)}
        >
          {link.label}
        </ActionLink>
      ))}
    </>
  );
}

/** What a hold has no link for, on its own line under the reason. */
const WaitDetail = ({ wait }: { wait: Wait }) =>
  wait.detail ? (
    <p className="metadata muted wait-detail">{wait.detail}</p>
  ) : null;

/** Holds a Fix leaves in place: what clears each, and where to inspect them. Never a Fix. */
function HoldList({
  lines,
  href,
  assignments,
  heading,
}: {
  lines: readonly HoldLine[];
  href: string;
  assignments: readonly RecoveryAssignment[];
  heading?: string | undefined;
}) {
  return (
    <div className="wait-holds">
      {heading && <p className="metadata muted">{heading}</p>}
      <ul aria-label="Also held">
        {lines.map((line) => (
          <li key={line.kind}>
            <span className="wait-hold-label">{line.label}</span>
            <span className="metadata muted wait-hold-clears">
              {line.clears}
            </span>
            {/* Server-rendered page outside the app shell: a plain anchor loads it as a document. */}
            {assignments.length === 0 ? (
              <a href={href}>Execution details</a>
            ) : (
              assignments.map((a) => (
                <a
                  key={a.assignmentId}
                  href={`/app/assignments/${a.assignmentId}/recovery`}
                >
                  {assignments.length === 1
                    ? "Recovery evidence"
                    : `${a.name ?? "Profile name unavailable"}: recovery evidence`}
                </a>
              ))
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Frames 149–150: the first wait is primary with its Fix; the rest stay listed with
 * their own Fix or link. The Resume project outcome stays after the wait it cleared.
 */
export function WaitReasons({
  waits,
  taskId = null,
  projectId,
  prefix = "Waiting · ",
  variant = "list",
  holds = [],
  executionHref,
  assignments = [],
  ...p
}: WaitProps & {
  waits: readonly Wait[];
  taskId?: string | null;
  projectId: string;
  /** What precedes the first reason, such as "It will wait: ". */
  prefix?: string;
  /** `numbered` (the composer panel, 149c): every reason numbered, each Fix secondary. */
  variant?: "list" | "numbered";
  /** The task's execution holds (list variant only), listed beneath the waits. */
  holds?: readonly HoldLine[];
  /** The task's Execution view: the hold lines' link when the task has no assignment. */
  executionHref?: string;
  /** The task's assignments; each hold line links every one's recovery page. */
  assignments?: readonly RecoveryAssignment[];
}) {
  const [first, ...rest] = waits;
  // One owner for the draft: its store notifies a single listener.
  const resume = useResumeDraft(p, projectId);
  if (variant === "numbered")
    return (
      <div className="wait-reasons">
        {first && (
          <ol className="wait-numbered">
            {waits.map((wait, i) => (
              <li key={wait.code} data-primary={i === 0 ? "true" : undefined}>
                <span className="wait-index" aria-hidden="true">
                  {i + 1}
                </span>
                <span className="wait-label">{waitLabels[wait.code]}</span>
                <span className="wait-actions">
                  <WaitAction
                    wait={wait}
                    taskId={taskId}
                    primary={false}
                    p={p}
                    resume={resume}
                  />
                </span>
                <WaitDetail wait={wait} />
              </li>
            ))}
          </ol>
        )}
        <ResumeOutcome p={p} draft={resume} projectId={projectId} />
      </div>
    );
  const heldLines = executionHref ? holds : [];
  const pausedFirst = first?.code === "project-paused";
  const holdList = (heading?: string) =>
    heldLines.length > 0 &&
    executionHref && (
      <HoldList
        lines={heldLines}
        href={executionHref}
        assignments={assignments}
        heading={heading}
      />
    );
  return (
    <div className="wait-reasons">
      {first && (
        <div className="wait-primary">
          <p className="small-heading">
            {prefix}
            {waitLabels[first.code]}
          </p>
          <div className="wait-actions">
            <WaitAction
              wait={first}
              taskId={taskId}
              primary
              p={p}
              resume={resume}
              holds={heldLines.map((line) => line.name)}
            />
          </div>
          <WaitDetail wait={first} />
          {pausedFirst &&
            holdList("Also held · Resume project doesn't clear these")}
        </div>
      )}
      {rest.length > 0 && (
        <ul className="wait-list" aria-label="Also waiting on">
          {rest.map((wait) => (
            <li key={wait.code}>
              <span>{waitLabels[wait.code]}</span>
              <span className="wait-actions">
                <WaitAction
                  wait={wait}
                  taskId={taskId}
                  primary={false}
                  p={p}
                  resume={resume}
                />
              </span>
              <WaitDetail wait={wait} />
            </li>
          ))}
        </ul>
      )}
      {!pausedFirst && holdList()}
      <ResumeOutcome p={p} draft={resume} projectId={projectId} />
    </div>
  );
}

/**
 * The Resume project draft for `projectId`. Call it once per screen and pass it to both
 * the Fix and its outcome. A confirmation from an earlier visit no longer describes the
 * project, so it is cleared; an unknown outcome or a conflict stays until resolved.
 */
export function useResumeDraft(p: WaitProps, projectId: string) {
  const draft = useDraft(p.drafts, `project.resume-fix:${projectId}`);
  const { recorded, read } = resumeVersions(p, projectId);
  useEffect(() => {
    if (draft.phase === "recorded") draft.purge();
  }, [draft]);
  // A read newer than the Resume shows the project as it is now, so the confirmation is stale.
  useEffect(() => {
    if (
      draft.phase === "recorded" &&
      recorded !== undefined &&
      read !== undefined &&
      read > recorded
    )
      draft.purge();
  }, [draft, recorded, read]);
  return draft;
}

function resumeVersions(p: WaitProps, projectId: string) {
  const receipt = p.drafts.saved(`project.resume-fix:${projectId}`)?.receipt;
  return {
    recorded:
      receipt?.kind === "configuration" && "version" in receipt.result
        ? receipt.result.version
        : undefined,
    read: p.workspace?.data.projects.find((x) => x.id === projectId)?.version,
  };
}

/**
 * A Resume this session recorded that the workspace read has not moved past. That read
 * still says paused at an older version: offering Resume again would send a stale version
 * and clear the confirmation. It survives a remount because the saved receipt does.
 */
export function resumeRecordedSinceRead(p: WaitProps, projectId: string) {
  const { recorded, read } = resumeVersions(p, projectId);
  return recorded !== undefined && read !== undefined && read <= recorded;
}

/** Confirms, then sends exactly one `project.configure {paused:false}` and nothing else. */
export function ResumeProjectFix({
  p,
  draft,
  projectId,
  variant = "primary",
  label = "Fix: Resume project",
  holds = [],
}: {
  p: WaitProps;
  draft: ConfigurationDraft;
  projectId: string;
  variant?: "primary" | "secondary";
  label?: string;
  /** Holds that stay after Resume, named in the confirmation. */
  holds?: readonly string[] | undefined;
}) {
  const [open, setOpen] = useState(false);
  const cancel = useRef<HTMLButtonElement>(null);
  const project = p.workspace?.data.projects.find((x) => x.id === projectId);
  const name = project?.name ?? "this project";
  // An unknown outcome keeps the original request; only Check whether it saved resends it.
  if (draft.phase === "unknown" || resumeRecordedSinceRead(p, projectId))
    return null;
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          type="button"
          variant={variant}
          disabled={!project || draft.phase === "pending"}
          onClick={() => {
            // Each open starts a fresh operation, so a cancelled one never keeps an old version.
            // Review changes may already have adopted a version newer than the shown one.
            // An operation in flight or unknown is kept: starting is a no-op for it.
            draft.startOperation({
              key: key(),
              expectedVersion: String(
                Math.max(
                  project?.version ?? 1,
                  Number(draft.values.expectedVersion) || 0,
                ),
              ),
            });
          }}
        >
          {draft.phase === "pending" ? "Resuming…" : label}
        </Button>
      </DialogTrigger>
      <DialogContent
        role="alertdialog"
        className="stop-dialog"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          cancel.current?.focus();
        }}
      >
        <DialogTitle>Resume {name}?</DialogTitle>
        <DialogDescription className="body">
          New turns can start. Holds and access are unchanged.
        </DialogDescription>
        {holds.length > 0 && (
          <p className="body">
            The{" "}
            {new Intl.ListFormat("en", { type: "conjunction" }).format(holds)}{" "}
            stay.
          </p>
        )}
        <p className="metadata muted">
          Pause project in project configuration reverses it.
        </p>
        <div className="stop-dialog-actions">
          <Button
            type="button"
            onClick={async () => {
              setOpen(false);
              await draft.submit(
                p.client,
                {
                  type: "project.configure",
                  key: draft.values.key,
                  projectId,
                  expectedVersion: Number(draft.values.expectedVersion),
                  paused: false,
                },
                p.session.csrfToken,
              );
              if (draft.phase === "recorded") p.onChanged();
            }}
          >
            Resume
          </Button>
          <DialogClose asChild>
            <Button ref={cancel} type="button" variant="secondary">
              Cancel
            </Button>
          </DialogClose>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The project page's paused banner (23b): Resume project while the project is paused. The
 * outcome stays after the pause clears, so a recorded save still reads "Project resumed.".
 */
export function ProjectPausedBanner({
  p,
  projectId,
  paused,
}: {
  p: WaitProps;
  projectId: string;
  paused: boolean;
}) {
  const resume = useResumeDraft(p, projectId);
  return (
    <>
      {paused && !resumeRecordedSinceRead(p, projectId) && (
        <div role="status" className="project-paused-banner">
          <div className="project-paused-text">
            <p className="body">
              <StatusBadge tone="warning">Project paused</StatusBadge> · New
              turns are held.
            </p>
            <p className="metadata muted">
              Running turns finish. Messages queue for the lead. Resume doesn't
              clear stop, task or writer holds.
            </p>
          </div>
          <ResumeProjectFix
            p={p}
            draft={resume}
            projectId={projectId}
            label="Resume project"
          />
        </div>
      )}
      <ResumeOutcome p={p} draft={resume} projectId={projectId} />
    </>
  );
}

/** The one outcome line of Resume project, kept after the wait it cleared leaves. */
export function ResumeOutcome({
  p,
  draft,
  projectId,
}: {
  p: WaitProps;
  draft: ConfigurationDraft;
  projectId: string;
}) {
  return (
    <DraftMessage
      draft={draft}
      success="Project resumed."
      check={async () => {
        await draft.reconcile(p.client, p.session.csrfToken);
        if (draft.phase === "recorded") p.onChanged();
      }}
      review={async () => {
        // A failed read leaves the warning and its action in place to try again.
        const latest = await p.client
          .read(
            `/api/operator/projects/${projectId}/configuration`,
            projectConfigurationSchema,
          )
          .catch(() => null);
        if (!latest) return;
        p.onChanged();
        if (latest.data.project.paused)
          draft.adoptVersion(latest.data.project.version);
        else draft.purge();
      }}
    />
  );
}
