import { useCallback, useEffect, useRef } from "react";
import { discoveryStatusSchema } from "../../src/operator/contracts.js";
import { readinessSchema } from "../../src/operator/readiness.js";
import { Button, ResourceStatus, StatusBadge } from "./components.js";
import { useOperatorResource } from "./resource.js";
import {
  DraftMessage,
  key,
  Panel,
  useDraft,
  useHeaderRefresh,
  type SettingsProps,
} from "./settings.js";
import { useFragmentLanding } from "./settings-sections.js";

const status = {
  pass: { label: "Pass", tone: "success" },
  fail: { label: "Fail", tone: "error" },
  "not-configured": { label: "Not configured", tone: "idle" },
} as const;

/**
 * What the running service can and cannot use. Run again only re-reads. The GitHub
 * discovery row is the one place with a second action (frame 114c): when it is not
 * configured and a gh login is signed in, the fix line gives way to the existing one-step
 * `discovery.configure` with that login. Every other state keeps the server's fix line.
 */
export function ReadinessPanel(
  p: SettingsProps & {
    /** A discovery credential was saved here; the page re-reads its other views of it. */
    onDiscoveryChange: () => void;
  },
) {
  const loader = useCallback(
    (signal: AbortSignal) =>
      p.client.read("/api/operator/readiness", readinessSchema, signal),
    [p.client],
  );
  const readiness = useOperatorResource(p.session.csrfToken, loader);
  const discoveryLoader = useCallback(
    (signal: AbortSignal) =>
      p.client.read("/api/operator/discovery", discoveryStatusSchema, signal),
    [p.client],
  );
  const discovery = useOperatorResource(p.session.csrfToken, discoveryLoader);
  const reread = () => {
    readiness.refresh();
    discovery.refresh();
  };
  useHeaderRefresh(p.refreshNonce, reread);
  // A check's own article is a landing target (`#readiness-<check id>`) once it exists.
  useFragmentLanding(Boolean(readiness.state.data), (id) =>
    id.startsWith("readiness-"),
  );
  const checks = readiness.state.data?.data.checks;
  const d = useDraft(p.drafts, "discovery.configure:readiness");
  useEffect(() => d.startOperation({ key: key() }), [d]);
  // A recorded offer is spent once a read made after it answers; Clear then brings it back.
  const { fetchedAt, pending } = discovery.state;
  useEffect(() => {
    if (
      d.phase === "recorded" &&
      !pending &&
      fetchedAt !== null &&
      d.savedAt !== null &&
      fetchedAt >= d.savedAt
    )
      d.startOperation({ key: key() });
  }, [d, d.phase, d.savedAt, pending, fetchedAt]);
  const read = discovery.state;
  const gh = read.data?.data.gh;
  const offered =
    read.data && !read.error && !read.data.data.configured
      ? gh?.state === "signed-in"
        ? gh.login
        : null
      : null;
  const heading = useRef<HTMLHeadingElement>(null);
  // A recorded offer is announced once from the draft, so it re-reads the page's views
  // whichever instance sent it (this one may have mounted while the save was pending).
  // Focus moves to the check only if it was still on the offer, or nowhere: the offer leaves
  // once Readiness re-reads.
  const announced = useRef<number | null>(null);
  const { onDiscoveryChange } = p;
  useEffect(() => {
    if (d.phase !== "recorded" || d.savedAt === null) return;
    if (announced.current === d.savedAt) return;
    announced.current = d.savedAt;
    onDiscoveryChange();
    const h = heading.current,
      active = document.activeElement;
    if (
      h &&
      (active === document.body || h.closest("article")?.contains(active))
    ) {
      h.tabIndex = -1;
      h.focus({ preventScroll: true });
    }
  }, [d, d.phase, d.savedAt, onDiscoveryChange]);
  const offer = () =>
    d.submit(
      p.client,
      {
        type: "discovery.configure",
        key: d.values.key,
        credentialRef: "gh:github.com",
      },
      p.session.csrfToken,
    );
  return (
    <Panel
      id="readiness"
      title="Readiness"
      description="What the running service can use, with one fix for each problem."
      action={
        // Not disabled while reading: a new read cancels the old one, reads change
        // nothing, and a disabled button would drop keyboard focus.
        <Button type="button" variant="secondary" onClick={reread}>
          Run again
        </Button>
      }
    >
      <ResourceStatus
        label="Readiness checks"
        state={readiness.state}
        retry={readiness.refresh}
      />
      {checks?.map((c) => {
        const discoveryRow = c.id === "github-discovery";
        const showOffer =
          discoveryRow &&
          c.status === "not-configured" &&
          offered !== null &&
          d.phase !== "unknown";
        return (
          <article
            className="settings-row"
            key={c.id}
            id={`readiness-${c.id}`}
            aria-label={c.label}
          >
            <div className="settings-row-heading">
              <h3
                className="small-heading"
                ref={discoveryRow ? heading : undefined}
              >
                {c.label}
              </h3>
              <StatusBadge tone={status[c.status].tone}>
                {status[c.status].label}
              </StatusBadge>
            </div>
            {c.reason && <p className="metadata muted">{c.reason}</p>}
            {showOffer ? (
              <Button
                type="button"
                variant="secondary"
                // Stays in place while saving so focus is not dropped; the pending
                // save and a recorded one are not sent twice.
                aria-disabled={d.phase === "pending" || d.phase === "recorded"}
                className="aria-disabled:opacity-50"
                onClick={() =>
                  d.phase === "recorded" ? undefined : void offer()
                }
              >
                {d.phase === "pending"
                  ? "Saving…"
                  : `Use GitHub CLI login (@${offered})`}
              </Button>
            ) : (
              c.fix && <p className="identifier">{c.fix}</p>
            )}
            {discoveryRow && (
              <DraftMessage
                draft={d}
                success={null}
                check={() => d.reconcile(p.client, p.session.csrfToken)}
              />
            )}
          </article>
        );
      })}
    </Panel>
  );
}
