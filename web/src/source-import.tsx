import {
  type ReactNode,
  useEffect,
  useId,
  useReducer,
  useRef,
  useState,
} from "react";
import type { z } from "zod";
import type { sourceObservationSchema } from "../../src/operator/contracts.js";
import { ActionOutcome, type OutcomeField } from "./action-feedback.js";
import { Button } from "./components.js";
import type { TabProps } from "./project-config.js";
import { clockLabel } from "./presentation.js";
import { SourceNameText } from "./source-names.js";
import { type SourceNaming, sourceCredentialCopy } from "./settings-view.js";
import type { ObservationResource } from "./sync-placement.js";
import { type ConfigurationDraft, outcomeCopy } from "./settings-state.js";

type Observed = z.infer<
  typeof sourceObservationSchema
>["data"]["projects"][number];
type Selection = TabProps["data"]["source"]["selections"][number];
type Named = Selection & { id: string };

/**
 * What one press of Preview and import now did. Everything here is taken when the press
 * started (the source version, which sources, the answer of the refresh), so a later render
 * or read never changes what an earlier press is described as.
 */
interface Run {
  version: number;
  /** The sources this press covers, in saved order. */
  ids: string[];
  /** The refresh: not reached, not confirmed, or the answer it gave for this project. */
  refresh: "none" | "failed" | { at: number; project: Observed | undefined };
}

/** The credential alert of the same tab, which says why the action is unavailable. */
export const credentialReasonId = "source-credential-reason";

/** The key of one source's preview at one source version; app-wide, so a retry reuses it. */
const importDraftKey = (
  projectId: string,
  version: number,
  selectionId: string,
) => `github.import:${projectId}:${version}:${selectionId}`;

/** The phase now; a command settles it behind the type checker's narrowing. */
const phaseOf = (d: ConfigurationDraft): ConfigurationDraft["phase"] => d.phase;

const named = (s: Selection): s is Named => s.id !== null;

/** Saved sources with nothing imported yet: inactive, or active and never read. */
function unimported(
  p: Pick<TabProps, "data" | "projectId"> & {
    observations: ObservationResource;
  },
) {
  const read = p.observations.state.data?.data.projects.find(
    (r) => r.projectId === p.projectId,
  );
  return p.data.source.selections
    .filter(named)
    .filter(
      (s) =>
        !s.active ||
        (p.observations.state.data !== null &&
          (read?.selections.find((o) => o.selectionId === s.id)?.state ??
            "never") === "never"),
    );
}

/**
 * Import issues: after a save, one press previews and activates every saved inactive source
 * (one keyed command each, in saved order), then asks for one installation-wide refresh. The
 * activation outcome comes only from the previews' receipts; whether anything was imported
 * comes only from what the refresh then reports. The panel is derived from the reads: it is
 * offered while a saved source is inactive or was never read, so it survives a remount after
 * a lost reply, and it offers only what is left to do.
 */
export function ImportPanel(
  p: TabProps & {
    observations: ObservationResource;
    naming: (s: Selection) => SourceNaming;
    /** The form holds no unsaved change and its own save is not under way. */
    quiet: boolean;
    /** This session's save produced the source version now loaded. */
    saved: boolean;
    /** The form's save phase, to move focus here once after a save records. */
    savePhase: ConfigurationDraft["phase"];
  },
) {
  const { data, projectId } = p,
    version = data.source.version,
    [, rerender] = useReducer((v: number) => v + 1, 0),
    [run, setRun] = useState<Run | null>(null),
    [settled, setSettled] = useState(0),
    // Derived from the press itself: cleared in `finally`, so no failure can leave it set.
    [working, setWorking] = useState(false),
    heading = useRef<HTMLHeadingElement>(null),
    outcome = useRef<HTMLDivElement>(null),
    running = useRef(false),
    generation = useRef(0),
    latest = useRef(p),
    lastRun = useRef<Run | null>(null),
    wantsFocus = useRef(false),
    titleId = useId();
  latest.current = p;
  lastRun.current = run;
  // A press stops issuing steps once the page or project it belongs to is gone.
  // biome-ignore lint/correctness/useExhaustiveDependencies: restart per project.
  useEffect(() => {
    generation.current++;
    return () => {
      generation.current++;
    };
  }, [projectId]);

  const selections = data.source.selections.filter(named),
    draft = (id: string, at = version) =>
      p.drafts.get(importDraftKey(projectId, at, id), rerender),
    // Derived from the reads each render: inactive, or active but never read.
    pending = unimported(p),
    targets = selections.filter((s) => !s.active),
    drafts = targets.map((s) => ({ s, d: draft(s.id) })),
    unknown = drafts.find(({ d }) => d.phase === "unknown"),
    changedElsewhere = drafts.find(
      ({ d }) => d.phase === "conflict" && !d.credentialRefusal,
    ),
    credential = drafts.find(
      ({ d }) => d.phase === "conflict" && d.credentialRefusal,
    ),
    rejected = drafts.find(({ d }) => d.phase === "rejected"),
    unusable = data.source.credential?.usable === false,
    busy = working || drafts.some(({ d }) => d.phase === "pending"),
    // The press that belongs to the source now loaded; a save starts a clean slate.
    mine = run && run.version === version ? run : null,
    offered = p.quiet && pending.length > 0,
    blocked = unknown !== undefined || changedElsewhere !== undefined;

  // A save moves focus here once, so the next action is at hand; it is per visit, not stored.
  // The flag is spent by the first render after the save's re-read, whether or not it shows.
  const shown = p.quiet && (offered || mine !== null);
  useEffect(() => {
    if (p.savePhase === "recorded") wantsFocus.current = true;
    else if (wantsFocus.current) {
      wantsFocus.current = false;
      if (shown) heading.current?.focus();
    }
  }, [p.savePhase, shown]);
  // After a press the control that was used may be gone, so the outcome takes the focus.
  useEffect(() => {
    if (settled > 0)
      (outcome.current?.childElementCount ? outcome : heading).current?.focus();
  }, [settled]);

  /** Preview every saved inactive source once, then refresh once; a retry resumes. */
  async function go(refreshOnly = false) {
    // The synchronous guard stops a double press; busy also covers a press made before a remount.
    const now = latest.current,
      // A refresh-only retry reports on the sources of the press it continues.
      retry = refreshOnly ? lastRun.current : null,
      at = retry?.version ?? now.data.source.version,
      todo = now.data.source.selections
        .filter(named)
        .filter((s) => !s.active)
        .map((s) => s.id),
      scope = retry?.ids ?? unimported(now).map((s) => s.id),
      unusableNow = now.data.source.credential?.usable === false;
    if (running.current || todo.some((id) => draft(id, at).phase === "pending"))
      return;
    running.current = true;
    const gen = generation.current,
      { client, session } = now;
    setWorking(true);
    setRun({ version: at, ids: scope, refresh: "none" });
    let conflicted = false;
    try {
      if (!refreshOnly)
        for (const id of todo) {
          if (gen !== generation.current) return;
          const d = draft(id, at);
          if (d.phase === "recorded") continue;
          if (d.phase === "unknown")
            await d.reconcile(client, session.csrfToken);
          else if (unusableNow) {
            // A new preview waits for a usable credential; the action beside it says why.
            return;
          } else if (d.phase !== "conflict" || d.credentialRefusal) {
            // A refused preview was never recorded, so it starts again under a fresh key.
            if (d.phase === "rejected" || d.phase === "conflict") d.purge();
            if (!d.values.key)
              d.initialize({
                key: crypto.randomUUID(),
                expectedVersion: String(at),
                selectionId: id,
              });
            await d.submit(
              client,
              {
                type: "github.preview",
                key: String(d.values.key),
                projectId: now.projectId,
                selectionId: id,
                expectedVersion: at,
              },
              session.csrfToken,
            );
          }
          if (phaseOf(d) !== "recorded") {
            // Another writer's change is reviewed by the operator, not read over silently.
            conflicted = phaseOf(d) === "conflict" && !d.credentialRefusal;
            setRun({ version: at, ids: scope, refresh: "none" });
            return;
          }
        }
      if (gen !== generation.current) return;
      try {
        const answer = await client.refreshSources(session.csrfToken);
        if (gen === generation.current)
          setRun({
            version: at,
            ids: scope,
            refresh: {
              at: Date.now(),
              project: answer.data.projects.find(
                (r) => r.projectId === now.projectId,
              ),
            },
          });
      } catch {
        if (gen === generation.current)
          setRun({ version: at, ids: scope, refresh: "failed" });
      }
    } finally {
      running.current = false;
      setWorking(false);
      if (gen === generation.current) {
        // The reads show what the press did, whatever the answer was.
        if (!refreshOnly && !conflicted) latest.current.refreshConfiguration();
        latest.current.observations.refresh();
        setSettled((n) => n + 1);
      }
    }
  }

  if (!shown) return null;
  const nameOf = (id: string) => {
      const s = selections.find((x) => x.id === id);
      return s ? p.naming(s) : { name: "A source", kind: "", private: false };
    },
    names = (list: string[]): ReactNode => {
      const items = list.map((id) => (
        <SourceNameText key={id} naming={nameOf(id)} />
      ));
      return items.length > 1 ? (
        <>
          {items.slice(0, -1).flatMap((x, i) => (i ? [", ", x] : [x]))} and{" "}
          {items.at(-1)}
        </>
      ) : (
        items[0]
      );
    },
    verb = (list: string[], one: string, many: string) =>
      list.length === 1 ? one : many;

  // Activation: the previews' receipts of this press, at the version it started from.
  const activated = (mine?.ids ?? []).flatMap((id) => {
    const d = draft(id, mine?.version),
      receipt = d.receipt;
    return d.phase === "recorded" &&
      receipt?.kind === "configuration" &&
      receipt.result.commandType === "github.preview"
      ? [
          {
            id,
            before: receipt.result.alreadyActive === true,
            at: p.drafts.saved(
              importDraftKey(projectId, mine?.version ?? 0, id),
            )?.at,
            key: receipt.key,
          },
        ]
      : [];
  });
  const fresh = activated.filter((a) => !a.before).map((a) => a.id),
    already = activated.filter((a) => a.before).map((a) => a.id),
    lastAt = Math.max(0, ...activated.map((a) => a.at ?? 0)),
    details: OutcomeField[] = activated.map((a) => [
      a.id,
      `Previewed${a.before ? " (already active)" : ""} · request key ${a.key} · source version ${mine?.version}`,
    ]);

  // The refresh: what it reported for each source of this press, never the shared read.
  const answer = typeof mine?.refresh === "object" ? mine.refresh : null,
    state = (id: string) =>
      answer?.project?.selections.find((o) => o.selectionId === id),
    covered = (mine?.ids ?? []).filter((id) =>
      selections.some((s) => s.id === id),
    ),
    complete = covered.filter((id) => state(id)?.state === "complete"),
    partial = covered.filter((id) => state(id)?.state === "partial"),
    missing = covered.filter(
      (id) => !["complete", "partial"].includes(state(id)?.state ?? ""),
    ),
    when = answer ? clockLabel(answer.at) : "";

  return (
    <section className="settings-panel" aria-labelledby={titleId}>
      <div className="settings-panel-header">
        <div>
          <h2
            id={titleId}
            ref={heading}
            tabIndex={-1}
            className="settings-panel-title"
          >
            Import issues
          </h2>
        </div>
      </div>
      <div ref={outcome} tabIndex={-1} className="import-outcome">
        {activated.length > 0 && (
          <ActionOutcome
            tone="success"
            message={
              <>
                Previewed{lastAt ? ` ${clockLabel(lastAt)}` : ""}.{" "}
                {fresh.length > 0 && (
                  <>
                    {names(fresh)} {verb(fresh, "is", "are")} active.
                  </>
                )}
                {fresh.length > 0 && already.length > 0 && " "}
                {already.length > 0 && (
                  <>
                    {names(already)} {verb(already, "was", "were")} already
                    active.
                  </>
                )}
              </>
            }
            details={details}
          />
        )}
        {unknown && (
          <ActionOutcome
            tone="warning"
            message={
              <>
                We couldn't confirm the preview of{" "}
                <SourceNameText naming={nameOf(unknown.s.id)} />. Your saved
                sources are unchanged.
              </>
            }
            action={{
              label: "Check whether it saved",
              onClick: () => go(),
            }}
          />
        )}
        {changedElsewhere && (
          <ActionOutcome
            tone="warning"
            message={`${outcomeCopy.conflict} Nothing was refreshed.`}
            action={{
              label: "Review changes",
              onClick: () => {
                // Reading again may land on the same version; the old refusal must not outlive it.
                for (const { d } of drafts)
                  if (d.phase === "conflict" && !d.credentialRefusal) d.purge();
                p.refreshConfiguration();
                // The control that had focus is gone; the heading is always there.
                heading.current?.focus();
              },
            }}
          />
        )}
        {credential && (
          <ActionOutcome
            tone="error"
            message={sourceCredentialCopy(data.source.credential?.reason)}
          >
            <a href={`/app/projects/${projectId}/settings?tab=github`}>
              Set or change source credential
            </a>
          </ActionOutcome>
        )}
        {rejected && (
          <ActionOutcome
            tone="error"
            message={
              <>
                Couldn't preview{" "}
                <SourceNameText naming={nameOf(rejected.s.id)} />. Nothing was
                refreshed.
              </>
            }
          />
        )}
        {working && !(offered && !blocked) && (
          <p className="body" role="status">
            Refreshing from GitHub…
          </p>
        )}
        {mine?.refresh === "failed" && (
          <ActionOutcome
            tone="warning"
            message="We couldn't confirm the refresh. The sources are active."
            action={{
              label: "Refresh again",
              onClick: () => go(true),
            }}
          />
        )}
        {answer && complete.length > 0 && (
          <ActionOutcome
            tone="success"
            message={
              <>
                Read {names(complete)} completely at {when}.
              </>
            }
          >
            <a href={`/app/projects/${projectId}`}>View imported tasks</a>
          </ActionOutcome>
        )}
        {answer && partial.length + missing.length > 0 && (
          <ActionOutcome
            tone="warning"
            message={readOutcome(partial, missing, names, verb, when)}
          />
        )}
      </div>
      {!mine && (
        <p className="body">
          {p.saved ? "Saved. " : ""}
          {names(pending.map((s) => s.id))}{" "}
          {pending.length === 1 ? "isn't" : "aren't"} imported yet.
        </p>
      )}
      {offered && !blocked && (
        <div>
          <Button
            type="button"
            aria-disabled={busy || unusable || undefined}
            aria-busy={busy || undefined}
            aria-describedby={unusable ? credentialReasonId : undefined}
            onClick={() => {
              if (!busy && !unusable) void go();
            }}
          >
            {busy ? "Importing…" : "Preview and import now"}
          </Button>
        </div>
      )}
      <p className="metadata muted">
        {mine
          ? "Later refreshes and placement are in Sync & placement."
          : "Previews and activates the saved sources at this version, then refreshes them from GitHub. Neither starts work."}
      </p>
    </section>
  );
}

/** What a refresh left unread: it never claims an import for a source it did not read completely. */
function readOutcome(
  partial: string[],
  missing: string[],
  names: (list: string[]) => ReactNode,
  verb: (list: string[], one: string, many: string) => string,
  when: string,
): ReactNode {
  return (
    <>
      {partial.length > 0 && (
        <>
          Read {names(partial)} only partly at {when}, so{" "}
          {verb(partial, "its issues", "their issues")} may not all be imported.
        </>
      )}
      {partial.length > 0 && missing.length > 0 && " "}
      {missing.length > 0 && (
        <>
          Couldn't read {names(missing)} from GitHub; nothing was imported from{" "}
          {verb(missing, "it", "them")}.
        </>
      )}
    </>
  );
}
