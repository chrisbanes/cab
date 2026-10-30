import { CircleCheck, Clock, Diamond } from "lucide-react";
import type { MouseEvent, ReactNode } from "react";
import type { TaskRead } from "../../src/operator/contracts.js";
import { isPlainClick, ShortId } from "./components.js";
import { clockLabel } from "./presentation.js";
import { commentAvailability } from "../../src/operator/github-reasons.js";
import { holdNoticesBesideRequests } from "./inbox-presentation.js";
import {
  pullRequestReference,
  pullRequestRepository,
} from "./delivery-presentation.js";
import {
  deliveryApplies,
  executionFacts,
  jiraFacts,
  sourceFacts,
  taskColumnOf,
  taskIdentity,
  trackerName,
} from "./task-overview.js";

type Data = TaskRead["data"];

/** One inspector group: an uppercase label over its rows. */
function Group({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="inspector-group">
      <h4 className="inspector-label">{label}</h4>
      {children}
    </div>
  );
}

/**
 * The Overview inspector: source facts, holds, dependencies, execution facts
 * and results. An imported task's GitHub content is a separate read-only group; nothing in it
 * writes to GitHub.
 */
export function TaskInspector({
  data,
  deciding,
  selectResult,
}: {
  data: Data;
  /** The interaction id of the approval in view, or null when none is. */
  deciding: string | null;
  /** Shows one recorded result as the latest-result card, in place. */
  selectResult: (resultId: string) => void;
}) {
  const source = data.source,
    comment = commentAvailability(data.commentPolicy),
    facts = executionFacts(data),
    requests = [...data.approvals, ...data.questions].filter(
      (q) => q.status === "open",
    ),
    holds = holdNoticesBesideRequests(data, "approve", deciding);
  const show = (resultId: string) => (event: MouseEvent<HTMLAnchorElement>) => {
    if (!isPlainClick(event)) return;
    event.preventDefault();
    selectResult(resultId);
  };
  return (
    <aside className="task-inspector" aria-label="Task context">
      {source && (
        <>
          <Group label={`${trackerName(source)} source · read-only`}>
            {(() => {
              const identity = taskIdentity(data),
                { state, synced, problem } = sourceFacts(source),
                { status, site } = jiraFacts(source);
              return (
                <>
                  {identity.url ? (
                    <a className="task-id" href={identity.url}>
                      {identity.label} ↗
                    </a>
                  ) : (
                    <span className="task-id">{identity.label}</span>
                  )}
                  <p>
                    {site && `${site} · `}
                    Issue {state ?? "state unknown"}
                    {status && ` (${status})`} ·{" "}
                    {synced
                      ? `synced ${clockLabel(Date.parse(synced))}`
                      : "no successful sync"}
                    {problem && ` · ${problem}`}
                  </p>
                  <p className="muted">
                    {trackerName(source)} owns the issue. cab coordinates the
                    work.
                  </p>
                </>
              );
            })()}
            <h5 className="inspector-label">
              Dependencies · managed in {trackerName(source)}
            </h5>
            {source.nativeBlockers.length ? (
              <ul className="inspector-rows">
                {source.nativeBlockers.map((b) => (
                  <li key={b.nodeId}>
                    {b.state === "open" ? (
                      <Clock aria-hidden="true" />
                    ) : (
                      <CircleCheck aria-hidden="true" data-tone="ok" />
                    )}
                    {b.url ? (
                      <a className="task-id" href={b.url}>
                        {b.label}
                      </a>
                    ) : (
                      <span className="task-id">{b.label}</span>
                    )}
                    <span className="muted">
                      {b.state === "open" ? "Open blocker" : "Closed"}
                    </span>
                  </li>
                ))}
              </ul>
            ) : source.identity.tracker === "jira" ? (
              <p className="muted">
                Not read from Jira yet, so this task cannot start.
              </p>
            ) : (
              <p className="muted">None</p>
            )}
            <p>
              {trackerName(source)} commenting{" "}
              {comment.postable ? "permitted" : "unavailable"}
            </p>
            {comment.sentence && <p className="muted">{comment.sentence}</p>}
          </Group>
          <p className="inspector-divider">cab execution</p>
        </>
      )}
      <Group label={`Holds · ${requests.length + holds.length}`}>
        {requests.length + holds.length ? (
          <ul className="inspector-rows">
            {requests.map((q) => (
              <li key={q.interactionId}>
                <Diamond aria-hidden="true" data-tone="attn" />
                <span>
                  {q.kind === "approval"
                    ? "Approval pending"
                    : "Question pending"}
                  <span className="muted"> · Next: you</span>
                </span>
              </li>
            ))}
            {holds.map((h) => (
              <li key={h.id}>
                <Clock aria-hidden="true" />
                <span>
                  {h.title}
                  {h.items.length > 0 && (
                    <span className="muted"> · {h.items.join(", ")}</span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">None</p>
        )}
      </Group>
      {/* An imported task's dependencies are the GitHub-managed block above; it owns no local edges. */}
      {(!source || data.localDependencies.length > 0) && (
        <Group label="Dependencies">
          {data.localDependencies.length ? (
            <ul className="inspector-rows">
              {data.localDependencies.map((d) => (
                <li key={d.id}>
                  {d.state === "done" ? (
                    <CircleCheck aria-hidden="true" data-tone="ok" />
                  ) : (
                    <Clock aria-hidden="true" />
                  )}
                  <a href={`/app/tasks/${d.id}`}>{d.title ?? "Unavailable"}</a>
                  <span className="muted">{d.state}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">None</p>
          )}
        </Group>
      )}
      <Group label="Execution">
        <dl className="inspector-facts">
          <dt>State</dt>
          <dd>{taskColumnOf(data)}</dd>
          <dt>Turns</dt>
          <dd>{facts.running ? `${facts.running} running` : "None running"}</dd>
          <dt>Lead runtime</dt>
          <dd>{facts.lead ?? "No lead assignment"}</dd>
          {deliveryApplies(data) && (
            <>
              <dt>Delivery</dt>
              <dd>{facts.delivery}</dd>
            </>
          )}
        </dl>
      </Group>
      <Group label="Results & artifacts">
        {data.results.length || data.delivery?.binding ? (
          <ul className="inspector-rows">
            {data.results
              .map((r, i) => ({ r, i }))
              .reverse()
              .map(({ r, i }) => (
                <li key={r.resultId}>
                  <a
                    href={`?result=${r.resultId}#review`}
                    onClick={show(r.resultId)}
                  >
                    R{i + 1} · <ShortId value={r.resultId} focusable={false} />
                  </a>
                </li>
              ))}
            {data.delivery?.binding && (
              <li>
                {pullRequestRepository(data.delivery.binding)
                  ? data.delivery.binding.codeHost === "gitlab"
                    ? "Merge request "
                    : "Pull request "
                  : ""}
                {pullRequestReference(data.delivery.binding)} ·{" "}
                {data.delivery.binding.state.toLowerCase()}
              </li>
            )}
          </ul>
        ) : (
          <p className="muted">No results yet.</p>
        )}
      </Group>
    </aside>
  );
}
