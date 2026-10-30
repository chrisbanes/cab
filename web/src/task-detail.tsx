import type { ReactNode } from "react";
import type { TaskRead } from "../../src/operator/contracts.js";
import { assignmentRow } from "./task-overview.js";
import { ExecutionNotices } from "./execution-notice.js";
import "./task-detail.css";

const folds =
  "details.overview-disclosure, details.criteria-more, details.inspector-fold";

/** Opens the collapsed Overview cards (and the inspector holding them) around a linked record, so a link never lands on a closed one. */
export function openDisclosures(target: HTMLElement) {
  for (
    let card = target.closest<HTMLDetailsElement>(folds);
    card;
    card = card.parentElement?.closest<HTMLDetailsElement>(folds) ?? null
  )
    card.open = true;
}

/** Move to a task section in place: no history entry, focus on its heading or card summary. */
export function showSection(target: HTMLElement) {
  const fold = target.closest<HTMLDetailsElement>("details.inspector-fold");
  if (fold) fold.open = true;
  target.scrollIntoView();
  const summary = target.querySelector<HTMLElement>(
    ":scope > details.overview-disclosure > summary",
  );
  if (summary) return summary.focus({ preventScroll: true });
  const heading = target.querySelector<HTMLElement>("h3,h4");
  if (heading) {
    heading.tabIndex = -1;
    heading.focus({ preventScroll: true });
  }
}

/** The assignments table; a title opens that assignment in the conversation, and its facts expand in the row. */
export function AssignmentRows({
  assignments,
  open,
  facts,
  factsOpen,
  onFactsToggle,
}: {
  assignments: TaskRead["data"]["assignments"];
  open: (assignmentId: string) => void;
  facts: (assignment: TaskRead["data"]["assignments"][number]) => ReactNode;
  factsOpen: (assignmentId: string) => boolean;
  onFactsToggle: (assignmentId: string, open: boolean) => void;
}) {
  if (assignments.length === 0)
    return <p className="muted">No assignments yet.</p>;
  return (
    <table className="assignment-table">
      <thead>
        <tr>
          <th scope="col">Assignment</th>
          <th scope="col">Requested by → result to</th>
          <th scope="col">Known state</th>
        </tr>
      </thead>
      <tbody>
        {assignments.map((a) => {
          const row = assignmentRow(a, assignments);
          return (
            <tr className="assignment-row" key={a.assignmentId}>
              <td>
                <span className="assignment-id">{row.id}</span>
                <button type="button" onClick={() => open(a.assignmentId)}>
                  {row.title}
                </button>
                <details
                  className="assignment-facts"
                  open={factsOpen(a.assignmentId)}
                  onToggle={(event) =>
                    onFactsToggle(a.assignmentId, event.currentTarget.open)
                  }
                >
                  <summary>Assignment facts</summary>
                  {facts(a)}
                </details>
              </td>
              <td>{row.flow}</td>
              <td>
                {row.state} · {row.runtime} · {row.wait}
                <ExecutionNotices assignment={a} />
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
