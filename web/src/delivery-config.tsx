import { useId, useState, useRef, useEffect, type ReactNode } from "react";
import { Button } from "./components.js";
import type { TabProps } from "./project-config.js";
import {
  applyRepositoryDeliveryLevel,
  deliveryLevelView,
  type DeliveryPolicyDraft,
  type RepositoryDeliveryLevel,
  deliveryActionKinds,
  deliveryEditorValues,
  deliveryEditorDraft,
  deliveryPolicySubmission,
  deliveryPolicyChangeText,
  deliveryFieldErrors,
  deliveryRows,
  deliveryMappingCoverageWarning,
  type GrantRow,
  type CheckRow,
  type RepositoryRow,
  type RepositoryDeliveryRead,
} from "./delivery-policy-draft.js";
import {
  Panel,
  ChangeList,
  DraftCheck,
  DraftOutcome,
  DraftField,
  locked,
  reloadDraft,
  submitDraft,
  sendDraft,
  useDraft,
  useLoadedDraft,
  key,
} from "./settings.js";
import {
  stackingAppliesNote,
  stackingDisclosure,
  stackingLine,
} from "../../src/operator/stacking-copy.js";
import { Input } from "./ui/input.js";
import { NativeSelect } from "./ui/native-select.js";
import { Textarea } from "./ui/textarea.js";
import { Alert } from "./ui/alert.js";

import { ghLoginCopy } from "./discovery-credential.js";
import {
  codeHostChecksSummary,
  deliveryCredentialLimit,
  deliveryCredentialSummary,
  deliveryLevelLabels,
  deliveryMergeWarning,
  mergeMethodLabels,
  mergeMethodUnsetNote,
  codeHostMergeMethods,
  defaultBranchMethodsNote,
  mergeMethodNotAllowedWarning,
  noRequiredChecksWarning,
  unconfirmedChecksNote,
  type CodeHost,
} from "./delivery-presentation.js";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "./ui/dialog.js";
type Preset = Exclude<RepositoryDeliveryLevel, "not-set-up" | "custom">;
const presets: Preset[] = [
  "open-prs",
  "merge-with-approval",
  "merge-when-ready",
];

export function DeliveryTab(p: TabProps) {
  return (
    <>
      <DeliveryPolicyForm {...p} />
      <StackingPanel {...p} />
    </>
  );
}

/** The project's stacking switch saves its own project.configure, so it never touches the policy draft. */
function StackingPanel(p: TabProps) {
  const d = useDraft(p.drafts, `project.stacking:${p.projectId}`);
  const saved = p.data.stacking;
  const initial =
    saved === undefined
      ? null
      : { stacking: saved, expectedVersion: String(p.data.project.version) };
  useLoadedDraft(d, initial, p.loadedAt);
  if (saved === undefined || !initial) return null;
  const on = Boolean(d.values.stacking);
  const changed = on !== saved;
  return (
    <div className="settings-split">
      <div className="settings-column">
        <Panel title="Stacked dependencies" description={stackingLine(saved)}>
          <form
            onSubmit={(event) =>
              void submitDraft(
                event,
                d,
                p.client,
                p.session,
                {
                  type: "project.configure",
                  key: d.values.key,
                  projectId: p.projectId,
                  expectedVersion: Number(d.values.expectedVersion),
                  stacking: on,
                },
                p.refreshConfiguration,
              )
            }
          >
            <DraftCheck
              draft={d}
              field="stacking"
              label="Start dependents on their blocker's change request"
              toggle
            />
            <p className="metadata muted">
              {stackingDisclosure} {stackingAppliesNote}
            </p>
            <DraftOutcome
              draft={d}
              client={p.client}
              session={p.session}
              label="Save stacking"
              saveDisabled={!changed}
              discard={() => reloadDraft(d, initial)}
              refresh={p.refreshConfiguration}
              review={() => d.adoptLatest(p.data.project.version, initial)}
            />
          </form>
        </Panel>
      </div>
    </div>
  );
}

/** Structured policy editing uses the same receipt, draft and authentication lifecycle as Settings. */
function DeliveryPolicyForm(p: TabProps) {
  const d = useDraft(p.drafts, `delivery.configure:${p.projectId}`);
  const form = useRef<HTMLFormElement>(null);
  const origin = useRef<HTMLElement | null>(null);
  const [bulk, setBulk] = useState("");
  const [levelError, setLevelError] = useState("");
  const [confirmed, setConfirmed] = useState<string | null>(null);
  const [pending, setPending] = useState<{
    base: string;
    draft: DeliveryPolicyDraft;
    ids: string[];
    save: boolean;
  } | null>(null);
  const saved = p.data.delivery;
  const context = JSON.stringify([
    p.projectId,
    saved?.version,
    p.data.repositories,
  ]);
  const fingerprint = (value: DeliveryPolicyDraft) =>
    JSON.stringify([
      context,
      d.values.key,
      value.version,
      value.mode,
      value.grants,
    ]);
  const currentFingerprint = saved
    ? fingerprint(deliveryEditorDraft(d.values))
    : "";
  useEffect(() => {
    if (confirmed !== currentFingerprint) setConfirmed(null);
    if (pending && pending.base !== currentFingerprint) setPending(null);
  }, [currentFingerprint, confirmed, pending]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a refused level choice is stale once the draft changes.
  useEffect(() => setLevelError(""), [currentFingerprint]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: confirmation never survives a session or project change.
  useEffect(() => {
    setConfirmed(null);
    setPending(null);
    setBulk("");
    setLevelError("");
  }, [p.session, p.projectId]);
  const initial = saved ? deliveryEditorValues(saved) : null;
  useLoadedDraft(d, initial, p.loadedAt, saved);
  if (!saved || !initial)
    return (
      <Panel
        title="Delivery"
        description="Delivery configuration is unavailable. Refresh to try again."
      />
    );
  const v = d.values;
  const draft = deliveryEditorDraft(v);
  const grants = deliveryRows<GrantRow>(v.grants);
  const repositoryRows = deliveryRows<RepositoryRow>(v.repositories);
  const requirements = saved.repositories ?? [];
  const lines = deliveryPolicyChangeText(saved, draft);
  if (draft.credentialIntent !== "preserve")
    lines.push(
      draft.credentialIntent === "set"
        ? draft.credentialInput === "gh:github.com"
          ? "Credential reference: set GitHub CLI login"
          : "Credential reference: set new environment reference"
        : "Credential reference: cleared",
    );
  const isLocked = locked(d);
  const setRepository = (
    index: number,
    change: (row: RepositoryRow) => RepositoryRow,
  ) => {
    const rows = deliveryRows<RepositoryRow>(v.repositories);
    const row = rows[index];
    if (!row) return;
    rows[index] = change(row);
    d.set("repositories", JSON.stringify(rows));
  };
  const setRow = (
    section: "grants" | "requiredChecks",
    index: number,
    field: string,
    value: string | string[] | undefined,
  ) => {
    const rows = deliveryRows<Record<string, unknown>>(v[section]);
    const row = { ...rows[index] };
    if (value === undefined) delete row[field];
    else row[field] = value;
    if (section === "grants" && field === "action" && value === "branch.adopt")
      row.mode = "approval";
    rows[index] = row;
    d.set(section, JSON.stringify(rows));
  };
  const focus = (id: string) =>
    d.afterRender(() => document.getElementById(id)?.focus());
  const remove = (section: "grants" | "requiredChecks", index: number) => {
    const rows = deliveryRows<{ rowKey: string }>(v[section]);
    rows.splice(index, 1);
    d.set(section, JSON.stringify(rows));
    focus(rows[index]?.rowKey ?? rows[index - 1]?.rowKey ?? `add-${section}`);
  };
  const add = (section: "grants" | "requiredChecks") => {
    const rowKey = key();
    const rows = deliveryRows(v[section]);
    rows.push(
      section === "grants"
        ? {
            rowKey,
            action: "issue.comment",
            repositoryId: "",
            mode: "approval",
          }
        : { rowKey, name: "" },
    );
    d.set(section, JSON.stringify(rows));
    focus(rowKey);
  };
  const error = (path: string) =>
    d.errors[path] ??
    Object.entries(d.errors).find(([field]) =>
      field.startsWith(`${path}.`),
    )?.[1];
  const mapping = p.data.statusMapping;
  const coverageWarning = deliveryMappingCoverageWarning(saved, draft, mapping);
  const removedUnavailable = saved.grants.some(
    (g) =>
      "savedRow" in g &&
      !draft.grants.some(
        (row) =>
          "savedRow" in row &&
          JSON.stringify(row.savedRow) === JSON.stringify(g.savedRow),
      ),
  );
  const links = p.data.repositories.links;
  // Derived from the draft, so a project the migration skipped offers it and a set-up one does not.
  const unset = links.flatMap((link) =>
    link.repositoryId !== null &&
    deliveryLevelView(draft.grants, link.repositoryId) === "not-set-up"
      ? [link.repositoryId]
      : [],
  );
  // Withheld when the level could not be applied: a hidden saved grant or the 256-row limit refuses it.
  const notSetUp =
    draft.grants.some((row) => "savedRow" in row) ||
    draft.grants.length + 7 * unset.length > 256
      ? []
      : unset;
  const apply = (next: DeliveryPolicyDraft) => {
    d.set(
      "grants",
      JSON.stringify(
        next.grants.map((row, i) => ({ ...row, rowKey: next.grantKeys[i] })),
      ),
    );
    d.set("mode", next.mode);
  };
  const command = (value: DeliveryPolicyDraft) => ({
    type: "delivery.configure",
    key: v.key,
    projectId: p.projectId,
    expectedVersion: value.version,
    ...deliveryPolicySubmission(value),
  });
  const upward = (
    before: DeliveryPolicyDraft | typeof saved,
    next: DeliveryPolicyDraft,
  ) =>
    [
      ...new Set(
        next.grants.flatMap((row) =>
          "savedRow" in row ? [] : [row.repositoryId],
        ),
      ),
    ].filter(
      (id) =>
        deliveryLevelView(next.grants, id) === "merge-when-ready" &&
        deliveryLevelView(before.grants, id) !== "merge-when-ready",
    );
  const choose = (ids: (string | null)[], level: Preset, returnId: string) => {
    if (isLocked) return;
    const result = applyRepositoryDeliveryLevel(draft, ids, level);
    if (result.kind !== "applied") {
      setLevelError(result.message);
      return;
    }
    setLevelError("");
    const raised = upward(draft, result.draft);
    if (raised.length) {
      origin.current = document.getElementById(returnId);
      setPending({
        base: currentFingerprint,
        draft: result.draft,
        ids: raised,
        save: false,
      });
    } else apply(result.draft);
  };
  return (
    <form
      ref={form}
      onSubmit={(event) => {
        const errors = deliveryFieldErrors(draft);
        const ids = upward(saved, draft);
        if (
          !isLocked &&
          !Object.keys(errors).length &&
          ids.length &&
          confirmed !== currentFingerprint
        ) {
          event.preventDefault();
          origin.current = document.activeElement as HTMLElement;
          setPending({ base: currentFingerprint, draft, ids, save: true });
          return;
        }
        void submitDraft(
          event,
          d,
          p.client,
          p.session,
          Object.keys(errors).length ? {} : command(draft),
          p.refreshConfiguration,
          errors,
        );
      }}
    >
      <Dialog
        open={Boolean(
          pending && pending.base === currentFingerprint && !isLocked,
        )}
        onOpenChange={(open) => {
          if (!open) setPending(null);
        }}
      >
        <DialogContent
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            origin.current?.focus();
          }}
        >
          <DialogTitle>Allow merging without asking?</DialogTitle>
          <DialogDescription>{deliveryMergeWarning}</DialogDescription>
          <p>{pending?.ids.join(", ")}</p>
          <Button
            type="button"
            variant="secondary"
            onClick={() => setPending(null)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => {
              if (!pending || pending.base !== currentFingerprint || isLocked)
                return;
              setConfirmed(fingerprint(pending.draft));
              setPending(null);
              if (pending.save && form.current)
                void sendDraft(
                  form.current,
                  d,
                  p.client,
                  p.session,
                  command(pending.draft),
                  p.refreshConfiguration,
                  deliveryFieldErrors(pending.draft),
                );
              else apply(pending.draft);
            }}
          >
            Allow Merge when ready
          </Button>
        </DialogContent>
      </Dialog>
      <div className="settings-split">
        <div className="settings-column">
          <Panel
            title="Delivery"
            description="Choose completion mode and scoped write authority. Missing grants deny writes. Saving does not start work or change status mappings."
          >
            <DraftField draft={d} field="mode" label="Completion mode">
              <option value="reviewable-pr">Reviewable PR</option>
              <option value="through-merge">Through merge</option>
            </DraftField>
            <DraftField
              draft={d}
              field="prefixMode"
              label="Branch prefix choice"
            >
              <option value="default">No configured prefix</option>
              <option value="set">Set prefix (empty is allowed)</option>
              {saved.branchPrefixUnavailable && (
                <option value="preserve">
                  Preserve unavailable saved prefix
                </option>
              )}
            </DraftField>
            <p className="metadata muted">
              An unconfigured prefix uses the existing delivery default. An
              explicit empty prefix is kept as empty.
            </p>
            {v.prefixMode === "set" && (
              <DraftField
                draft={d}
                field="branchPrefix"
                label="Branch prefix"
              />
            )}
            <p className="metadata muted">
              {deliveryCredentialSummary(
                saved.credentialConfigured,
                saved.credential,
              )}{" "}
              Saved references and values are never shown.
            </p>
            <DraftField
              draft={d}
              field="referenceMode"
              label="Credential reference change"
            >
              <option value="preserve">Preserve current reference</option>
              {saved.credential?.gh.state === "signed-in" ? (
                <option value="gh">
                  GitHub CLI · @{saved.credential.gh.login}
                </option>
              ) : (
                <option value="gh">GitHub CLI login</option>
              )}
              <option value="set">Set new environment reference</option>
              <option value="clear">Clear reference</option>
            </DraftField>
            {v.referenceMode === "gh" && saved.credential && (
              <p className="metadata" role="status">
                {ghLoginCopy(saved.credential.gh)}. Detection does not select
                this login; save to choose it.
              </p>
            )}
            {v.referenceMode === "set" && (
              <DraftField
                draft={d}
                field="credentialRef"
                label="New environment reference"
              />
            )}
            <p className="metadata muted">
              Use env:NAME for an environment reference; its value stays
              server-side. GitLab repositories use the installation's GitLab
              credential. {deliveryCredentialLimit}
            </p>
          </Panel>
          <Panel
            title="Repository shepherd levels"
            description="Levels describe the current grants. Linking a repository grants nothing. Advanced completion mode still applies."
          >
            <fieldset disabled={isLocked} className="settings-rows">
              <legend className="sr-only">Repository shepherd levels</legend>
              {links.map((link, i) => {
                const level = deliveryLevelView(
                  draft.grants,
                  link.repositoryId,
                );
                return (
                  <section
                    key={link.repositoryId ?? i}
                    className="settings-row"
                    aria-label={`Repository ${link.repositoryId ?? "unavailable"}`}
                  >
                    <h3 className="small-heading">
                      {link.repositoryId ?? "Unavailable repository"}
                    </h3>
                    <p>{deliveryLevelLabels[level]}</p>
                    {level === "merge-when-ready" &&
                      draft.mode !== "through-merge" && (
                        <p>
                          Completion mode is Reviewable PR, so the lead stops at
                          a reviewable pull request.
                        </p>
                      )}
                    {level === "not-set-up" && (
                      <p>This linked repository has no code-host grants.</p>
                    )}
                    {level === "unavailable" && (
                      <p>
                        Complete repository and grant details are required to
                        choose a level.
                      </p>
                    )}
                    <Field
                      id={`shepherd-level-${i}`}
                      disabled={level === "unavailable"}
                      label={`Shepherd level for ${link.repositoryId ?? "unavailable"}`}
                      value={presets.includes(level as Preset) ? level : ""}
                      onChange={(value) =>
                        choose(
                          [link.repositoryId],
                          value as Preset,
                          `shepherd-level-${i}`,
                        )
                      }
                    >
                      <option value="" disabled>
                        Choose a level
                      </option>
                      {presets.map((preset) => (
                        <option
                          key={preset}
                          value={preset}
                          disabled={level === "unavailable"}
                        >
                          {deliveryLevelLabels[preset]}
                        </option>
                      ))}
                    </Field>
                    {(() => {
                      const r = repositoryRows.findIndex(
                        (row) => row.repositoryId === link.repositoryId,
                      );
                      const read = requirements.find(
                        (row) => row.repositoryId === link.repositoryId,
                      );
                      const row = repositoryRows[r];
                      return row && read ? (
                        <RepositoryMergeSettings
                          index={r}
                          row={row}
                          read={read}
                          codeHost={link.codeHost}
                          error={error}
                          onChange={(change) => setRepository(r, change)}
                          focus={focus}
                        />
                      ) : null;
                    })()}
                  </section>
                );
              })}
              {!links.length && <p>No linked repositories.</p>}
              {notSetUp.length > 0 && (
                <section
                  className="settings-row"
                  aria-label="Repositories not set up"
                >
                  <h3 className="small-heading">Repositories not set up</h3>
                  <p>
                    {notSetUp.join(", ")} can't push branches or open pull
                    requests yet. Apply Open PRs, then save.
                  </p>
                  <Button
                    id="apply-open-prs"
                    type="button"
                    variant="secondary"
                    onClick={() =>
                      choose(notSetUp, "open-prs", "apply-open-prs")
                    }
                  >
                    Apply Open PRs
                  </Button>
                </section>
              )}
              <section
                className="settings-row"
                aria-label="All linked repositories"
              >
                <h3 className="small-heading">All linked repositories</h3>
                <Field
                  label="Level for all linked repositories"
                  value={bulk}
                  onChange={setBulk}
                >
                  <option value="" disabled>
                    Choose a level
                  </option>
                  {presets.map((preset) => (
                    <option key={preset} value={preset}>
                      {deliveryLevelLabels[preset]}
                    </option>
                  ))}
                </Field>
                <Button
                  id="shepherd-bulk"
                  type="button"
                  variant="secondary"
                  disabled={
                    !bulk ||
                    !links.length ||
                    links.some(
                      (link) =>
                        deliveryLevelView(draft.grants, link.repositoryId) ===
                        "unavailable",
                    )
                  }
                  onClick={() =>
                    choose(
                      links.map((link) => link.repositoryId),
                      bulk as Preset,
                      "shepherd-bulk",
                    )
                  }
                >
                  Apply to all linked repositories
                </Button>
                {levelError && <Alert role="alert">{levelError}</Alert>}
              </section>
            </fieldset>
          </Panel>
          <Panel
            title="Authority grants"
            description="Each row applies to the exact repository or tracker container. IDs and optional scope lists retain their order and duplicates."
          >
            <fieldset disabled={isLocked} className="settings-rows">
              <legend className="sr-only">Authority grants</legend>
              {grants.map((row, index) => (
                <section
                  className="settings-row"
                  key={row.rowKey}
                  aria-label={`Grant ${index + 1}`}
                >
                  <h3 className="small-heading">Grant {index + 1}</h3>
                  {"savedRow" in row ? (
                    <p>Unavailable saved row · kept until removed</p>
                  ) : (
                    <>
                      <Field
                        id={row.rowKey}
                        label="Action"
                        error={error(`grants.${index}.action`)}
                        value={row.action}
                        onChange={(value) =>
                          setRow("grants", index, "action", value)
                        }
                      >
                        {deliveryActionKinds.map((action) => (
                          <option key={action} value={action}>
                            {action}
                          </option>
                        ))}
                      </Field>
                      <Field
                        label="Repository or tracker container ID"
                        error={error(`grants.${index}.repositoryId`)}
                        value={row.repositoryId}
                        onChange={(value) =>
                          setRow("grants", index, "repositoryId", value)
                        }
                      />
                      <Field
                        label="Authority"
                        value={row.mode}
                        error={error(`grants.${index}.mode`)}
                        onChange={(value) =>
                          setRow("grants", index, "mode", value)
                        }
                      >
                        <option value="approval">Require approval</option>
                        {row.action !== "branch.adopt" && (
                          <option value="allow">Allow</option>
                        )}
                      </Field>
                      {(
                        [
                          [
                            "projectNodeId",
                            "Project ID",
                            row.action === "project.field" ||
                              row.action === "project.item.add",
                          ],
                          [
                            "fieldNodeId",
                            "Field ID",
                            row.action === "project.field",
                          ],
                          [
                            "optionNodeIds",
                            "Option IDs",
                            row.action === "project.field",
                          ],
                          [
                            "statusIds",
                            "Status IDs",
                            row.action === "issue.status",
                          ],
                        ] as const
                      ).map(([field, label, required]) => (
                        <ScopeField
                          key={field}
                          label={label}
                          required={required}
                          value={row[field]}
                          array={
                            field === "optionNodeIds" || field === "statusIds"
                          }
                          error={error(`grants.${index}.${field}`)}
                          onChange={(value) =>
                            setRow("grants", index, field, value)
                          }
                        />
                      ))}
                    </>
                  )}
                  {error(`grants.${index}.savedRow`) && (
                    <p role="alert">{error(`grants.${index}.savedRow`)}</p>
                  )}
                  <Button
                    id={"savedRow" in row ? row.rowKey : undefined}
                    aria-invalid={
                      "savedRow" in row &&
                      Boolean(error(`grants.${index}.savedRow`))
                    }
                    type="button"
                    variant="secondary"
                    onClick={() => remove("grants", index)}
                  >
                    Remove grant {index + 1}
                  </Button>
                </section>
              ))}
              {error("grants") && (
                <p role="alert" className="error-text">
                  {error("grants")}
                </p>
              )}
              <Button
                id="add-grants"
                type="button"
                variant="secondary"
                disabled={grants.length >= 256}
                onClick={() => add("grants")}
              >
                Add grant
              </Button>
            </fieldset>
          </Panel>
        </div>
        <aside className="settings-column">
          <ChangeList lines={lines} />
          {coverageWarning && <Alert role="alert">{coverageWarning}</Alert>}
          {removedUnavailable && (
            <Alert role="alert">
              Removing an unavailable grant may remove status-mapping authority.
              Its scope cannot be shown.
            </Alert>
          )}
          <DraftOutcome
            draft={d}
            client={p.client}
            session={p.session}
            label="Save delivery"
            saveDisabled={!lines.length}
            discard={() => reloadDraft(d, initial)}
            refresh={p.refreshConfiguration}
            review={() =>
              d.adoptLatest(saved.version, initial, [
                ["prefixMode", "branchPrefix"],
              ])
            }
          />
        </aside>
      </div>
    </form>
  );
}

/** A repository's merge method, the code host's checks and cab's additional checks. */
function RepositoryMergeSettings({
  index,
  row,
  read,
  codeHost,
  error,
  onChange,
  focus,
}: {
  index: number;
  row: RepositoryRow;
  read: RepositoryDeliveryRead;
  codeHost: CodeHost;
  error: (path: string) => string | undefined;
  onChange: (change: (row: RepositoryRow) => RepositoryRow) => void;
  focus: (id: string) => void;
}) {
  const id = row.repositoryId;
  const at = `repositories.${index}`;
  const live = read.codeHost.status === "live" ? read.codeHost : null;
  // Any method the host supports: a PR may target a branch whose rules differ from the default's.
  const methods: readonly (keyof typeof mergeMethodLabels)[] =
    codeHostMergeMethods[codeHost];
  const checks = row.additionalChecks;
  const setChecks = (next: CheckRow[]) =>
    onChange((current) => ({ ...current, additionalChecks: next }));
  const addCheck = (name: string) => {
    const rowKey = key();
    setChecks([...checks, { rowKey, name }]);
    focus(rowKey);
  };
  const named = new Set(
    checks.flatMap((check) => ("name" in check ? [check.name] : [])),
  );
  return (
    <fieldset className="settings-rows">
      <legend className="sr-only">Merge settings for {id}</legend>
      <Field
        id={`merge-method-${index}`}
        label={`Merge method for ${id}`}
        value={row.mergeMethod ?? ""}
        error={error(`${at}.mergeMethod`)}
        onChange={(value) =>
          onChange((current) => ({
            ...current,
            mergeMethod:
              value === "" ? null : (value as (typeof methods)[number]),
          }))
        }
      >
        <option value="">Not set</option>
        {methods.map((method) => (
          <option key={method} value={method}>
            {mergeMethodLabels[method]}
          </option>
        ))}
      </Field>
      {!row.mergeMethod && <p>{mergeMethodUnsetNote}</p>}
      {live && <p>{defaultBranchMethodsNote(live.allowedMethods)}</p>}
      {live &&
        row.mergeMethod &&
        !live.allowedMethods.includes(row.mergeMethod) && (
          <Alert role="alert">
            {mergeMethodNotAllowedWarning(row.mergeMethod)}
          </Alert>
        )}
      <p>{codeHostChecksSummary(codeHost, read.codeHost)}</p>
      {live && live.checks.length > 0 && (
        <ul aria-label={`Checks required by the code host for ${id}`}>
          {live.checks.map((check, i) => (
            <li
              key={"name" in check ? `${check.name}:${check.appId ?? ""}` : i}
            >
              {"name" in check ? check.name : "Unavailable check"}
              {"name" in check && check.appId !== undefined
                ? ` (app ${check.appId})`
                : ""}
            </li>
          ))}
        </ul>
      )}
      {!live ? (
        <p>{unconfirmedChecksNote}</p>
      ) : (
        !live.checks.length &&
        !checks.length && (
          <Alert role="alert">{noRequiredChecksWarning(codeHost)}</Alert>
        )
      )}
      <h4 className="small-heading">Additional required checks</h4>
      {checks.map((check, i) => (
        <section
          className="settings-row"
          key={check.rowKey}
          aria-label={`Additional check ${i + 1} for ${id}`}
        >
          {"savedRow" in check ? (
            <p>Unavailable saved row · kept until removed</p>
          ) : (
            <>
              <Field
                id={check.rowKey}
                label="Check name"
                error={error(`${at}.requiredChecks.${i}.name`)}
                value={check.name}
                onChange={(name) =>
                  setChecks(
                    checks.map((c, j) => (j === i ? { ...c, name } : c)),
                  )
                }
              />
              <ScopeField
                label="App ID"
                value={
                  check.appId === undefined ? undefined : String(check.appId)
                }
                error={error(`${at}.requiredChecks.${i}.appId`)}
                onChange={(appId) =>
                  setChecks(
                    checks.map((c, j) => {
                      if (j !== i || "savedRow" in c) return c;
                      const { appId: _old, ...rest } = c;
                      return appId === undefined
                        ? rest
                        : { ...rest, appId: String(appId) };
                    }),
                  )
                }
              />
            </>
          )}
          {error(`${at}.requiredChecks.${i}.savedRow`) && (
            <p role="alert">{error(`${at}.requiredChecks.${i}.savedRow`)}</p>
          )}
          <Button
            id={"savedRow" in check ? check.rowKey : undefined}
            type="button"
            variant="secondary"
            onClick={() => {
              setChecks(checks.filter((_, j) => j !== i));
              focus(
                checks[i + 1]?.rowKey ??
                  checks[i - 1]?.rowKey ??
                  `add-check-${index}`,
              );
            }}
          >
            Remove additional check {i + 1}
          </Button>
        </section>
      ))}
      {error(`${at}.requiredChecks`) && (
        <p role="alert" className="error-text">
          {error(`${at}.requiredChecks`)}
        </p>
      )}
      <Button
        id={`add-check-${index}`}
        type="button"
        variant="secondary"
        disabled={checks.length >= 100}
        onClick={() => addCheck("")}
      >
        Add additional check for {id}
      </Button>
      {read.suggestions.some((name) => !named.has(name)) && (
        <fieldset>
          <legend className="metadata muted">
            Suggested checks for {id}, seen on its PRs:
          </legend>
          {read.suggestions
            .filter((name) => !named.has(name))
            .map((name) => (
              <Button
                key={name}
                type="button"
                variant="secondary"
                disabled={checks.length >= 100}
                onClick={() => addCheck(name)}
              >
                Add {name}
              </Button>
            ))}
        </fieldset>
      )}
    </fieldset>
  );
}

function Field({
  id: suppliedId,
  label,
  value,
  onChange,
  error,
  children,
  multiline = false,
  disabled = false,
}: {
  id?: string | undefined;
  label: string;
  value: string;
  onChange: (value: string) => void;
  error?: string | undefined;
  children?: ReactNode;
  multiline?: boolean;
  disabled?: boolean;
}) {
  const generated = useId(),
    id = suppliedId ?? generated;
  const props = {
    id,
    "aria-label": label,
    value,
    disabled,
    "aria-invalid": Boolean(error),
    "aria-describedby": error ? `${id}-error` : undefined,
    onChange: (event: { target: { value: string } }) =>
      onChange(event.target.value),
  };
  return (
    <label className="field body" htmlFor={id}>
      {label}
      {children ? (
        <NativeSelect {...props}>{children}</NativeSelect>
      ) : multiline ? (
        <Textarea {...props} rows={3} />
      ) : (
        <Input {...props} />
      )}
      {error && (
        <span id={`${id}-error`} className="error-text" role="alert">
          {error}
        </span>
      )}
    </label>
  );
}
function ScopeField({
  label,
  value,
  onChange,
  error,
  required = false,
  array = false,
}: {
  label: string;
  value: string | string[] | undefined;
  onChange: (value: string | string[] | undefined) => void;
  error?: string | undefined;
  required?: boolean;
  array?: boolean;
}) {
  const included = value !== undefined;
  const id = useId();
  return (
    <div>
      <label className="body check-field" htmlFor={id}>
        <Input
          id={id}
          data-slot="checkbox-input"
          className="native-check size-5 shrink-0 p-0 accent-foreground"
          type="checkbox"
          checked={included || required}
          disabled={required}
          onChange={(event) =>
            onChange(event.target.checked ? (array ? [] : "") : undefined)
          }
        />
        Include {label}
        {required ? " (required)" : ""}
      </label>
      {(included || required) && (
        <Field
          label={array ? `${label} (one per line)` : label}
          value={Array.isArray(value) ? value.join("\n") : (value ?? "")}
          multiline={array}
          error={error}
          onChange={(text) =>
            onChange(array ? (text === "" ? [] : text.split("\n")) : text)
          }
        />
      )}
    </div>
  );
}
