import { useCallback, useEffect, useState } from "react";
import {
  discoveryStatusSchema,
  type OperatorCommand,
} from "../../src/operator/contracts.js";
import { readinessSchema } from "../../src/operator/readiness.js";
import { ActionLink, Button } from "./components.js";
import {
  type ChecklistRow,
  checklistRows,
  homeRows,
  type RowStatus,
} from "./getting-started-model.js";
import { useOperatorResource } from "./resource.js";
import { DraftMessage, key, useDraft } from "./settings.js";
import type { ConfigurationDraft } from "./settings-state.js";
import type { ReadinessRead } from "./setup-model.js";
import { Badge } from "./ui/badge.js";
import {
  ResumeOutcome,
  ResumeProjectFix,
  useResumeDraft,
  type WaitProps,
} from "./wait-reasons.js";
import "./getting-started.css";

const badges: Record<
  RowStatus,
  {
    label: string;
    variant: "default" | "secondary" | "outline" | "destructive";
  }
> = {
  done: { label: "Done", variant: "secondary" },
  next: { label: "Next", variant: "default" },
  attention: { label: "Needs attention", variant: "destructive" },
  "not-started": { label: "Not started", variant: "outline" },
  optional: { label: "Optional", variant: "outline" },
  checking: { label: "Checking", variant: "outline" },
  unknown: { label: "Couldn't check", variant: "outline" },
};

/** The draft both the page and the account menu use, so either shows the other's outcome. */
export const GETTING_STARTED_DRAFT = "getting-started.configure";

/** Sends one `getting-started.configure`; Dismiss and Show getting started reverse each other. */
export async function configureGettingStarted(
  draft: ConfigurationDraft,
  p: Pick<WaitProps, "client" | "session" | "onChanged">,
  dismissed: boolean,
) {
  draft.startOperation({ key: key() });
  const command: OperatorCommand = {
    type: "getting-started.configure",
    key: String(draft.values.key),
    dismissed,
  };
  await draft.submit(p.client, command, p.session.csrfToken);
  if (draft.phase === "recorded") p.onChanged();
}

/**
 * Frames 143–144. Home shows every row until a task starts a turn, then only rows that
 * need attention; the page adds Dismiss and its undo.
 */
export function GettingStarted({
  mode,
  ...p
}: WaitProps & { mode: "home" | "page" }) {
  const scope = p.session.csrfToken;
  const readiness = useOperatorResource(
    scope,
    useCallback(
      (signal: AbortSignal) =>
        p.client.read("/api/operator/readiness", readinessSchema, signal),
      [p.client],
    ),
  );
  const workspace = p.workspace?.data;
  // After the first turn Home shows only rows needing attention, which GitHub never is.
  const needsDiscovery =
    mode === "page" || workspace?.gettingStarted.turnStarted === false;
  const discovery = useOperatorResource(
    needsDiscovery ? scope : null,
    useCallback(
      (signal: AbortSignal) =>
        p.client.read("/api/operator/discovery", discoveryStatusSchema, signal),
      [p.client],
    ),
  );
  const ghDraft = useDraft(p.drafts, "discovery.configure:getting-started");
  const dismissDraft = useDraft(p.drafts, GETTING_STARTED_DRAFT);
  // A confirmation from an earlier visit no longer describes the list.
  useEffect(() => {
    if (ghDraft.phase === "recorded") ghDraft.purge();
    if (mode === "home" && dismissDraft.phase === "recorded")
      dismissDraft.purge();
  }, [ghDraft, dismissDraft, mode]);
  const read: ReadinessRead = readiness.state.error
    ? { state: "unavailable" }
    : readiness.state.data
      ? { state: "ready", checks: readiness.state.data.data.checks }
      : { state: "loading" };
  const all = workspace
    ? checklistRows({
        workspace,
        readiness: read,
        discovery: discovery.state.data?.data ?? null,
      })
    : [];
  // The project the Resume row last offered, so its outcome stays after the row changes.
  const offered = all.flatMap((r) =>
    r.action.kind === "resume" ? [r.action.projectId] : [],
  )[0];
  const [target, setTarget] = useState(offered ?? null);
  useEffect(() => {
    if (offered) setTarget(offered);
  }, [offered]);
  const resume = useResumeDraft(p, target ?? "none");
  if (!workspace) return null;
  const { turnStarted, dismissed } = workspace.gettingStarted;
  const rows = mode === "home" ? homeRows(all, turnStarted) : all;
  const changed = () => {
    p.onChanged();
    void readiness.refresh();
    void discovery.refresh();
  };
  if (!rows.length && mode === "home") return null;
  const required = all.filter((r) =>
    ["runtime", "lead", "project", "first-task"].includes(r.id),
  );
  const attention = required.find((r) => r.status === "attention");
  return (
    <section className="getting-started" aria-label="Get Ensemble running">
      <div className="getting-started-heading">
        <h2 className="section-heading">Get Ensemble running</h2>
        <p className="metadata muted">
          {required.filter((r) => r.status === "done").length} of{" "}
          {required.length} required steps done
          {attention ? ` · ${attention.title} needs attention` : ""}
        </p>
      </div>
      <ol className="getting-started-rows">
        {rows.map((row) => (
          <li
            key={row.id}
            className="getting-started-row"
            aria-label={row.title}
          >
            <div className="getting-started-text">
              <h3 className="small-heading">{row.title}</h3>
              <p className="metadata muted">{row.detail}</p>
            </div>
            <Badge variant={badges[row.status].variant}>
              {badges[row.status].label}
            </Badge>
            <div className="getting-started-action">
              <RowAction
                row={row}
                p={{ ...p, onChanged: changed }}
                ghDraft={ghDraft}
                resume={resume}
              />
            </div>
          </li>
        ))}
      </ol>
      <DraftMessage
        draft={ghDraft}
        success="Discovery now uses your GitHub CLI login."
        check={async () => {
          await ghDraft.reconcile(p.client, p.session.csrfToken);
          if (ghDraft.phase === "recorded") changed();
        }}
      />
      {target && (
        <ResumeOutcome
          p={{ ...p, onChanged: changed }}
          draft={resume}
          projectId={target}
        />
      )}
      {mode === "page" && (
        <div className="getting-started-dismiss">
          {dismissDraft.phase !== "unknown" && (
            <Button
              type="button"
              variant="secondary"
              disabled={dismissDraft.phase === "pending"}
              onClick={() =>
                void configureGettingStarted(dismissDraft, p, !dismissed)
              }
            >
              {dismissDraft.phase === "pending"
                ? "Saving…"
                : dismissed
                  ? "Show getting started"
                  : "Dismiss"}
            </Button>
          )}
          <p className="metadata muted">
            Rows read current service state, so a row that needs attention
            returns to Home even after the list is dismissed.
          </p>
        </div>
      )}
      <DraftMessage
        draft={dismissDraft}
        success={
          dismissDraft.frozen?.type === "getting-started.configure" &&
          dismissDraft.frozen.dismissed
            ? "Getting started dismissed. Show it again from the account menu."
            : "Getting started is back in the account menu."
        }
        check={async () => {
          await dismissDraft.reconcile(p.client, p.session.csrfToken);
          if (dismissDraft.phase === "recorded") p.onChanged();
        }}
      />
    </section>
  );
}

function RowAction({
  row,
  p,
  ghDraft,
  resume,
}: {
  row: ChecklistRow;
  p: WaitProps;
  ghDraft: ConfigurationDraft;
  resume: ConfigurationDraft;
}) {
  const variant = row.primary ? "primary" : "secondary";
  const { action } = row;
  if (action.kind === "resume")
    return (
      <ResumeProjectFix
        p={p}
        draft={resume}
        projectId={action.projectId}
        variant={variant}
        label="Resume"
      />
    );
  if (action.kind === "gh-login")
    return ghDraft.phase === "unknown" ? null : (
      <Button
        type="button"
        variant="secondary"
        disabled={ghDraft.phase === "pending"}
        onClick={async () => {
          ghDraft.startOperation({ key: key() });
          await ghDraft.submit(
            p.client,
            {
              type: "discovery.configure",
              key: ghDraft.values.key,
              credentialRef: "gh:github.com",
            },
            p.session.csrfToken,
          );
          if (ghDraft.phase === "recorded") p.onChanged();
        }}
      >
        {ghDraft.phase === "pending"
          ? "Saving…"
          : `Use GitHub CLI login (@${action.login})`}
      </Button>
    );
  return (
    <ActionLink variant={variant} href={action.href}>
      {action.label}
    </ActionLink>
  );
}
