import { useCallback, useEffect, useState } from "react";
import type { z } from "zod";
import {
  issueTrackerCredentialsSchema,
  jiraPreviewSchema,
  projectPrivateValuesSchema,
} from "../../src/operator/contracts.js";
import { ClientError } from "./api.js";
import { Button } from "./components.js";
import type { TabProps } from "./project-config.js";
import { useOperatorResource } from "./resource.js";
import {
  DraftField,
  DraftMessage,
  DraftOutcome,
  key,
  locked,
  Panel,
  submitDraft,
  useDraft,
  useHeaderRefresh,
  useLoadedDraft,
  usePrivateValues,
} from "./settings.js";
import { clockLabel } from "./presentation.js";
import type { ObservationResource } from "./sync-placement.js";
import { NativeSelect } from "./ui/native-select.js";

type Credential = z.infer<
  typeof issueTrackerCredentialsSchema
>["data"]["credentials"][number];

const envName = /^[A-Z][A-Z0-9_]*$/;

const reasonCopy: Record<NonNullable<Credential["reason"]>, string> = {
  "missing-credential": "a variable has no value in the service environment",
  "site-invalid":
    "the site variable must be an https:// address with no path or port",
  "site-mismatch": "the site variable now names a different site",
  "site-unreachable": "the site could not be reached",
  "not-jira": "the address is not a Jira Cloud site",
  unauthorized: "Jira rejected the email and token",
};

/** The installation's Jira site credentials: three environment variable names per site. */
function JiraCredentials({
  client,
  session,
  drafts,
  refreshNonce,
}: Pick<TabProps, "client" | "session" | "drafts"> & {
  refreshNonce?: number | undefined;
}) {
  const loader = useCallback(
    (signal: AbortSignal) =>
      client.read(
        "/api/operator/issue-tracker-credentials",
        issueTrackerCredentialsSchema,
        signal,
      ),
    [client],
  );
  const status = useOperatorResource(session.csrfToken, loader);
  useHeaderRefresh(refreshNonce, status.refresh);
  const d = useDraft(drafts, "issue-tracker-credential.configure");
  const blank = () => ({ site: "", email: "", token: "", key: key() });
  useEffect(() => d.initialize(blank()), [d]);
  const [open, setOpen] = useState(false);
  const credentials = status.state.data?.data.credentials;
  const shown = open || d.phase === "unknown" || d.phase === "pending";
  const names = ["site", "email", "token"].map((f) =>
    String(d.values[f] ?? "").trim(),
  );
  const errors = Object.fromEntries(
    (["site", "email", "token"] as const).flatMap((f, i) =>
      envName.test(names[i] ?? "")
        ? []
        : [
            [
              f,
              "Use upper-case letters, digits and underscores, starting with a letter.",
            ],
          ],
    ),
  );
  const settled = () => {
    status.refresh();
    setOpen(false);
    d.startOperation(blank(), true);
  };
  const reread = () => (d.phase === "recorded" ? settled() : status.refresh());
  const clear = async (instance: string) => {
    await d.submit(
      client,
      {
        type: "issue-tracker-credential.configure",
        key: key(),
        issueTracker: "jira",
        instance,
        clear: true,
      },
      session.csrfToken,
    );
    if (d.phase === "recorded") settled();
  };
  return (
    <section aria-label="Jira credentials">
      <h3 className="small-heading">Jira site credentials</h3>
      {credentials?.map((c) => (
        <div className="settings-discovery-line" key={c.instance}>
          <p className="metadata">
            Jira {c.instance} ·{" "}
            {c.usable
              ? `${c.account?.displayName ?? "account"} · read-only use`
              : reasonCopy[c.reason ?? "missing-credential"]}
          </p>
          {!shown && (
            <Button
              type="button"
              variant="secondary"
              disabled={locked(d)}
              onClick={() => void clear(c.instance)}
            >
              Clear {c.instance}
            </Button>
          )}
        </div>
      ))}
      {!credentials && (
        <p className="metadata">
          {status.state.error ? "Status unavailable" : "Loading"}
        </p>
      )}
      {credentials?.length === 0 && !shown && (
        <p className="metadata">No Jira site credential is configured.</p>
      )}
      {!shown && (
        <Button
          type="button"
          variant="secondary"
          onClick={() => {
            d.startOperation(blank());
            setOpen(true);
          }}
        >
          Add Jira site
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
              client,
              session,
              {
                type: "issue-tracker-credential.configure",
                key: String(d.values.key),
                issueTracker: "jira",
                siteRef: `env:${names[0]}`,
                emailRef: `env:${names[1]}`,
                tokenRef: `env:${names[2]}`,
              },
              reread,
              errors,
            )
          }
        >
          <DraftField draft={d} field="site" label="Site variable name" />
          <DraftField draft={d} field="email" label="Email variable name" />
          <DraftField draft={d} field="token" label="API token variable name" />
          <p className="metadata muted">
            Names only; env: is implied. The site variable holds the https
            address, such as https://example.atlassian.net. cab only reads Jira
            with this credential and removes the three variables from agent and
            helper environments.
          </p>
          <DraftOutcome
            draft={d}
            client={client}
            session={session}
            label="Save references"
            refresh={reread}
            success={null}
          />
          {d.phase !== "pending" && d.phase !== "unknown" && (
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
          )}
        </form>
      )}
    </section>
  );
}

type Preview =
  | { jql: string; matches: string[]; more: boolean }
  | { jql: string; error: string };

/** A Jira project's source: the site, one JQL query per selection, preview and sync state. */
export function JiraSourceTab(
  p: TabProps & { observations: ObservationResource },
) {
  const { data, projectId } = p;
  const saved = data.source.tracker === "jira";
  const d = useDraft(p.drafts, `jira.configure:${projectId}`);
  const priv = usePrivateValues(
    p.client,
    p.session,
    `/api/operator/projects/${projectId}/private-values`,
    projectPrivateValuesSchema,
    {
      autoLoad: saved,
      loaded: data.source.version,
      version: (r) => r.data.source.version,
      refreshLoaded: p.refreshConfiguration,
    },
  );
  const privateData = priv.state.data?.data.source;
  const known =
    privateData?.version === data.source.version ? privateData : undefined;
  const sites = useOperatorResource(
    p.session.csrfToken,
    useCallback(
      (signal: AbortSignal) =>
        p.client.read(
          "/api/operator/issue-tracker-credentials",
          issueTrackerCredentialsSchema,
          signal,
        ),
      [p.client],
    ),
  );
  const loadedJql = (known?.jql ?? []).map((s) => s.jql).join("\n");
  useLoadedDraft(
    d,
    saved && !known
      ? null
      : {
          expectedVersion: String(data.source.version),
          instance: saved ? String(data.source.instance ?? "") : "",
          jql: loadedJql,
          key: key(),
        },
    p.loadedAt,
    [data.source.version, loadedJql],
  );
  const lines = String(d.values.jql ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const instance = String(d.values.instance ?? "");
  const [previews, setPreviews] = useState<Preview[] | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const preview = async () => {
    setPreviewing(true);
    const results: Preview[] = [];
    for (const jql of lines)
      try {
        const read = await p.client.read(
          `/api/operator/jira/preview?${new URLSearchParams({ instance, jql })}`,
          jiraPreviewSchema,
        );
        results.push({
          jql,
          matches: read.data.matches.map(
            (m) => `${m.key} · ${m.title ?? ""} · ${m.status ?? ""}`,
          ),
          more: read.data.more,
        });
      } catch (error) {
        results.push({
          jql,
          error:
            error instanceof ClientError && error.publicMessage
              ? error.publicMessage
              : "Jira could not run this query.",
        });
      }
    setPreviews(results);
    setPreviewing(false);
  };
  const [refreshing, setRefreshing] = useState(false);
  const refresh = async () => {
    setRefreshing(true);
    await p.client.refreshSources(p.session.csrfToken).catch(() => {});
    p.observations.refresh();
    setRefreshing(false);
  };
  const observed = p.observations.state.data?.data.projects.find(
    (r) => r.projectId === projectId,
  );
  const errorKey = Object.keys(d.errors)[0];
  const usable = (sites.state.data?.data.credentials ?? []).filter(
    (c) => c.usable,
  );
  const blocked = !instance || lines.length === 0 || lines.length > 30;
  return (
    <div className="settings-split settings-split-even">
      <div className="settings-column">
        <Panel
          id="jira-source"
          title="Jira source"
          description="Each line is one JQL query. cab imports the issues each query matches; titles and descriptions stay read-only here."
        >
          <form
            onSubmit={(e) =>
              void submitDraft(
                e,
                d,
                p.client,
                p.session,
                {
                  type: "jira.configure",
                  key: String(d.values.key),
                  projectId,
                  expectedVersion: data.source.version,
                  instance,
                  selections: lines.map((jql, i) => ({
                    id: `S-${i + 1}`,
                    kind: "jql",
                    jql,
                  })),
                },
                p.refreshConfiguration,
                blocked ? { jql: "Enter a site and at least one query." } : {},
              )
            }
          >
            <label className="field body">
              Jira site
              <NativeSelect
                aria-label="Jira site"
                className="control"
                disabled={locked(d) || saved}
                value={instance}
                onChange={(e) => d.set("instance", e.target.value)}
              >
                <option value="">Choose a site</option>
                {(saved && !usable.some((c) => c.instance === instance)
                  ? [...usable.map((c) => c.instance), instance]
                  : usable.map((c) => c.instance)
                ).map((site) => (
                  <option key={site} value={site}>
                    {site}
                  </option>
                ))}
              </NativeSelect>
            </label>
            {usable.length === 0 && !saved && (
              <p className="metadata muted">
                Add a Jira site credential below first.
              </p>
            )}
            <DraftField
              draft={d}
              field="jql"
              errorField={errorKey ?? "jql"}
              label="JQL queries, one per line"
              multiline
            />
            <div className="settings-actions">
              <Button
                type="button"
                variant="secondary"
                disabled={previewing || blocked || locked(d)}
                onClick={() => void preview()}
              >
                {previewing ? "Previewing…" : "Preview matches"}
              </Button>
            </div>
            {previews?.map((r) => (
              <div key={r.jql} className="metadata">
                <p data-private>{r.jql}</p>
                {"error" in r ? (
                  <p role="alert">{r.error}</p>
                ) : (
                  <ul>
                    {r.matches.map((m) => (
                      <li key={m}>{m}</li>
                    ))}
                    {r.more && <li>More matches not shown</li>}
                    {r.matches.length === 0 && <li>No matches</li>}
                  </ul>
                )}
              </div>
            ))}
            <DraftOutcome
              draft={d}
              client={p.client}
              session={p.session}
              label="Save Jira source"
              saveDisabled={blocked}
              refresh={p.refreshConfiguration}
              success={null}
              caveat="Saving replaces the selections and activates them all. Jira checks each new or changed query first; a rejected query saves nothing."
            />
          </form>
        </Panel>
        {saved && (
          <Panel
            title="Sync"
            description="cab reads Jira on a schedule. Imported tasks wait for their blockers to be read before they can start."
            action={
              <Button
                type="button"
                variant="secondary"
                disabled={refreshing}
                onClick={() => void refresh()}
              >
                {refreshing ? "Refreshing…" : "Refresh now"}
              </Button>
            }
          >
            {data.source.selections.map((s) => {
              const o = observed?.selections.find(
                (x) => x.selectionId === s.id,
              );
              return (
                <p className="metadata" key={s.id ?? "unnamed"}>
                  {s.id} ·{" "}
                  {o?.lastSuccessfulAt
                    ? `last synced ${clockLabel(Date.parse(o.lastSuccessfulAt))}`
                    : o?.state === "partial"
                      ? "last read was incomplete"
                      : "not synced yet"}
                  {o?.counts
                    ? ` · ${o.counts.observed} issues, ${o.counts.open} open`
                    : ""}
                </p>
              );
            })}
          </Panel>
        )}
      </div>
      <div className="settings-column">
        <JiraCredentials
          client={p.client}
          session={p.session}
          drafts={p.drafts}
          refreshNonce={p.refreshNonce}
        />
      </div>
    </div>
  );
}
