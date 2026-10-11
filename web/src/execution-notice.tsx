import type { TaskRead } from "../../src/operator/contracts.js";
import { ActionLink } from "./components.js";
import { failureNotice, waitRoute } from "./execution-runtime.js";

/** Runtime wait and failure explanations for one assignment, with recovery routes. */
export function ExecutionNotices({
  assignment,
}: {
  assignment: TaskRead["data"]["assignments"][number];
}) {
  return [waitRoute(assignment), failureNotice(assignment)].map(
    (notice) =>
      notice && (
        <div className="execution-notice" key={notice.message}>
          <p className="metadata">{notice.message}</p>
          <div className="settings-actions">
            {notice.routes.map((r) => (
              <ActionLink key={r.href} variant="secondary" href={r.href}>
                {r.label}
              </ActionLink>
            ))}
          </div>
        </div>
      ),
  );
}
