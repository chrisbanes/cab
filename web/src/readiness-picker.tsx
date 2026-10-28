import { type ReactNode, useEffect, useRef, useState } from "react";
import { Check } from "lucide-react";
import type { z } from "zod";
import {
  discoveryLabelsSchema,
  discoveryProjectFieldsSchema,
  discoveryProjectsSchema,
  discoveryRepositoriesSchema,
  type sourceObservationSchema,
} from "../../src/operator/contracts.js";
import type { OperatorClient } from "./api.js";
import { Button } from "./components.js";
import {
  type ConditionIds,
  type FieldsRead,
  type LabelsRead,
  labelChoices,
  linkedRepositoryNames,
  type ProjectsRead,
  projectChoices,
  type RepositoriesRead,
  rowState,
  sameCondition,
  selectField,
  selectProject,
  unlistedLabelNote,
} from "./readiness-discovery.js";
import type { SourceRow } from "./settings-changes.js";
import { NativeSelect } from "./ui/native-select.js";

const unreadable = { state: "unavailable", reason: "unreadable" } as const;

/**
 * Reads, while a Project-field condition exists, the repositories, each saved link's Projects
 * and the fields of each listed Project a row names; while a label condition exists, the
 * repositories and each saved link's labels. Each read is made once per session round.
 */
export function useReadinessDiscovery(p: {
  client: OperatorClient;
  csrfToken: string;
  enabled: boolean;
  /** Whether a label condition exists. */
  labels: boolean;
  saved: { repositoryId: string }[];
  projectIds: string[];
}) {
  const [repositories, setRepositories] = useState<RepositoriesRead>();
  const [projectReads, setProjectReads] = useState<
    Record<string, ProjectsRead>
  >({});
  const [fieldReads, setFieldReads] = useState<Record<string, FieldsRead>>({});
  const [labelReads, setLabelReads] = useState<Record<string, LabelsRead>>({});
  const on = p.enabled || p.labels;
  const requested = useRef(new Set<string>());
  const round = useRef(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-read when the session (CSRF token) changes.
  useEffect(() => {
    if (!on) return;
    const mine = ++round.current;
    requested.current.clear();
    setRepositories(undefined);
    setProjectReads({});
    setFieldReads({});
    setLabelReads({});
    p.client
      .read("/api/operator/discovery/repositories", discoveryRepositoriesSchema)
      .then(
        (r) => mine === round.current && setRepositories(r.data),
        () => mine === round.current && setRepositories(unreadable),
      );
  }, [p.client, p.csrfToken, on]);

  const names =
    repositories?.state === "ready" && !repositories.truncated
      ? linkedRepositoryNames(p.saved, repositories.repositories)
      : [];
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed by the resolved repository list.
  useEffect(() => {
    const mine = round.current;
    for (const name of names) {
      const key = `p:${name}`;
      if (requested.current.has(key)) continue;
      requested.current.add(key);
      p.client
        .read(
          `/api/operator/discovery/projects?repository=${encodeURIComponent(name)}`,
          discoveryProjectsSchema,
        )
        .then(
          (r) =>
            mine === round.current &&
            setProjectReads((x) => ({ ...x, [name]: r.data })),
          () =>
            mine === round.current &&
            setProjectReads((x) => ({ ...x, [name]: unreadable })),
        );
    }
  }, [names.join("\n"), p.client]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed by the resolved repository list.
  useEffect(() => {
    const mine = round.current;
    if (!p.labels) return;
    for (const name of names) {
      const key = `l:${name}`;
      if (requested.current.has(key)) continue;
      requested.current.add(key);
      p.client
        .read(
          `/api/operator/discovery/labels?repository=${encodeURIComponent(name)}`,
          discoveryLabelsSchema,
        )
        .then(
          (r) =>
            mine === round.current &&
            setLabelReads((x) => ({ ...x, [name]: r.data })),
          () =>
            mine === round.current &&
            setLabelReads((x) => ({ ...x, [name]: unreadable })),
        );
    }
  }, [names.join("\n"), p.labels, p.client]);

  const choices = projectChoices(repositories, p.saved, projectReads);
  // Only listed Project IDs are requested, never arbitrary typed text.
  const wanted =
    choices.state === "ready"
      ? [...new Set(p.projectIds)].filter((id) =>
          choices.projects.some((x) => x.projectNodeId === id),
        )
      : [];
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed by the listed Project IDs rows name.
  useEffect(() => {
    const mine = round.current;
    for (const id of wanted) {
      const key = `f:${id}`;
      if (requested.current.has(key)) continue;
      requested.current.add(key);
      p.client
        .read(
          `/api/operator/discovery/project-fields?project=${encodeURIComponent(id)}`,
          discoveryProjectFieldsSchema,
        )
        .then(
          (r) =>
            mine === round.current &&
            setFieldReads((x) => ({ ...x, [id]: r.data })),
          () =>
            mine === round.current &&
            setFieldReads((x) => ({ ...x, [id]: unreadable })),
        );
    }
  }, [wanted.join("\n"), p.client]);

  return {
    choices,
    fieldReads,
    labels: labelChoices(repositories, p.saved, labelReads),
  };
}
export type ReadinessDiscovery = ReturnType<typeof useReadinessDiscovery>;

type SelectionFields = NonNullable<
  z.infer<
    typeof sourceObservationSchema
  >["data"]["projects"][number]["selections"][number]["projectFields"]
>;

/**
 * A Project source's single-select fields with each option's open items. Choosing an option
 * adds it to the drafted readiness conditions; Save applies it.
 */
export function ProjectFieldOptions(p: {
  projectFields: SelectionFields | null | undefined;
  drafted: readonly ConditionIds[];
  disabled: boolean;
  onAdd: (ids: ConditionIds) => void;
}) {
  if (!p.projectFields?.fields.some((f) => f.options.length)) return null;
  const { projectNodeId, fields } = p.projectFields;
  return (
    <div className="settings-rows">
      <p className="metadata">Project fields</p>
      {fields.map((f) => (
        <div key={f.fieldNodeId}>
          <p className="body">{f.name}</p>
          <ul className="settings-pills">
            {f.options.map((o) => {
              const ids = {
                projectNodeId,
                fieldNodeId: f.fieldNodeId,
                optionNodeId: o.optionNodeId,
              };
              const added = p.drafted.some((c) => sameCondition(c, ids));
              return (
                <li key={o.optionNodeId}>
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={p.disabled || added}
                    aria-label={
                      added
                        ? `${f.name} = ${o.name} is a readiness condition`
                        : `Require ${f.name} = ${o.name} for Ready (${o.open} open)`
                    }
                    onClick={() => p.onAdd(ids)}
                  >
                    {added && <Check aria-hidden="true" />}
                    {o.name} · {o.open}
                  </Button>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
      <p className="metadata muted">
        Open items of this source per option, from its last complete read.
        Choosing one adds it as a readiness condition; Save applies it.
      </p>
    </div>
  );
}

/**
 * The Ready label input. The listed labels are suggestions only: any typed name is kept, so a
 * label that doesn't exist yet, or a saved one that is no longer listed, saves as typed.
 */
export function ReadyLabelPicker(p: {
  index: number;
  value: string;
  discovery: ReadinessDiscovery;
  /** The text input, given the id of the datalist that suggests labels, if any. */
  input: (list: string | undefined) => ReactNode;
}) {
  const { labels } = p.discovery;
  const list = `source-conditions-${p.index}-labels`;
  const ready = labels.state === "ready";
  return (
    <>
      {p.input(ready ? list : undefined)}
      {ready && (
        <datalist id={list}>
          {labels.labels.map((name) => (
            <option key={name} value={name} />
          ))}
        </datalist>
      )}
      {labels.state === "typed" && (
        <p className="metadata muted">{labels.note}</p>
      )}
      {ready &&
        labels.labels.length > 0 &&
        p.value !== "" &&
        !labels.labels.includes(p.value) && (
          <p className="metadata muted">{unlistedLabelNote}</p>
        )}
    </>
  );
}

/**
 * Name selects for one Project-field condition. A row whose state falls back to typed node IDs
 * stays typed while it is mounted, so controls never swap under the cursor.
 */
export function ProjectFieldPicker(p: {
  index: number;
  row: SourceRow;
  discovery: ReadinessDiscovery;
  /** The typed node-ID inputs. */
  typed: ReactNode;
  invalid: (name: string) => boolean;
  onChange: (patch: ConditionIds) => void;
}) {
  const ids: ConditionIds = {
    projectNodeId: String(p.row.projectNodeId ?? ""),
    fieldNodeId: String(p.row.fieldNodeId ?? ""),
    optionNodeId: String(p.row.optionNodeId ?? ""),
  };
  const state = rowState(ids, p.discovery.choices, p.discovery.fieldReads);
  const sticky = useRef<string | null>(null);
  if (state.state === "typed") sticky.current = state.note;
  if (sticky.current !== null)
    return (
      <>
        {p.typed}
        <p className="metadata muted">{sticky.current}</p>
      </>
    );
  const loading = state.state === "loading";
  const projects = state.state === "typed" ? [] : (state.projects ?? []);
  const fields = state.state === "picker" ? state.fields : [];
  const field = fields.find((f) => f.fieldNodeId === ids.fieldNodeId);
  const select = (
    name: keyof ConditionIds,
    label: string,
    empty: string,
    options: { id: string; name: string }[],
    onChange: (value: string) => void,
    disabled = loading,
  ) => (
    <label
      className="field body"
      htmlFor={`source-conditions-${p.index}-${name}`}
    >
      {label}
      <NativeSelect
        className="control"
        id={`source-conditions-${p.index}-${name}`}
        aria-label={label}
        aria-invalid={p.invalid(name)}
        aria-describedby={
          p.invalid(name) ? "source-conditions-error" : undefined
        }
        disabled={disabled}
        value={ids[name]}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">{loading ? "Loading..." : empty}</option>
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
          </option>
        ))}
      </NativeSelect>
    </label>
  );
  return (
    <>
      {select(
        "projectNodeId",
        "Readiness Project",
        "Choose a Project",
        projects.map((x) => ({ id: x.projectNodeId, name: x.label })),
        (v) => p.onChange(selectProject(v)),
        loading && !state.projects,
      )}
      {select(
        "fieldNodeId",
        "Readiness field",
        "Choose a field",
        fields.map((f) => ({ id: f.fieldNodeId, name: f.name })),
        (v) => p.onChange(selectField(ids, v)),
        loading || !ids.projectNodeId,
      )}
      {select(
        "optionNodeId",
        "Readiness option",
        "Choose an option",
        (field?.options ?? []).map((o) => ({
          id: o.optionNodeId,
          name: o.name,
        })),
        (v) => p.onChange({ ...ids, optionNodeId: v }),
        loading || !field,
      )}
    </>
  );
}
