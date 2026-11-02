import { useId, type ReactNode } from "react";
import { Button } from "./components.js";
import type { TabProps } from "./project-config.js";
import {
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
} from "./delivery-policy-draft.js";
import {
  Panel,
  ChangeList,
  DraftOutcome,
  DraftField,
  ReferenceInput,
  locked,
  reloadDraft,
  submitDraft,
  useDraft,
  useLoadedDraft,
  key,
} from "./settings.js";
import { Input } from "./ui/input.js";
import { NativeSelect } from "./ui/native-select.js";
import { Textarea } from "./ui/textarea.js";
import { Alert } from "./ui/alert.js";

/** Structured policy editing uses the same receipt, draft and authentication lifecycle as Settings. */
export function DeliveryTab(p: TabProps) {
  const d = useDraft(p.drafts, `delivery.configure:${p.projectId}`);
  const saved = p.data.delivery;
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
  const checks = deliveryRows<CheckRow>(v.requiredChecks);
  const lines = deliveryPolicyChangeText(saved, draft);
  if (draft.credentialIntent !== "preserve")
    lines.push(
      draft.credentialIntent === "set"
        ? "Credential reference: set new environment reference"
        : "Credential reference: cleared",
    );
  const isLocked = locked(d);
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
  return (
    <form
      onSubmit={(event) => {
        const errors = deliveryFieldErrors(draft);
        void submitDraft(
          event,
          d,
          p.client,
          p.session,
          Object.keys(errors).length
            ? {}
            : {
                type: "delivery.configure",
                key: v.key,
                projectId: p.projectId,
                expectedVersion: Number(v.expectedVersion),
                ...deliveryPolicySubmission(draft),
              },
          p.refreshConfiguration,
          errors,
        );
      }}
    >
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
              {saved.credentialConfigured
                ? "A delivery credential is configured."
                : "No delivery credential is configured."}{" "}
              Saved references and values are never shown.
            </p>
            <ReferenceInput draft={d} />
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
          <Panel
            title="Required checks"
            description="Optional app IDs bind a check to a particular app. An absent app binding differs from a configured one."
          >
            <fieldset disabled={isLocked} className="settings-rows">
              <legend className="sr-only">Required checks</legend>
              {checks.map((row, index) => (
                <section
                  className="settings-row"
                  key={row.rowKey}
                  aria-label={`Check ${index + 1}`}
                >
                  <h3 className="small-heading">Check {index + 1}</h3>
                  {"savedRow" in row ? (
                    <p>Unavailable saved row · kept until removed</p>
                  ) : (
                    <>
                      <Field
                        id={row.rowKey}
                        label="Check name"
                        error={error(`requiredChecks.${index}.name`)}
                        value={row.name}
                        onChange={(value) =>
                          setRow("requiredChecks", index, "name", value)
                        }
                      />
                      <ScopeField
                        label="App ID"
                        value={
                          row.appId === undefined
                            ? undefined
                            : String(row.appId)
                        }
                        error={error(`requiredChecks.${index}.appId`)}
                        onChange={(value) =>
                          setRow("requiredChecks", index, "appId", value)
                        }
                      />
                    </>
                  )}
                  {error(`requiredChecks.${index}.savedRow`) && (
                    <p role="alert">
                      {error(`requiredChecks.${index}.savedRow`)}
                    </p>
                  )}
                  <Button
                    id={"savedRow" in row ? row.rowKey : undefined}
                    aria-invalid={
                      "savedRow" in row &&
                      Boolean(error(`requiredChecks.${index}.savedRow`))
                    }
                    type="button"
                    variant="secondary"
                    onClick={() => remove("requiredChecks", index)}
                  >
                    Remove check {index + 1}
                  </Button>
                </section>
              ))}
              {error("requiredChecks") && (
                <p role="alert" className="error-text">
                  {error("requiredChecks")}
                </p>
              )}
              <Button
                id="add-requiredChecks"
                type="button"
                variant="secondary"
                disabled={checks.length >= 100}
                onClick={() => add("requiredChecks")}
              >
                Add required check
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

function Field({
  id: suppliedId,
  label,
  value,
  onChange,
  error,
  children,
  multiline = false,
}: {
  id?: string | undefined;
  label: string;
  value: string;
  onChange: (value: string) => void;
  error?: string | undefined;
  children?: ReactNode;
  multiline?: boolean;
}) {
  const generated = useId(),
    id = suppliedId ?? generated;
  const props = {
    id,
    "aria-label": label,
    value,
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
