import { useCallback, useEffect, useState } from "react";
import type { z } from "zod";
import {
  claudeTokenStatusSchema,
  discoveryStatusSchema,
  type ghLoginStateSchema,
  setupHomeSchema,
} from "../../src/operator/contracts.js";
import { Button } from "./components.js";
import { useOperatorResource } from "./resource.js";
import {
  DraftField,
  DraftMessage,
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
  prefill,
  validate,
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
  /**
   * A reference to put in an empty field when Set opens it. It is applied once, at the click,
   * and only while no reference is configured; a later change of this prop never touches the form.
   */
  prefill?: string | undefined;
  /** Field errors for a reference; when any is present nothing is sent. */
  validate?: (reference: string) => Record<string, string>;
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
    // The closed row confirms the save until the next edit.
    d.startOperation(blank(), true);
  };
  // A recorded save closes the form; any other answer only re-reads the status.
  const reread = () => (d.phase === "recorded" ? settled() : status.refresh());
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
            onClick={() => {
              // A configured reference is never loaded, a typed one wins, and a late read does nothing.
              if (
                prefill &&
                status.state.status === "fresh" &&
                s?.configured === false &&
                String(d.values.credentialRef ?? "") === ""
              )
                d.startOperation({ credentialRef: prefill, key: key() });
              setOpen(true);
            }}
          >
            {s?.configured ? "Change" : "Set"}
          </Button>
        )}
      </div>
      {!shown && <DraftMessage draft={d} />}
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
              reread,
              validate?.(String(d.values.credentialRef ?? "")),
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
            refresh={reread}
            success={null}
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

export type GhLogin = z.infer<typeof ghLoginStateSchema>;

/** The detected GitHub CLI login, as frames 114 and 114b word it. */
export function ghLoginCopy(gh: GhLogin) {
  switch (gh.state) {
    case "signed-in":
      return `Signed in to github.com as @${gh.login}`;
    case "not-installed":
      return "gh not installed";
    case "not-signed-in":
      return "gh not signed in · run gh auth login";
    case "unreadable":
      return "gh login unreadable from the service";
  }
}

const envName = /^[A-Z][A-Z0-9_]*$/;

/** Frames 114 and 114b: the installation's read-only GitHub discovery credential. */
export function DiscoveryCredentialRow(p: SettingsProps) {
  const loader = useCallback(
    (signal: AbortSignal) =>
      p.client.read("/api/operator/discovery", discoveryStatusSchema, signal),
    [p.client],
  );
  const status = useOperatorResource(p.session.csrfToken, loader);
  useHeaderRefresh(p.refreshNonce, status.refresh);
  const d = useDraft(p.drafts, "discovery.configure");
  const s = status.state.data?.data;
  const fresh = () => ({
    source: s?.source ?? "gh",
    name: "",
    key: key(),
  });
  // biome-ignore lint/correctness/useExhaustiveDependencies: initialize once per draft.
  useEffect(() => d.initialize(fresh()), [d]);
  // An unsettled submission keeps the form open until it is reconciled.
  const [open, setOpen] = useState(false);
  const shown = open || d.phase === "unknown" || d.phase === "pending";
  const gh = s?.gh;
  const line = s
    ? !s.configured
      ? "not configured"
      : s.source === "gh"
        ? gh?.state === "signed-in"
          ? `GitHub CLI · @${gh.login} · read-only use`
          : `GitHub CLI · ${gh ? ghLoginCopy(gh) : "unavailable"}`
        : s.available
          ? "environment variable · read-only use"
          : "environment variable · no value in the service environment"
    : status.state.error
      ? "status unavailable"
      : "loading";
  const settled = () => {
    status.refresh();
    setOpen(false);
    d.startOperation(fresh(), true);
  };
  const reread = () => (d.phase === "recorded" ? settled() : status.refresh());
  const send = (credentialRef: string | null) => ({
    type: "discovery.configure",
    key: d.values.key,
    credentialRef,
  });
  const source = d.values.source === "env" ? "env" : "gh";
  const name = String(d.values.name ?? "").trim();
  const busy = d.phase === "unknown" || d.phase === "pending";
  const clear = async () => {
    await d.submit(p.client, send(null), p.session.csrfToken);
    if (d.phase === "recorded") settled();
  };
  return (
    <section
      className="settings-discovery"
      aria-label="GitHub discovery credential"
    >
      <div className="settings-discovery-line">
        <p className="metadata">GitHub discovery credential · {line}</p>
        {!shown && (
          <div className="settings-discovery-actions">
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                d.startOperation(fresh());
                setOpen(true);
              }}
            >
              {s?.configured ? "Change" : "Set"}
            </Button>
            {s?.configured && (
              <Button
                type="button"
                variant="secondary"
                disabled={locked(d)}
                onClick={clear}
              >
                Clear
              </Button>
            )}
          </div>
        )}
      </div>
      {!shown && <DraftMessage draft={d} />}
      {shown && (
        <form
          className="settings-discovery-form"
          onSubmit={(e) =>
            void submitDraft(
              e,
              d,
              p.client,
              p.session,
              send(source === "gh" ? "gh:github.com" : `env:${name}`),
              reread,
              source === "env" && !envName.test(name)
                ? {
                    name: "Use upper-case letters, digits and underscores, starting with a letter.",
                  }
                : {},
            )
          }
        >
          <fieldset className="settings-discovery-source" disabled={busy}>
            <legend className="sr-only">Discovery credential source</legend>
            <label className="body check-field">
              <input
                type="radio"
                name="discovery-source"
                checked={source === "gh"}
                onChange={() => d.set("source", "gh")}
              />
              GitHub CLI · recommended
            </label>
            {source === "gh" && (
              <p className="metadata" role="status">
                {gh ? ghLoginCopy(gh) : "Detecting the GitHub CLI login…"}
              </p>
            )}
            <label className="body check-field">
              <input
                type="radio"
                name="discovery-source"
                checked={source === "env"}
                onChange={() => d.set("source", "env")}
              />
              Environment variable · advanced
            </label>
          </fieldset>
          {source === "env" && (
            <>
              <DraftField draft={d} field="name" label="Variable name" />
              <p className="metadata muted">
                Name only; env: is implied. The variable must be in the service
                environment.
              </p>
            </>
          )}
          <p className="metadata muted">
            Ensemble only reads GitHub with this credential and removes it from
            agent and helper environments. If agents can reach this Mac's
            keychain they could run gh themselves; Ensemble does not prevent
            that.
          </p>
          <DraftOutcome
            draft={d}
            client={p.client}
            session={p.session}
            label={source === "gh" ? "Use this login" : "Save reference"}
            saveDisabled={source === "gh" && gh?.state !== "signed-in"}
            refresh={reread}
            success={null}
          />
          {!busy && (
            <div className="settings-actions">
              <Button
                type="button"
                variant="secondary"
                onClick={() => {
                  setOpen(false);
                  d.startOperation(fresh());
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

const claudeTokenPath = "/.ensemble/claude/claude-token";
/** `~`, `$HOME` or `${HOME}` at the start of a reference, with or without `file:`. */
const homeForm = /^(?:file:)?(?:~|\$HOME|\$\{HOME\})(?=\/|$)/;

/** The Claude subscription token reference, in the Runtime and recovery panel. */
export function ClaudeTokenRow(p: SettingsProps & { prefill?: boolean }) {
  const loader = useCallback(
    (signal: AbortSignal) =>
      p.client.read("/api/operator/setup/home", setupHomeSchema, signal),
    [p.client],
  );
  // A missing, failed or pending read leaves the field as it was: empty, with no error.
  const read = useOperatorResource(p.session.csrfToken, loader);
  const home = read.state.data?.data.home ?? null;
  const current = read.state.status === "fresh" ? home : null;
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
      prefill={
        p.prefill && current ? `file:${current}${claudeTokenPath}` : undefined
      }
      validate={(reference) => {
        const text = reference.trim();
        const form = homeForm.exec(text);
        if (!form) return {};
        return {
          credentialRef: home
            ? `Use the full path: file:${home}${text.slice(form[0].length)}. ~ and $HOME are not expanded.`
            : "Use the full path: replace ~ or $HOME with your home folder's absolute path.",
        };
      }}
    />
  );
}
