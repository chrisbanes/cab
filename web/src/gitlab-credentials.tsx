import { useCallback, useEffect, useState } from "react";
import type { z } from "zod";
import { codeHostCredentialsSchema } from "../../src/operator/contracts.js";
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

type Credential = z.infer<
  typeof codeHostCredentialsSchema
>["data"]["credentials"][number];

const envName = /^[A-Z][A-Z0-9_]*$/;
const hostName =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
const blank = (host = "") => ({ host, source: "glab", name: "", key: key() });

const reasonCopy: Record<
  Extract<Credential, { state: "unavailable" }>["reason"],
  string
> = {
  "missing-credential": "no value in the service environment",
  "glab-not-installed": "glab is not installed for the service",
  "glab-not-signed-in":
    "glab is not signed in to this host · run glab auth login",
  "glab-unreadable": "the glab login could not be read",
  unauthorized: "GitLab rejected the credential",
  forbidden: "the credential cannot read this host",
  "rate-limited": "GitLab's rate limit was reached",
  unreadable: "GitLab could not be read",
};

const line = (c: Credential) =>
  `${c.kind === "glab" ? "GitLab CLI" : "Environment variable"} · ${
    c.state === "usable"
      ? `@${c.account} · read-only use`
      : reasonCopy[c.reason]
  }`;

/** The installation's read-only GitLab credential per host. */
export function GitLabCredentialsSection(p: SettingsProps) {
  const loader = useCallback(
    (signal: AbortSignal) =>
      p.client.read(
        "/api/operator/code-host-credentials",
        codeHostCredentialsSchema,
        signal,
      ),
    [p.client],
  );
  const status = useOperatorResource(p.session.csrfToken, loader);
  useHeaderRefresh(p.refreshNonce, status.refresh);
  const d = useDraft(p.drafts, "code-host-credential.configure");
  useEffect(() => d.initialize(blank()), [d]);
  // The host being edited; "" is a new host and null closes the form.
  const [editing, setEditing] = useState<string | null>(null);
  const shown =
    editing !== null || d.phase === "unknown" || d.phase === "pending";
  const credentials = status.state.data?.data.credentials;
  const send = (host: string, credentialRef: string | null, k: string) => ({
    type: "code-host-credential.configure",
    key: k,
    codeHost: "gitlab",
    host,
    credentialRef,
  });
  const settled = () => {
    status.refresh();
    setEditing(null);
    d.startOperation(blank(), true);
  };
  const reread = () => (d.phase === "recorded" ? settled() : status.refresh());
  const host = String(d.values.host ?? "").trim();
  const source = d.values.source === "env" ? "env" : "glab";
  const name = String(d.values.name ?? "").trim();
  const errors = {
    ...(editing === "" && (!hostName.test(host) || host === "github.com")
      ? { host: "Enter the GitLab host, such as gitlab.example.com." }
      : {}),
    ...(source === "env" && !envName.test(name)
      ? {
          name: "Use upper-case letters, digits and underscores, starting with a letter.",
        }
      : {}),
  };
  const clear = async (c: Credential) => {
    await d.submit(p.client, send(c.host, null, key()), p.session.csrfToken);
    if (d.phase === "recorded") settled();
  };
  return (
    <section className="settings-discovery" aria-label="GitLab credentials">
      {credentials?.map((c) => (
        <article className="settings-row" key={c.host}>
          <div className="settings-discovery-line">
            <p className="metadata">
              GitLab {c.host} · {line(c)}
            </p>
            {!shown && (
              <div className="settings-discovery-actions">
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => {
                    d.startOperation(blank(c.host));
                    setEditing(c.host);
                  }}
                >
                  Change {c.host}
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  disabled={locked(d)}
                  onClick={() => void clear(c)}
                >
                  Clear {c.host}
                </Button>
              </div>
            )}
          </div>
          {c.glabOverridden && (
            <p className="metadata" role="status">
              GITLAB_TOKEN, GITLAB_ACCESS_TOKEN or OAUTH_TOKEN in the service
              environment overrides this glab login, so the account above is the
              token's, not the login's. Unset it, or choose an environment
              variable.
            </p>
          )}
        </article>
      ))}
      {!credentials && (
        <p className="metadata">
          {status.state.error ? "Status unavailable" : "Loading"}
        </p>
      )}
      {credentials?.length === 0 && !shown && (
        <p className="metadata">GitLab credentials · not configured</p>
      )}
      {!shown && (
        <Button
          type="button"
          variant="secondary"
          onClick={() => {
            d.startOperation(blank());
            setEditing("");
          }}
        >
          Add GitLab host
        </Button>
      )}
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
              send(
                host,
                source === "glab" ? `glab:${host}` : `env:${name}`,
                String(d.values.key),
              ),
              reread,
              errors,
            )
          }
        >
          {editing === "" ? (
            <DraftField draft={d} field="host" label="GitLab host" />
          ) : (
            <p className="metadata">GitLab {host}</p>
          )}
          <fieldset
            className="settings-discovery-source"
            disabled={d.phase === "pending" || d.phase === "unknown"}
          >
            <legend className="sr-only">GitLab credential source</legend>
            <label className="body check-field">
              <input
                type="radio"
                name="gitlab-source"
                checked={source === "glab"}
                onChange={() => d.set("source", "glab")}
              />
              GitLab CLI login · recommended
            </label>
            <label className="body check-field">
              <input
                type="radio"
                name="gitlab-source"
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
            cab only reads GitLab with this credential, to list projects and
            show the account, and removes it from agent and helper environments.
            It grants no repository access. If agents can reach this Mac's glab
            login they could run glab themselves; cab does not prevent that.
          </p>
          <DraftOutcome
            draft={d}
            client={p.client}
            session={p.session}
            label={source === "glab" ? "Use this login" : "Save reference"}
            refresh={reread}
            success={null}
          />
          {d.phase !== "pending" && d.phase !== "unknown" && (
            <div className="settings-actions">
              <Button
                type="button"
                variant="secondary"
                onClick={() => {
                  setEditing(null);
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
