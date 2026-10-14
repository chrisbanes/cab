import { useEffect, useRef, useState } from "react";
import {
  projectConfigurationSchema,
  type Session,
  type Workspace,
} from "../../src/operator/contracts.js";
import {
  fixLabels,
  type Wait,
  type WaitFix,
  type WaitLink,
  waitLabels,
} from "../../src/operator/wait-reasons.js";
import type { OperatorClient } from "./api.js";
import { ActionLink, Button } from "./components.js";
import { DraftMessage, key, useDraft } from "./settings.js";
import type { ConfigurationDrafts } from "./settings-state.js";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "./ui/dialog.js";
import "./wait-reasons.css";

export interface WaitProps {
  client: OperatorClient;
  session: Session;
  drafts: ConfigurationDrafts;
  workspace: Workspace | null;
  /** Re-read whatever shows the waits after Resume project is recorded. */
  onChanged: () => void;
}

const fixHref = (fix: Exclude<WaitFix, { kind: "resume-project" }>) =>
  fix.kind === "choose-lead"
    ? `/app/projects/${fix.projectId}/settings`
    : fix.kind === "readiness"
      ? "/app/settings"
      : fix.kind === "add-claude"
        ? "/app/settings/runtime"
        : `/app/profiles/${fix.profileId}/settings`;

const linkHref = (link: WaitLink, taskId: string | null) =>
  link.kind === "task"
    ? `/app/tasks/${link.id}`
    : link.kind === "request"
      ? `/app/tasks/${taskId}?request=${encodeURIComponent(link.id)}`
      : link.kind === "source"
        ? link.url
        : "/app/tasks?state=Running";

/** One wait's Fix, or the links to what blocks it; holds never get a Fix. */
function WaitAction({
  wait,
  taskId,
  primary,
  p,
}: {
  wait: Wait;
  taskId: string | null;
  primary: boolean;
  p: WaitProps;
}) {
  const variant = primary ? "primary" : "secondary";
  if (wait.fix?.kind === "resume-project")
    return (
      <ResumeProjectFix
        p={p}
        projectId={wait.fix.projectId}
        variant={variant}
      />
    );
  if (wait.fix)
    return (
      <ActionLink variant={variant} href={fixHref(wait.fix)}>
        Fix: {fixLabels[wait.fix.kind]}
      </ActionLink>
    );
  return (
    <>
      {wait.links.map((link) => (
        <ActionLink
          key={`${link.kind}:${"id" in link ? link.id : link.label}`}
          variant="secondary"
          href={linkHref(link, taskId)}
        >
          {link.label}
        </ActionLink>
      ))}
    </>
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
  ...p
}: WaitProps & {
  waits: readonly Wait[];
  taskId?: string | null;
  projectId: string;
  /** What precedes the first reason, such as "It will wait: ". */
  prefix?: string;
}) {
  const [first, ...rest] = waits;
  return (
    <div className="wait-reasons">
      {first && (
        <div className="wait-primary">
          <p className="small-heading">
            {prefix}
            {waitLabels[first.code]}
          </p>
          <div className="wait-actions">
            <WaitAction wait={first} taskId={taskId} primary p={p} />
          </div>
        </div>
      )}
      {rest.length > 0 && (
        <ul className="wait-list" aria-label="Also waiting on">
          {rest.map((wait) => (
            <li key={wait.code}>
              <span>{waitLabels[wait.code]}</span>
              <span className="wait-actions">
                <WaitAction wait={wait} taskId={taskId} primary={false} p={p} />
              </span>
            </li>
          ))}
        </ul>
      )}
      <ResumeOutcome p={p} projectId={projectId} />
    </div>
  );
}

const resumeKey = (projectId: string) => `project.resume-fix:${projectId}`;

/** Confirms, then sends exactly one `project.configure {paused:false}` and nothing else. */
export function ResumeProjectFix({
  p,
  projectId,
  variant = "primary",
}: {
  p: WaitProps;
  projectId: string;
  variant?: "primary" | "secondary";
}) {
  const draft = useDraft(p.drafts, resumeKey(projectId));
  const [open, setOpen] = useState(false);
  const cancel = useRef<HTMLButtonElement>(null);
  const project = p.workspace?.data.projects.find((x) => x.id === projectId);
  const name = project?.name ?? "this project";
  // An unknown outcome keeps the original request; only Check whether it saved resends it.
  if (draft.phase === "unknown") return null;
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          type="button"
          variant={variant}
          disabled={!project || draft.phase === "pending"}
          onClick={() => {
            // A new operation from the shown version; a newer one comes back as a conflict.
            if (draft.phase !== "editing" || !draft.values.key)
              draft.startOperation({
                key: key(),
                expectedVersion: String(project?.version ?? 1),
              });
          }}
        >
          {draft.phase === "pending" ? "Resuming…" : "Fix: Resume project"}
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

/** The one outcome line of Resume project, kept after the wait it cleared leaves. */
function ResumeOutcome({ p, projectId }: { p: WaitProps; projectId: string }) {
  const draft = useDraft(p.drafts, resumeKey(projectId));
  // A confirmation from an earlier visit no longer describes the project; an unknown
  // outcome or a conflict stays until it is resolved.
  useEffect(() => {
    if (draft.phase === "recorded") draft.purge();
  }, [draft]);
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
