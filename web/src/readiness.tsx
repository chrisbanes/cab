import { useCallback } from "react";
import { readinessSchema } from "../../src/operator/readiness.js";
import { Button, StatusBadge } from "./components.js";
import { useOperatorResource } from "./resource.js";
import { Panel, useHeaderRefresh, type SettingsProps } from "./settings.js";

const status = {
  pass: { label: "Pass", tone: "success" },
  fail: { label: "Fail", tone: "error" },
  "not-configured": { label: "Not configured", tone: "neutral" },
} as const;

/** What the running service can and cannot use; Run again is the only action. */
export function ReadinessPanel(p: SettingsProps) {
  const loader = useCallback(
    (signal: AbortSignal) =>
      p.client.read("/api/operator/readiness", readinessSchema, signal),
    [p.client],
  );
  const readiness = useOperatorResource(p.session.csrfToken, loader);
  useHeaderRefresh(p.refreshNonce, readiness.refresh);
  const checks = readiness.state.data?.data.checks;
  return (
    <Panel
      title="Readiness"
      description="What the running service can use, with one fix for each problem."
      action={
        <Button
          type="button"
          variant="secondary"
          disabled={readiness.state.pending}
          onClick={readiness.refresh}
        >
          Run again
        </Button>
      }
    >
      {checks ? (
        checks.map((c) => (
          <article className="settings-row" key={c.id} aria-label={c.label}>
            <div className="settings-row-heading">
              <h3 className="small-heading">{c.label}</h3>
              <StatusBadge tone={status[c.status].tone}>
                {status[c.status].label}
              </StatusBadge>
            </div>
            {c.reason && <p className="metadata muted">{c.reason}</p>}
            {c.status === "fail" && c.fix && (
              <p className="identifier">{c.fix}</p>
            )}
          </article>
        ))
      ) : (
        <p className="metadata muted" role="status">
          {readiness.state.status === "error"
            ? "Readiness is unavailable. Run again to retry."
            : "Loading readiness…"}
        </p>
      )}
    </Panel>
  );
}
