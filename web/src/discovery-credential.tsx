import { useCallback, useEffect, useState } from "react";
import { discoveryStatusSchema } from "../../src/operator/contracts.js";
import { Button } from "./components.js";
import { useOperatorResource } from "./resource.js";
import {
  DraftField,
  DraftOutcome,
  key,
  locked,
  type SettingsProps,
  submitDraft,
  useDraft,
  useHeaderRefresh,
} from "./settings.js";

const blank = () => ({ credentialRef: "", key: key() });

/** Frame 114: the installation's read-only GitHub discovery credential reference. */
export function DiscoveryCredentialRow(p: SettingsProps) {
  const loader = useCallback(
    (signal: AbortSignal) =>
      p.client.read("/api/operator/discovery", discoveryStatusSchema, signal),
    [p.client],
  );
  const status = useOperatorResource(p.session.csrfToken, loader);
  useHeaderRefresh(p.refreshNonce, status.refresh);
  const d = useDraft(p.drafts, "discovery.configure");
  useEffect(() => d.initialize(blank()), [d]);
  // An unsettled submission keeps the form open until it is reconciled.
  const [open, setOpen] = useState(false);
  const shown = open || d.phase === "unknown" || d.phase === "pending";
  const s = status.state.data?.data;
  const line = s
    ? s.configured
      ? s.available
        ? "reference configured · read-only"
        : "reference configured · no value in the service environment"
      : "not configured"
    : status.state.error
      ? "status unavailable"
      : "loading";
  const settled = () => {
    status.refresh();
    setOpen(false);
    d.startOperation(blank());
  };
  const send = (credentialRef: string | null) => ({
    type: "discovery.configure",
    key: d.values.key,
    credentialRef,
  });
  return (
    <section
      className="settings-discovery"
      aria-label="GitHub discovery credential"
    >
      <div className="settings-discovery-line">
        <p className="metadata">GitHub discovery credential · {line}</p>
        {!shown && (
          <Button
            type="button"
            variant="secondary"
            onClick={() => setOpen(true)}
          >
            {s?.configured ? "Change" : "Set"}
          </Button>
        )}
      </div>
      {shown && (
        <form
          className="settings-discovery-form"
          onSubmit={(e) =>
            void submitDraft(
              e,
              d,
              p.client,
              p.session,
              send(String(d.values.credentialRef ?? "")),
              settled,
            )
          }
        >
          <DraftField
            draft={d}
            field="credentialRef"
            label="Discovery credential reference"
          />
          <p className="metadata muted">
            Use env:NAME; the value stays in the service environment. Ensemble
            only reads GitHub with this credential. Use a dedicated read-only
            token; agents may inherit the service environment.
          </p>
          <DraftOutcome
            draft={d}
            client={p.client}
            session={p.session}
            label="Save reference"
            onRecorded={settled}
          />
          {d.phase !== "unknown" && d.phase !== "pending" && (
            <div className="settings-actions">
              {s?.configured && (
                <Button
                  type="button"
                  variant="secondary"
                  disabled={locked(d)}
                  onClick={async () => {
                    await d.submit(p.client, send(null), p.session.csrfToken);
                    if (d.phase === "recorded") settled();
                  }}
                >
                  Clear reference
                </Button>
              )}
              <Button
                type="button"
                variant="secondary"
                onClick={() => {
                  setOpen(false);
                  d.startOperation(blank());
                }}
              >
                Cancel
              </Button>
            </div>
          )}
        </form>
      )}
    </section>
  );
}
