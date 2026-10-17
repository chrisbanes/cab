import { useCallback, useEffect, useRef, useState } from "react";
import {
  CircleCheck,
  CirclePause,
  CircleQuestionMark,
  CircleSlash,
} from "lucide-react";
import {
  projectConfigurationSchema,
  runtimeSettingsSchema,
  sourceObservationSchema,
} from "../../src/operator/contracts.js";
import type { OperatorClient } from "./api.js";
import {
  projectLabel,
  workspaceLabels,
} from "../../src/operator/project-labels.js";
import { ActionLink, Button, ProjectName, StatusBadge } from "./components.js";
import {
  ClaudeTokenRow,
  DiscoveryCredentialRow,
} from "./discovery-credential.js";
import { runtimeSummary } from "./execution-runtime.js";
import { OperatorCredentialsSection } from "./operator-credentials.js";
import { ReadinessPanel } from "./readiness.js";
import { useOperatorResource } from "./resource.js";
import type { ProjectConfigurationData } from "./settings-changes.js";
import { Panel, useHeaderRefresh, type SettingsProps } from "./settings.js";
import {
  observationLabel,
  observationSymbol,
  plural,
  repositoryLines,
  routingLine,
  selectionLine,
} from "./settings-view.js";

/** One project's configuration read: pending, loaded or failed (null). */
type ConfigState = ProjectConfigurationData | null | undefined;

/** Reads every project's configuration, at most four in flight; each fails on its own. */
function useProjectConfigurations(
  client: OperatorClient,
  scope: string,
  ids: string[],
  nonce: number | undefined,
) {
  const [configs, setConfigs] = useState<Record<string, ConfigState>>({});
  // One controller per load; a Retry shares it, so unmount or a new load cancels both.
  const current = useRef(new AbortController());
  const read = useCallback(
    (targets: string[], signal: AbortSignal) => {
      const queue = [...targets];
      const worker = async () => {
        for (let id = queue.shift(); id; id = queue.shift()) {
          const projectId = id;
          let value: ConfigState = null;
          try {
            value = (
              await client.read(
                `/api/operator/projects/${projectId}/configuration`,
                projectConfigurationSchema,
                signal,
              )
            ).data;
          } catch {
            value = null;
          }
          if (signal.aborted) return;
          setConfigs((c) => ({ ...c, [projectId]: value }));
        }
      };
      void Promise.all(Array.from({ length: 4 }, worker));
    },
    [client],
  );
  const key = ids.join(",");
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-read when the project list, scope or header Refresh changes.
  useEffect(() => {
    const abort = new AbortController();
    current.current = abort;
    read(ids, abort.signal);
    return () => abort.abort();
  }, [read, key, scope, nonce]);
  const retry = (id: string) => {
    setConfigs((c) => ({ ...c, [id]: undefined }));
    read([id], current.current.signal);
  };
  return { configs, retry };
}

export function SettingsWorkspace(p: SettingsProps) {
  const projects = p.workspace?.data.projects ?? [],
    profiles = p.workspace?.data.profiles ?? [],
    labels = workspaceLabels(p.workspace);
  const { configs, retry } = useProjectConfigurations(
    p.client,
    p.session.csrfToken,
    projects.map((r) => r.id),
    p.refreshNonce,
  );
  const observationLoader = useCallback(
      (signal: AbortSignal) =>
        p.client.read(
          "/api/operator/source-observations",
          sourceObservationSchema,
          signal,
        ),
      [p.client],
    ),
    observations = useOperatorResource(p.session.csrfToken, observationLoader);
  const runtimeLoader = useCallback(
      (signal: AbortSignal) =>
        p.client.read("/api/operator/runtime", runtimeSettingsSchema, signal),
      [p.client],
    ),
    runtime = useOperatorResource(p.session.csrfToken, runtimeLoader);
  useHeaderRefresh(p.refreshNonce, () => {
    observations.refresh();
    runtime.refresh();
  });
  const observed = observations.state.data?.data.projects;
  const runtimeData = runtime.state.data?.data;
  const heldTasks = (projectId: string) =>
    runtimeData?.projects
      .find((r) => r.project.id === projectId)
      ?.tasks.filter((t) => t.held).length ?? 0;
  const paused = projects.filter((r) => r.paused).length,
    revoked = profiles.filter((r) => r.revoked).length;
  const unavailable = (id: string, name: string) => (
    <p className="body settings-unavailable">
      Unavailable{" "}
      <Button
        variant="secondary"
        aria-label={`Retry ${name}`}
        onClick={() => retry(id)}
      >
        Retry
      </Button>
    </p>
  );
  return (
    <div className="settings-page">
      <p className="introduction muted">
        Configure paused projects, reusable profiles, routing, GitHub sources
        and installation capacity. Each change is saved separately. Saving never
        resumes work, clears holds or grants repository access.
      </p>
      <div className="settings-index">
        <div className="settings-column">
          <Panel
            title="Projects"
            description={`${plural(projects.length, "project")} · ${paused} paused · repository access and GitHub discovery per project`}
            action={
              <ActionLink href="/app/settings/projects/new">
                Create project
              </ActionLink>
            }
          >
            <DiscoveryCredentialRow {...p} />
            {projects.map((r) => {
              const label = projectLabel(labels, r.id, r.name),
                name = label.text,
                c = configs[r.id],
                lead = profiles.find(
                  (x) => x.id === c?.project.leadProfileId,
                )?.name;
              return (
                <article className="settings-row" key={r.id}>
                  <div className="settings-row-heading">
                    <h3 className="small-heading">
                      <ProjectName label={label} id={r.id} />
                    </h3>
                    {c && (
                      <span className="metadata muted">
                        Lead: {lead ?? "Unconfigured"}
                      </span>
                    )}
                    <StatusBadge
                      tone="idle"
                      icon={r.paused ? CirclePause : CircleCheck}
                    >
                      {r.paused ? "Paused" : "Enabled"}
                    </StatusBadge>
                    <ActionLink
                      variant="secondary"
                      href={`/app/projects/${r.id}/settings`}
                      aria-label={`Configure ${name}`}
                    >
                      Configure
                    </ActionLink>
                  </div>
                  {c === undefined ? (
                    <p className="metadata muted">Loading configuration…</p>
                  ) : c === null ? (
                    unavailable(r.id, name)
                  ) : (
                    <dl className="settings-facts metadata">
                      <div>
                        <dt>Repository access</dt>
                        <dd>
                          {[
                            ...repositoryLines(c),
                            ...(heldTasks(r.id)
                              ? ["execution hold recorded"]
                              : []),
                          ].join(" · ")}
                        </dd>
                      </div>
                      <div>
                        <dt>Discovery</dt>
                        <dd>
                          {c.source.selections.length === 0 ? (
                            "No GitHub source"
                          ) : (
                            <ul>
                              {c.source.selections.map((s, i) => {
                                const o = observed
                                  ?.find((o) => o.projectId === r.id)
                                  ?.selections.find(
                                    (o) => o.selectionId === s.id,
                                  );
                                return (
                                  <li key={s.id ?? i}>
                                    <span>{selectionLine(s)}</span>
                                    <StatusBadge
                                      tone="idle"
                                      icon={
                                        observations.state.data
                                          ? observationSymbol(o)
                                          : CircleQuestionMark
                                      }
                                    >
                                      {observations.state.data
                                        ? observationLabel(o)
                                        : "Unavailable"}
                                    </StatusBadge>
                                  </li>
                                );
                              })}
                            </ul>
                          )}
                        </dd>
                      </div>
                    </dl>
                  )}
                </article>
              );
            })}
            <p className="metadata muted">
              Discovery and readiness never grant repository access; each is
              listed separately.
            </p>
          </Panel>
          <Panel
            title="Runtime and recovery"
            description={
              runtimeData
                ? `Global active turns ${runtimeData.globalUsage} / ${runtimeData.globalLimit} · ${plural(
                    runtimeData.projects.reduce(
                      (n, r) => n + r.tasks.filter((t) => t.held).length,
                      0,
                    ),
                    "task",
                  )} with a recorded execution hold`
                : runtime.state.status === "error"
                  ? "Global active turns: unavailable"
                  : "Global active turns: loading…"
            }
            action={
              <ActionLink variant="secondary" href="/app/settings/runtime">
                Open runtime
              </ActionLink>
            }
          >
            <ClaudeTokenRow {...p} />
          </Panel>
        </div>
        <div className="settings-column">
          <ReadinessPanel {...p} />
          <Panel
            title="Profiles"
            description={`${plural(profiles.length, "profile")} · ${revoked} revoked`}
            action={
              <ActionLink variant="secondary" href="/app/settings/profiles/new">
                Create profile
              </ActionLink>
            }
          >
            {profiles.map((r) => {
              const name = r.name ?? "Name unavailable";
              return (
                <article className="settings-row" key={r.id}>
                  <div className="settings-row-heading">
                    <div>
                      <h3 className="small-heading">{name}</h3>
                      <p className="metadata muted">
                        {[r.summary, `revision ${r.version}`]
                          .filter(Boolean)
                          .join(" · ")}
                      </p>
                      <p className="metadata muted">
                        Runtime: {runtimeSummary(r.runtime)}
                      </p>
                    </div>
                    <StatusBadge
                      tone={r.revoked ? "warning" : "idle"}
                      icon={r.revoked ? undefined : CircleCheck}
                    >
                      {r.revoked ? "Revoked" : "Available"}
                    </StatusBadge>
                    <ActionLink
                      variant="secondary"
                      href={`/app/profiles/${r.id}/settings`}
                      aria-label={`Edit ${name}`}
                    >
                      Edit
                    </ActionLink>
                  </div>
                </article>
              );
            })}
          </Panel>
          <Panel
            title="Routing"
            description="Per project. Requires opt-in and a TypeSafe credential reference."
          >
            {projects.map((r) => {
              const label = projectLabel(labels, r.id, r.name),
                name = label.text,
                c = configs[r.id];
              return (
                <article className="settings-row" key={r.id}>
                  <div className="settings-row-heading">
                    <div>
                      <h3 className="small-heading">
                        <ProjectName label={label} id={r.id} />
                      </h3>
                      {c === undefined ? (
                        <p className="metadata muted">Loading…</p>
                      ) : c === null ? (
                        unavailable(r.id, name)
                      ) : (
                        <p className="metadata muted">
                          {routingLine(c.routing)}
                        </p>
                      )}
                    </div>
                    {c && (
                      <StatusBadge
                        tone="idle"
                        icon={c.routing.enabled ? CircleCheck : CircleSlash}
                      >
                        {c.routing.enabled ? "Enabled" : "Disabled"}
                      </StatusBadge>
                    )}
                    <ActionLink
                      variant="secondary"
                      href={`/app/projects/${r.id}/settings?tab=routing`}
                      aria-label={`Open routing for ${name}`}
                    >
                      Open routing
                    </ActionLink>
                  </div>
                </article>
              );
            })}
          </Panel>
          <OperatorCredentialsSection {...p} />
        </div>
      </div>
    </div>
  );
}
