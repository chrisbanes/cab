import { useCallback, useEffect, useState } from "react";
import {
  claudeTokenStatusSchema,
  discoveryStatusSchema,
} from "../../src/operator/contracts.js";
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

interface ReferenceStatus {
  configured: boolean;
  available: boolean;
  state?: "not-configured" | "missing-value" | "restart-required" | "available";
}

/** An installation credential reference row: status line, Set/Change, Clear and Cancel. */
function ReferenceRow({
  p,
  endpoint,
  schema,
  type,
  title,
  fieldLabel,
  note,
  configuredLine,
}: {
  p: SettingsProps;
  endpoint: string;
  schema: typeof discoveryStatusSchema | typeof claudeTokenStatusSchema;
  type: "discovery.configure" | "claude-token.configure";
  title: string;
  fieldLabel: string;
  note: string;
  /** The line for a configured reference; never names it. */
  configuredLine: (s: ReferenceStatus) => string;
}) {
  const loader = useCallback(
    (signal: AbortSignal) =>
      p.client.read(endpoint, schema as typeof discoveryStatusSchema, signal),
    [p.client, endpoint, schema],
  );
  const status = useOperatorResource(p.session.csrfToken, loader);
  useHeaderRefresh(p.refreshNonce, status.refresh);
  const d = useDraft(p.drafts, type);
  useEffect(() => d.initialize(blank()), [d]);
  // An unsettled submission keeps the form open until it is reconciled.
  const [open, setOpen] = useState(false);
  const shown = open || d.phase === "unknown" || d.phase === "pending";
  const s: ReferenceStatus | undefined = status.state.data?.data;
  const line = s
    ? s.configured
      ? configuredLine(s)
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
    type,
    key: d.values.key,
    credentialRef,
  });
  return (
    <section className="settings-discovery" aria-label={title}>
      <div className="settings-discovery-line">
        <p className="metadata">
          {title} · {line}
        </p>
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
          <DraftField draft={d} field="credentialRef" label={fieldLabel} />
          <p className="metadata muted">{note}</p>
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

/** Frame 114: the installation's read-only GitHub discovery credential reference. */
export function DiscoveryCredentialRow(p: SettingsProps) {
  return (
    <ReferenceRow
      p={p}
      endpoint="/api/operator/discovery"
      schema={discoveryStatusSchema}
      type="discovery.configure"
      title="GitHub discovery credential"
      fieldLabel="Discovery credential reference"
      note="Use env:NAME; the value stays in the service environment. Ensemble only reads GitHub with this credential. Use a dedicated read-only token; agents may inherit the service environment."
      configuredLine={(s) =>
        s.available
          ? "reference configured · read-only"
          : "reference configured · no value in the service environment"
      }
    />
  );
}

/** The Claude subscription token reference, in the Runtime and recovery panel. */
export function ClaudeTokenRow(p: SettingsProps) {
  return (
    <ReferenceRow
      p={p}
      endpoint="/api/operator/claude-token"
      schema={claudeTokenStatusSchema}
      type="claude-token.configure"
      title="Claude subscription token"
      fieldLabel="Claude token reference"
      note="Use file:/absolute/path to an owner-only (chmod 600) file, or env:NAME. The value is passed only to the Claude process and is never shown. Create it with claude setup-token. Validity is checked when a Claude turn starts."
      configuredLine={(s) =>
        s.state === "restart-required"
          ? "reference configured · restart the service to use it"
          : s.available
            ? "reference configured · available"
            : "reference configured · token unavailable"
      }
    />
  );
}
