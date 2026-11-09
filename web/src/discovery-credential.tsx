import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { z } from "zod";
import {
  discoveryStatusSchema,
  type ghLoginStateSchema,
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
  useDiscoveryUnsettled,
  useDraft,
  useHeaderRefresh,
} from "./settings.js";

export type GhLogin = z.infer<typeof ghLoginStateSchema>;

/** The detected GitHub CLI login. */
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

/** The keychain caveat shown beside every one-click offer and in the form. */
export const discoveryUseNote =
  "cab only reads GitHub with this credential and removes it from agent and helper environments. If agents can reach this Mac's keychain they could run gh themselves; cab does not prevent that.";

/** Under an offer or the credential controls while another surface's save is unconfirmed. */
export const discoveryElsewhereNote =
  "A discovery credential save elsewhere isn't confirmed yet. Check it there first.";

/** The installation's read-only GitHub discovery credential. */
export function DiscoveryCredentialRow(
  p: SettingsProps & {
    /** A save or clear was recorded; the page re-reads what else shows this credential. */
    onChange?: () => void;
  },
) {
  const loader = useCallback(
    (signal: AbortSignal) =>
      p.client.read("/api/operator/discovery", discoveryStatusSchema, signal),
    [p.client],
  );
  const status = useOperatorResource(p.session.csrfToken, loader);
  useHeaderRefresh(p.refreshNonce, status.refresh);
  const d = useDraft(p.drafts, "discovery.configure");
  // The one-click offer has its own draft, so a save from it never opens the form.
  const offer = useDraft(p.drafts, "discovery.configure:offer");
  // A new visit starts clean; an unsettled one-click save stays until it is checked.
  useEffect(() => offer.startOperation({ key: key() }), [offer]);
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
    p.onChange?.();
    setOpen(false);
    d.startOperation(fresh(), true);
  };
  const reread = () => (d.phase === "recorded" ? settled() : status.refresh());
  // After a recorded one-click save the offer leaves; focus moves to Change once the re-read
  // shows it, unless the operator has moved on.
  const change = useRef<HTMLButtonElement>(null);
  const focusChange = useRef(false);
  const configured = s?.configured;
  useEffect(() => {
    if (!focusChange.current || !configured) return;
    focusChange.current = false;
    change.current?.focus();
  }, [configured]);
  const offerRecorded = () => {
    const at = document.activeElement;
    focusChange.current =
      at === document.body || Boolean(rowRef.current?.contains(at));
    status.refresh();
    p.onChange?.();
  };
  const rowRef = useRef<HTMLElement>(null);
  // A recorded offer is spent once a read made after it answers; its confirmation stays
  // until Clear brings the offer back.
  const { fetchedAt, pending } = status.state;
  useEffect(() => {
    if (
      offer.savedAt === null ||
      pending ||
      fetchedAt === null ||
      fetchedAt < offer.savedAt
    )
      return;
    if (offer.phase === "recorded")
      offer.startOperation({ key: key() }, Boolean(configured));
    else if (offer.phase === "editing" && !configured)
      offer.startOperation({ key: key() });
  }, [offer, offer.phase, offer.savedAt, pending, fetchedAt, configured]);
  const signedIn = gh?.state === "signed-in" ? gh : null;
  const offered =
    !status.state.error &&
    s &&
    !s.configured &&
    signedIn &&
    !shown &&
    offer.phase !== "unknown"
      ? signedIn.login
      : null;
  // Until the one-click save is settled, no other credential write may start: Check whether it
  // saved resends the original command, which would overwrite a newer reference.
  // The same holds for a save from another surface (Readiness, project setup).
  const elsewhere = useDiscoveryUnsettled(
    p.drafts,
    "discovery.configure",
    "discovery.configure:offer",
  );
  const elsewhereId = useId();
  const offerUnsettled =
    offer.phase === "pending" || offer.phase === "unknown" || elsewhere;
  const chooseLogin = async () => {
    await offer.submit(
      p.client,
      {
        type: "discovery.configure",
        key: offer.values.key,
        credentialRef: "gh:github.com",
      },
      p.session.csrfToken,
    );
    if (offer.phase === "recorded") offerRecorded();
  };
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
      ref={rowRef}
    >
      <div className="settings-discovery-line">
        <p className="metadata">GitHub discovery credential · {line}</p>
        {!shown && (
          <div className="settings-discovery-actions">
            {offered !== null && (
              <Button
                type="button"
                // Stays in place while saving so focus is not dropped; a pending or recorded
                // save is not sent twice.
                aria-disabled={
                  offer.phase === "pending" ||
                  offer.phase === "recorded" ||
                  elsewhere
                }
                aria-describedby={elsewhere ? elsewhereId : undefined}
                className="aria-disabled:opacity-50"
                onClick={() =>
                  offer.phase === "recorded" || elsewhere
                    ? undefined
                    : void chooseLogin()
                }
              >
                {offer.phase === "pending"
                  ? "Saving…"
                  : `Use GitHub CLI login (@${offered})`}
              </Button>
            )}
            <Button
              type="button"
              variant="secondary"
              ref={change}
              disabled={offerUnsettled}
              onClick={() => {
                // The form's own outcome replaces a kept one-click confirmation.
                offer.startOperation({ key: key() });
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
                disabled={locked(d) || offerUnsettled}
                onClick={clear}
              >
                Clear
              </Button>
            )}
          </div>
        )}
      </div>
      {offered !== null && <p className="metadata muted">{discoveryUseNote}</p>}
      {elsewhere && (
        <p id={elsewhereId} className="metadata muted">
          {discoveryElsewhereNote}
        </p>
      )}
      {!shown && <DraftMessage draft={d} />}
      {!shown && (
        <DraftMessage
          draft={offer}
          check={async () => {
            await offer.reconcile(p.client, p.session.csrfToken);
            if (offer.phase === "recorded") offerRecorded();
          }}
        />
      )}
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
          <p className="metadata muted">{discoveryUseNote}</p>
          <DraftOutcome
            draft={d}
            client={p.client}
            session={p.session}
            label={source === "gh" ? "Use this login" : "Save reference"}
            saveDisabled={
              elsewhere || (source === "gh" && gh?.state !== "signed-in")
            }
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
