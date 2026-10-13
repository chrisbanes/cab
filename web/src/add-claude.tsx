import { useCallback, useMemo, useRef, useState } from "react";
import { claudeTokenCheckSchema } from "../../src/operator/readiness.js";
import { ActionOutcome } from "./action-feedback.js";
import { Button, StatusBadge } from "./components.js";
import { ClaudeTokenRow } from "./discovery-credential.js";
import { useOperatorResource } from "./resource.js";
import { Panel, type SettingsProps, useHeaderRefresh } from "./settings.js";
import type { ConfigurationDrafts } from "./settings-state.js";
import "./add-claude.css";

/**
 * The token-file commands of docs/operations/standalone-macos.md#claude-subscription-token,
 * with the suggested private path. Only the setup commands are copied: the `pbpaste` line
 * reads the clipboard, so copying it would replace the token with the commands. The operator
 * types it after copying the token. The token never passes through this page.
 */
const claudeTokenSetup = [
  'mkdir -m 700 -p "$HOME/.ensemble/claude"',
  'install -m 600 /dev/null "$HOME/.ensemble/claude/claude-token"',
].join("\n");
const claudeTokenWrite = [
  'pbpaste > "$HOME/.ensemble/claude/claude-token"',
  "stat -f '%Su %Lp' \"$HOME/.ensemble/claude/claude-token\"",
].join("\n");

const status = {
  pass: { label: "Pass", tone: "success" },
  fail: { label: "Fail", tone: "error" },
  "not-configured": { label: "Not configured", tone: "neutral" },
} as const;

const DRAFT = "claude-token.configure";

/**
 * Drafts that report when the Claude token save is recorded, without taking the row's
 * render callback: `ConfigurationDraft.bind` keeps one listener, so a second `useDraft` on
 * the same key would silence the row.
 */
function observed(drafts: ConfigurationDrafts, onSaved: () => void) {
  let seen = drafts.saved(DRAFT)?.at;
  return Object.assign(Object.create(drafts) as ConfigurationDrafts, {
    get: (key: string, changed: () => void) =>
      drafts.get(key, () => {
        changed();
        const at = drafts.saved(DRAFT)?.at;
        if (key === DRAFT && at !== seen) {
          seen = at;
          onSaved();
        }
      }),
  });
}

function Commands() {
  const [copied, setCopied] = useState<"idle" | "copied" | "failed">("idle");
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(claudeTokenSetup);
      setCopied("copied");
    } catch {
      setCopied("failed");
    }
  };
  return (
    <div className="settings-row">
      <p className="body">
        1. In a terminal, create a private, empty token file. The token never
        passes through this page.
      </p>
      <pre className="identifier token-commands">{claudeTokenSetup}</pre>
      <div>
        <Button type="button" variant="secondary" onClick={copy}>
          Copy commands
        </Button>
      </div>
      {copied === "copied" && <ActionOutcome tone="success" message="Copied" />}
      {copied === "failed" && (
        <ActionOutcome
          tone="error"
          message="Copy unavailable. Select the commands and copy them by hand."
        />
      )}
      <p className="body">
        2. Copy the token printed by <code>claude setup-token</code>, then type
        these lines yourself. Do not copy them: <code>pbpaste</code> reads the
        clipboard, and copying would replace the token. <code>stat</code> must
        show your user and <code>600</code>.
      </p>
      <pre className="identifier token-commands token-write">
        {claudeTokenWrite}
      </pre>
      <p className="metadata muted">
        3. Enter the reference below as <code>file:</code> followed by the
        absolute path, with <code>$HOME</code> replaced by your home directory,
        or <code>env:NAME</code>, and save.
      </p>
    </div>
  );
}

/** The live Token readable check: the service reads the reference now. */
function TokenReadable(p: SettingsProps & { checkNonce: number }) {
  const loader = useCallback(
    (signal: AbortSignal) =>
      p.client.read(
        "/api/operator/readiness/claude-token",
        claudeTokenCheckSchema,
        signal,
      ),
    [p.client],
  );
  const check = useOperatorResource(p.session.csrfToken, loader);
  useHeaderRefresh(p.refreshNonce, check.refresh);
  useHeaderRefresh(p.checkNonce, check.refresh);
  const c = check.state.data?.data;
  return (
    <section className="settings-row" aria-label="Token readable">
      <div className="settings-row-heading">
        <h3 className="small-heading">Token readable</h3>
        {c && (
          <StatusBadge tone={status[c.status].tone}>
            {status[c.status].label}
          </StatusBadge>
        )}
      </div>
      {c?.reason && <p className="metadata muted">{c.reason}</p>}
      {c?.status === "fail" && c.fix && <p className="metadata">{c.fix}</p>}
      {!c && (
        <p className="metadata muted" role="status">
          {check.state.status === "error"
            ? "The check is unavailable."
            : "Checking…"}
        </p>
      )}
    </section>
  );
}

/** Add Claude: token-file commands, the reference row and a live readability check. */
export function AddClaudePanel(p: SettingsProps) {
  const [checkNonce, setCheckNonce] = useState(0);
  const bump = useRef(() => {});
  bump.current = () => setCheckNonce((n) => n + 1);
  const drafts = useMemo(
    () => observed(p.drafts, () => bump.current()),
    [p.drafts],
  );
  return (
    <Panel
      title="Add Claude"
      description="Make a Claude subscription token available to the service and confirm it works."
    >
      <Commands />
      <ClaudeTokenRow {...p} drafts={drafts} />
      <TokenReadable {...p} checkNonce={checkNonce} />
    </Panel>
  );
}
