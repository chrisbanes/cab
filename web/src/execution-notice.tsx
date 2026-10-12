import {
  executionHarnessLabels,
  type ExecutionHarness,
  type TaskRead,
  type Workspace,
} from "../../src/operator/contracts.js";
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

/** A harness's effective execution policy and disclosed limits, or why it is not shown yet. */
export function PolicyDisclosure({
  harness,
  workspace,
}: {
  harness: ExecutionHarness;
  workspace: Workspace | null | undefined;
}) {
  const policy = workspace?.data.harnesses.find(
    (h) => h.harness === harness,
  )?.policy;
  if (!policy)
    return (
      <p className="metadata muted">
        Effective policy appears once the {executionHarnessLabels[harness]}{" "}
        runtime is available.
      </p>
    );
  return (
    <div className="policy-disclosure">
      {policy.lines.map((line) => (
        <p className="body" key={line}>
          {line}
        </p>
      ))}
      <ul className="metadata muted" aria-label="Disclosed limits">
        {policy.limits.map((limit) => (
          <li key={limit}>{limit}</li>
        ))}
      </ul>
    </div>
  );
}
