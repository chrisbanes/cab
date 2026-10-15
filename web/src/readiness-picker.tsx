import { type ReactNode, useEffect, useRef, useState } from "react";
import {
  discoveryProjectFieldsSchema,
  discoveryProjectsSchema,
  discoveryRepositoriesSchema,
} from "../../src/operator/contracts.js";
import type { OperatorClient } from "./api.js";
import {
  type ConditionIds,
  type FieldsRead,
  linkedRepositoryNames,
  type ProjectsRead,
  projectChoices,
  type RepositoriesRead,
  rowState,
  selectField,
  selectProject,
} from "./readiness-discovery.js";
import type { SourceRow } from "./settings-changes.js";
import { NativeSelect } from "./ui/native-select.js";

const unreadable = { state: "unavailable", reason: "unreadable" } as const;

/**
 * Reads, while a Project-field condition exists, the repositories, each saved link's Projects
 * and the fields of each listed Project a row names. Each read is made once per session round.
 */
export function useReadinessDiscovery(p: {
  client: OperatorClient;
  csrfToken: string;
  enabled: boolean;
  saved: { repositoryId: string }[];
  projectIds: string[];
}) {
  const [repositories, setRepositories] = useState<RepositoriesRead>();
  const [projectReads, setProjectReads] = useState<
    Record<string, ProjectsRead>
  >({});
  const [fieldReads, setFieldReads] = useState<Record<string, FieldsRead>>({});
  const requested = useRef(new Set<string>());
  const round = useRef(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-read when the session (CSRF token) changes.
  useEffect(() => {
    if (!p.enabled) return;
    const mine = ++round.current;
    requested.current.clear();
    setRepositories(undefined);
    setProjectReads({});
    setFieldReads({});
    p.client
      .read("/api/operator/discovery/repositories", discoveryRepositoriesSchema)
      .then(
        (r) => mine === round.current && setRepositories(r.data),
        () => mine === round.current && setRepositories(unreadable),
      );
  }, [p.client, p.csrfToken, p.enabled]);

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

  return { choices, fieldReads };
}
export type ReadinessDiscovery = ReturnType<typeof useReadinessDiscovery>;

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
