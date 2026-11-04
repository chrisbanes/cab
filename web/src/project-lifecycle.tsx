import { useCallback, useEffect, useRef, useState } from "react";
import type { z } from "zod";
import type { projectSchema } from "../../src/operator/contracts.js";
import {
  projectDeletePreviewSchema,
  type projectTombstoneSchema,
} from "../../src/operator/project-lifecycle-contracts.js";
import {
  archivedProjectNotice,
  projectDeletionWarning,
  projectExternalRetention,
  retainedProjectLine,
} from "../../src/operator/project-lifecycle-copy.js";
import {
  deletionConfirmationReady,
  groupProjectConsequences,
} from "./project-lifecycle-model.js";
import { Button, ResourceStatus } from "./components.js";
import { useOperatorResource } from "./resource.js";
import {
  DraftField,
  DraftMessage,
  locked,
  submitDraft,
  useDraft,
  useLoadedDraft,
  type SettingsProps,
} from "./settings.js";
type Live = Extract<z.output<typeof projectSchema>["data"], { state: "live" }>;
export function ProjectLifecyclePanel(
  p: SettingsProps & {
    data: Live;
    loadedAt: number | null;
    reload: () => void;
  },
) {
  const project = p.data.project,
    id = project.id,
    verb = project.archived ? "restore" : "archive";
  const archiveDraft = useDraft(p.drafts, `project.lifecycle.archive:${id}`),
    restoreDraft = useDraft(p.drafts, `project.lifecycle.restore:${id}`);
  const lifecycle = verb === "archive" ? archiveDraft : restoreDraft,
    rename = useDraft(p.drafts, `project.lifecycle.rename:${id}`),
    deletion = useDraft(p.drafts, `project.lifecycle.delete:${id}`);
  useLoadedDraft(
    lifecycle,
    { expectedVersion: String(project.version) },
    p.loadedAt,
  );
  useLoadedDraft(
    rename,
    { name: project.name ?? "", expectedVersion: String(project.version) },
    p.loadedAt,
  );
  const loader = useCallback(
    (signal: AbortSignal) =>
      p.client.read(
        `/api/operator/projects/${id}/delete-preview`,
        projectDeletePreviewSchema,
        signal,
      ),
    [p.client, id],
  );
  const preview = useOperatorResource(
      `${p.session.csrfToken}:${id}:delete-preview`,
      loader,
      false,
    ),
    value = preview.state.data?.data ?? null;
  const [adopt, setAdopt] = useState(false),
    prior = useRef<number | null>(null);
  const inspect = () => {
    if (locked(deletion)) return;
    prior.current = preview.state.fetchedAt;
    setAdopt(true);
    void preview.refresh();
  };
  useEffect(() => {
    if (
      adopt &&
      value &&
      preview.state.fetchedAt !== prior.current &&
      !locked(deletion)
    ) {
      deletion.startOperation({
        key: crypto.randomUUID(),
        confirmationName: String(deletion.values.confirmationName ?? ""),
        expectedVersion: String(value.version),
        previewDigest: value.previewDigest,
      });
      setAdopt(false);
    }
  }, [adopt, value, preview.state.fetchedAt, deletion]);
  const ready =
    Boolean(
      value &&
        deletion.values.previewDigest === value.previewDigest &&
        Number(deletion.values.expectedVersion) === value.version,
    ) &&
    deletionConfirmationReady({
      archived: project.archived,
      projectId: id,
      version: project.version,
      name: project.name,
      preview: value,
      typedName: String(deletion.values.confirmationName ?? ""),
      phase: deletion.phase,
    });
  const refreshed = () => {
    p.refresh();
    p.reload();
  };
  const reconcile = async (d: typeof deletion) => {
    await d.reconcile(p.client, p.session.csrfToken);
    if (d.phase === "recorded") refreshed();
  };
  return (
    <section className="settings-panel" aria-label="Project lifecycle">
      <h2>Danger zone</h2>
      {project.archived && <p role="status">{archivedProjectNotice}</p>}
      {!project.archived && !p.data.lifecycle.archiveEligible && (
        <div>
          <p>Pause and drain the project before archiving.</p>
          <ul>
            {groupProjectConsequences(p.data.lifecycle.blockers).map(
              ({ row: b, key, count }) => (
                <li key={key}>
                  {count > 1 && `${count} × `}
                  {b.reason ?? "Work remains unresolved."}
                </li>
              ),
            )}
          </ul>
        </div>
      )}
      <form
        onSubmit={(event) =>
          submitDraft(
            event,
            lifecycle,
            p.client,
            p.session,
            {
              type: `project.${verb}`,
              key: lifecycle.values.key,
              projectId: id,
              expectedVersion: Number(lifecycle.values.expectedVersion),
            },
            refreshed,
            {},
            verb === "archive" && !p.data.lifecycle.archiveEligible,
          )
        }
      >
        <Button
          type="submit"
          disabled={
            locked(lifecycle) ||
            (verb === "archive" && !p.data.lifecycle.archiveEligible)
          }
        >
          {project.archived ? "Restore project" : "Archive project"}
        </Button>
        <DraftMessage
          draft={lifecycle}
          check={() => reconcile(lifecycle)}
          review={p.reload}
          success={
            project.archived
              ? "Project restored and paused."
              : "Project archived."
          }
        />
      </form>
      {(verb === "restore" ? archiveDraft : restoreDraft).phase ===
        "unknown" && (
        <DraftMessage
          draft={verb === "restore" ? archiveDraft : restoreDraft}
          check={() =>
            reconcile(verb === "restore" ? archiveDraft : restoreDraft)
          }
        />
      )}
      {project.archived && (
        <form
          onSubmit={(event) =>
            submitDraft(
              event,
              rename,
              p.client,
              p.session,
              {
                type: "project.configure",
                key: rename.values.key,
                projectId: id,
                expectedVersion: Number(rename.values.expectedVersion),
                name: rename.values.name,
              },
              refreshed,
            )
          }
        >
          <DraftField draft={rename} field="name" label="Project name" />
          <Button type="submit" disabled={locked(rename) || !rename.dirty}>
            Rename project
          </Button>
          <DraftMessage
            draft={rename}
            check={() => reconcile(rename)}
            review={p.reload}
            success="Project renamed; inspect a fresh deletion preview."
          />
        </form>
      )}
      {!project.archived && rename.phase === "unknown" && (
        <DraftMessage draft={rename} check={() => reconcile(rename)} />
      )}
      {(project.archived || deletion.phase === "unknown") && (
        <div>
          <p>{projectDeletionWarning}</p>
          <p>{projectExternalRetention}</p>
          <Button
            type="button"
            disabled={
              !project.archived || locked(deletion) || preview.state.pending
            }
            onClick={inspect}
          >
            {value ? "Refresh deletion preview" : "Inspect deletion preview"}
          </Button>
          <ResourceStatus
            state={preview.state}
            retry={inspect}
            label="Deletion preview"
          />
          {value && (
            <>
              <p>
                {value.counts.tasks} tasks, {value.counts.assignments}{" "}
                assignments, {value.counts.worktrees} worktrees.
              </p>
              <ul>
                {groupProjectConsequences(value.worktrees).map(
                  ({ row: w, key, count }) => (
                    <li key={key}>
                      {count > 1 && `${count} × `}
                      {`${w.kind} worktree: dirty ${w.dirty}; unpushed ${w.unpushed}; inspection ${w.inspection}.`}
                    </li>
                  ),
                )}
                {value.affectedProjects.map((a) => (
                  <li key={a.projectId}>
                    Selection released in {a.name ?? "another project"}.
                  </li>
                ))}
              </ul>
              {value.externalRemnants.length > 0 && (
                <ul>
                  {groupProjectConsequences(value.externalRemnants).map(
                    ({ row: r, key, count }) => (
                      <li key={key}>
                        {count > 1 && `${count} × `}
                        {retainedProjectLine(r)}
                      </li>
                    ),
                  )}
                </ul>
              )}
              {value.version !== project.version && (
                <p role="status">
                  The project changed. Refresh the preview; your typed name is
                  kept.
                </p>
              )}
              {value.name === null && (
                <p>
                  The exact name is unavailable. Rename the project before
                  deletion.
                </p>
              )}
              <form
                onSubmit={(event) =>
                  submitDraft(
                    event,
                    deletion,
                    p.client,
                    p.session,
                    {
                      type: "project.delete",
                      key: deletion.values.key,
                      projectId: id,
                      expectedVersion: Number(deletion.values.expectedVersion),
                      previewDigest: deletion.values.previewDigest,
                      confirmationName: deletion.values.confirmationName,
                    },
                    refreshed,
                    {},
                    !ready,
                  )
                }
              >
                <DraftField
                  draft={deletion}
                  field="confirmationName"
                  label={`Type the exact project name${value.name === null ? "" : `: ${value.name}`}`}
                />
                <Button type="submit" variant="destructive" disabled={!ready}>
                  Delete project permanently
                </Button>
              </form>
            </>
          )}
        </div>
      )}
      <DraftMessage
        draft={deletion}
        check={() => reconcile(deletion)}
        review={() => {
          p.reload();
          inspect();
        }}
        success="Project deleted. There is no undo."
      />
    </section>
  );
}
export function DeletedProject(
  p: SettingsProps & {
    tombstone: z.output<typeof projectTombstoneSchema>;
    reload: () => void;
  },
) {
  const t = p.tombstone;
  const deletion = useDraft(
    p.drafts,
    `project.lifecycle.delete:${t.projectId}`,
  );
  return (
    <section aria-label="Deleted project">
      <h1>{t.name ?? "Deleted project"}</h1>
      <p role="status">Project deleted. There is no undo.</p>
      <p>
        Deleted {t.deletedAt}. {t.counts.tasks} tasks and {t.counts.assignments}{" "}
        assignments removed.
      </p>
      <p>
        Cleanup: {t.cleanup.state}; {t.cleanup.pending} pending.
      </p>
      <p>{projectExternalRetention}</p>
      <ul>
        {groupProjectConsequences(t.externalRemnants).map(
          ({ row, key, count }) => (
            <li key={key}>
              {count > 1 && `${count} × `}
              {retainedProjectLine(row)}
            </li>
          ),
        )}
      </ul>
      {t.cleanup.reasons.length > 0 && (
        <p>Pending: {t.cleanup.reasons.join(", ")}.</p>
      )}
      <Button onClick={p.reload}>Refresh cleanup status</Button>
      <DraftMessage
        draft={deletion}
        check={() => deletion.reconcile(p.client, p.session.csrfToken)}
        success="Original deletion receipt confirmed."
      />
      <a href="/app/settings">Projects</a>
    </section>
  );
}
