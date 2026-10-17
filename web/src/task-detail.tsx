import type { MouseEvent } from "react";
import type { TaskRead } from "../../src/operator/contracts.js";
import { isPlainClick } from "./components.js";
import { assignmentRow } from "./task-overview.js";
import { ExecutionNotices } from "./execution-notice.js";
import "./task-detail.css";

/** Opens the collapsed Overview card that holds a linked record, so a link never lands on a closed one. */
export function openDisclosures(target: HTMLElement) {
  const card = target.closest<HTMLDetailsElement>(
    "details.overview-disclosure",
  );
  if (card) card.open = true;
}

/** Move to a task section in place: no history entry, focus on its heading or card summary. */
export function showSection(target: HTMLElement) {
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

/**
 * Keep this history entry, and so its origin, instead of pushing a hash entry. `reveal`
 * selects the section's tab, then moves to it.
 */
function inPage(id: string, reveal: (id: string) => void, before?: () => void) {
  return (event: MouseEvent<HTMLElement>) => {
    // Links keep modified clicks (new tab or window); the assignment buttons always act.
    if (
      event.currentTarget instanceof HTMLAnchorElement &&
      !isPlainClick(event)
    )
      return;
    event.preventDefault();
    if (!before) return reveal(id);
    before();
    requestAnimationFrame(() => reveal(id));
  };
}

/** The assignments table; opening one expands that assignment's history. */
export function AssignmentRows({
  assignments,
  open,
  reveal,
}: {
  assignments: TaskRead["data"]["assignments"];
  open: (assignmentId: string) => void;
  reveal: (id: string) => void;
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
                <button
                  type="button"
                  onClick={inPage("history", reveal, () =>
                    open(a.assignmentId),
                  )}
                >
                  {row.title}
                </button>
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
