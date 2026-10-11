import type { MouseEvent } from "react";
import type { TaskRead } from "../../src/operator/contracts.js";
import { ActionLink, isPlainClick } from "./components.js";
import { assignmentRow } from "./task-overview.js";
import "./task-detail.css";

/** Move to a task section in place: no history entry, focus on its heading. */
export function showSection(target: HTMLElement) {
  target.scrollIntoView();
  const heading = target.querySelector<HTMLElement>("h3,h4");
  if (heading) {
    heading.tabIndex = -1;
    heading.focus({ preventScroll: true });
  }
}

/** Keep this history entry, and so its origin, instead of pushing a hash entry. */
function inPage(id: string, before?: () => void) {
  return (event: MouseEvent<HTMLElement>) => {
    // Links keep modified clicks (new tab or window); the assignment buttons always act.
    if (
      event.currentTarget instanceof HTMLAnchorElement &&
      !isPlainClick(event)
    )
      return;
    event.preventDefault();
    const show = () => {
      const target = document.getElementById(id);
      if (target) showSection(target);
    };
    if (!before) return show();
    before();
    requestAnimationFrame(show);
  };
}

/** Frame 57's contextual entries; they replace the old section-button row. */
export function EntryLinks() {
  const entries = [
    ["files", "Files"],
    ["changes", "Changes"],
    ["local-review", "Review"],
    ["context", "Assignment context & identifiers"],
    ["history", "Assignment history"],
    ["reply", "Message lead"],
  ] as const;
  return (
    <nav className="entry-links" aria-label="Task material">
      {entries.map(([id, label]) => (
        <ActionLink
          key={id}
          variant="secondary"
          href={`#${id}`}
          onClick={inPage(id)}
        >
          {label}
        </ActionLink>
      ))}
    </nav>
  );
}

/** Compact delegation rows; opening one expands that assignment's history. */
export function AssignmentRows({
  assignments,
  open,
}: {
  assignments: TaskRead["data"]["assignments"];
  open: (assignmentId: string) => void;
}) {
  return (
    <div className="assignment-rows">
      <h4 className="small-heading">
        Assignments · requester → result destination
      </h4>
      {assignments.length === 0 && <p className="muted">No assignments yet.</p>}
      {assignments.map((a) => {
        const row = assignmentRow(a, assignments);
        return (
          <div className="assignment-row" key={a.assignmentId}>
            <button
              type="button"
              onClick={inPage("history", () => open(a.assignmentId))}
            >
              {row.title}
            </button>
            <p className="metadata muted">
              {row.id} · {row.flow} · {a.state} · {row.wait}
            </p>
          </div>
        );
      })}
    </div>
  );
}
