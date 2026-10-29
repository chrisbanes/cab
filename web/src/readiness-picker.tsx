import {
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import type { z } from "zod";
import {
  discoveryLabelsSchema,
  discoveryStatusSchema,
  discoveryProjectFieldsSchema,
  discoveryProjectsSchema,
  discoveryRepositoriesSchema,
  type sourceObservationSchema,
} from "../../src/operator/contracts.js";
import type { OperatorClient } from "./api.js";
import { Button } from "./components.js";
import {
  discoveryElsewhereNote,
  discoveryUseNote,
} from "./discovery-credential.js";
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
  selectField,
  selectProject,
  toggleOption,
  unlistedLabelNote,
} from "./readiness-discovery.js";
import { useOperatorResource } from "./resource.js";
import type { SourceRow } from "./settings-changes.js";
import {
  DraftMessage,
  key,
  useDiscoveryUnsettled,
  useDraft,
  type SettingsProps,
} from "./settings.js";
import { Input } from "./ui/input.js";
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
  // Counts the rounds started on request; a new one forgets every read, so typed fallbacks end.
  const [generation, setGeneration] = useState(0);
  const requested = useRef(new Set<string>());
  const round = useRef(0);
  const forget = () => {
    setRepositories(undefined);
    setProjectReads({});
    setFieldReads({});
    setLabelReads({});
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-read when the session (CSRF token) changes.
  useEffect(() => {
    if (!on) return;
    const mine = ++round.current;
    requested.current.clear();
    forget();
    p.client
      .read("/api/operator/discovery/repositories", discoveryRepositoriesSchema)
      .then(
        (r) => mine === round.current && setRepositories(r.data),
        () => mine === round.current && setRepositories(unreadable),
      );
  }, [p.client, p.csrfToken, on, generation]);

  const names =
    repositories?.state === "ready" && !repositories.truncated
      ? linkedRepositoryNames(p.saved, repositories.repositories)
      : [];
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed by the resolved repository list.
  useEffect(() => {
    const mine = round.current;
    if (!p.enabled) return;
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
  }, [names.join("\n"), p.enabled, p.client]);

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
    generation,
    /** Reads everything again, such as after the discovery credential was set. */
    refresh: () => {
      // Together with the new round, so no render shows the old reads under it.
      forget();
      setGeneration((n) => n + 1);
    },
  };
}
export type ReadinessDiscovery = ReturnType<typeof useReadinessDiscovery>;

type SelectionFields = NonNullable<
  z.infer<
    typeof sourceObservationSchema
  >["data"]["projects"][number]["selections"][number]["projectFields"]
>;

/**
 * A Project source's single-select fields with each option's open items, read only: readiness
 * conditions are made in the condition editor.
 */
export function ProjectFieldOptions(p: {
  projectFields: SelectionFields | null | undefined;
}) {
  if (!p.projectFields?.fields.some((f) => f.options.length)) return null;
  return (
    <div className="settings-rows">
      <p className="metadata">Project fields</p>
      {p.projectFields.fields.map((f) => (
        <div key={f.fieldNodeId}>
          <p className="body">{f.name}</p>
          <ul className="settings-pills">
            {f.options.map((o) => (
              <li key={o.optionNodeId}>
                <span className="metadata">
                  {o.name} · {o.open}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ))}
      <p className="metadata muted">
        Open items of this source per option, from its last complete read.
      </p>
    </div>
  );
}

/** The select value that reveals the text input for a label not on the repositories. */
const otherLabel = " other";

/**
 * The Ready label select: the source repositories' labels, a saved label they no longer list,
 * and "Other…" for a name that doesn't exist yet. When labels can't be listed, a text input.
 */
export function ReadyLabelPicker(p: {
  index: number;
  value: string;
  discovery: ReadinessDiscovery;
  invalid: boolean;
  onChange: (name: string) => void;
  /** The text input, named `label`. */
  input: (label: string) => ReactNode;
}) {
  const { labels } = p.discovery;
  const [other, setOther] = useState(false);
  // Until the labels are listed (or when they can't be) the text input stands alone.
  if (labels.state !== "ready")
    return (
      <>
        {p.input("Ready label")}
        {labels.state === "typed" && labels.note && (
          <p className="metadata muted">{labels.note}</p>
        )}
      </>
    );
  // The id a row error focuses; the revealed text input takes it over under "Other…".
  const id = `source-conditions-${p.index}-${other ? "name-select" : "name"}`;
  const unlisted = p.value !== "" && !other && !labels.labels.includes(p.value);
  return (
    <>
      <label className="field body" htmlFor={id}>
        Ready label
        <NativeSelect
          className="control"
          id={id}
          aria-label="Ready label"
          aria-invalid={p.invalid}
          aria-describedby={p.invalid ? "source-conditions-error" : undefined}
          value={other ? otherLabel : p.value}
          onChange={(e) => {
            setOther(e.target.value === otherLabel);
            if (e.target.value !== otherLabel) p.onChange(e.target.value);
          }}
        >
          <option value="">Choose a label</option>
          {labels.labels.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
          {unlisted && <option value={p.value}>{p.value}</option>}
          <option value={otherLabel}>Other…</option>
        </NativeSelect>
      </label>
      {unlisted && labels.labels.length > 0 && (
        <p className="metadata muted">{unlistedLabelNote}</p>
      )}
      {other && p.input("Other label")}
    </>
  );
}

/** Option node IDs typed as a list; the text is kept as typed, so a separator can be entered. */
function OptionIdsInput(p: {
  id: string;
  value: readonly string[];
  invalid: boolean;
  onChange: (ids: string[]) => void;
}) {
  const [text, setText] = useState(p.value.join(", "));
  return (
    <label className="field body" htmlFor={p.id}>
      Readiness option node IDs
      <Input
        className="control"
        id={p.id}
        aria-label="Readiness option node IDs"
        aria-invalid={p.invalid}
        aria-describedby={p.invalid ? "source-conditions-error" : undefined}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          p.onChange(
            e.target.value
              .split(/[,\n]/)
              .map((x) => x.trim())
              .filter(Boolean),
          );
        }}
      />
    </label>
  );
}

/**
 * Name selects for one Project-field condition: Project, field, operator, then a checkbox per
 * option. A row whose state falls back to typed node IDs stays typed while it is mounted, so
 * controls never swap under the cursor.
 */
export function ProjectFieldPicker(p: {
  index: number;
  row: SourceRow;
  discovery: ReadinessDiscovery;
  /** A typed text input for a row value, named `label`. */
  input: (name: string, label: string) => ReactNode;
  invalid: (name: string) => boolean;
  onChange: (patch: Partial<ConditionIds> & { operator?: string }) => void;
}) {
  const optionNodeIds = Array.isArray(p.row.optionNodeIds)
    ? p.row.optionNodeIds.map(String)
    : [];
  const ids: ConditionIds = {
    projectNodeId: String(p.row.projectNodeId ?? ""),
    fieldNodeId: String(p.row.fieldNodeId ?? ""),
    optionNodeIds,
  };
  const state = rowState(ids, p.discovery.choices, p.discovery.fieldReads);
  const sticky = useRef<string | null>(null);
  // Only a new round of reads (the credential changed) lets a typed row become a picker.
  const round = useRef(p.discovery.generation);
  if (round.current !== p.discovery.generation) {
    round.current = p.discovery.generation;
    sticky.current = null;
  }
  if (state.state === "typed") sticky.current = state.note;
  const operator = (
    <label
      className="field body"
      htmlFor={`source-conditions-${p.index}-operator`}
    >
      Readiness operator
      <NativeSelect
        className="control"
        id={`source-conditions-${p.index}-operator`}
        aria-label="Readiness operator"
        aria-invalid={p.invalid("operator")}
        value={String(p.row.operator ?? "in")}
        onChange={(e) => p.onChange({ operator: e.target.value })}
      >
        <option value="in">is one of</option>
        <option value="not-in">is not one of</option>
      </NativeSelect>
    </label>
  );
  if (sticky.current !== null)
    return (
      <>
        {p.input("projectNodeId", "Readiness Project node ID")}
        {p.input("fieldNodeId", "Readiness field node ID")}
        {operator}
        <OptionIdsInput
          id={`source-conditions-${p.index}-optionNodeIds`}
          value={optionNodeIds}
          invalid={p.invalid("optionNodeIds")}
          onChange={(next) => p.onChange({ optionNodeIds: next })}
        />
        <p className="metadata muted">{sticky.current}</p>
      </>
    );
  const loading = state.state === "loading";
  const projects = state.state === "typed" ? [] : (state.projects ?? []);
  const fields = state.state === "picker" ? state.fields : [];
  const field = fields.find((f) => f.fieldNodeId === ids.fieldNodeId);
  const listed = (field?.options ?? []).map((o) => o.optionNodeId);
  const select = (
    name: "projectNodeId" | "fieldNodeId",
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
      {operator}
      {field && (
        <fieldset
          className="settings-rows"
          aria-invalid={p.invalid("optionNodeIds")}
        >
          <legend className="body">Readiness options</legend>
          {[
            ...(field.options ?? []),
            // A saved option the read does not list stays checked, shown by its node ID.
            ...optionNodeIds
              .filter((id) => !listed.includes(id))
              .map((id) => ({ optionNodeId: id, name: id })),
          ].map((o, n) => (
            <label
              key={o.optionNodeId}
              className="body check-field"
              htmlFor={`source-conditions-${p.index}-option-${n}`}
            >
              <Input
                id={`source-conditions-${p.index}-option-${n}`}
                type="checkbox"
                className="native-check size-5 shrink-0 p-0 accent-foreground"
                checked={optionNodeIds.includes(o.optionNodeId)}
                onChange={(e) =>
                  p.onChange({
                    optionNodeIds: toggleOption(
                      listed,
                      optionNodeIds,
                      o.optionNodeId,
                      e.target.checked,
                    ),
                  })
                }
              />
              {o.name}
            </label>
          ))}
        </fieldset>
      )}
    </>
  );
}

/**
 * The one-click `discovery.configure` with the signed-in GitHub CLI login, above the readiness
 * conditions, for a credential that is not configured (their Projects and fields are then typed
 * as node IDs). It is held like the other offers while a save elsewhere is unconfirmed.
 */
export function ReadinessLoginOffer(
  p: Pick<SettingsProps, "drafts" | "client"> & {
    csrfToken: string;
    /** A rule of at least one condition exists; the offer is shown for nothing else. */
    visible: boolean;
    /** The login was saved; read what the credential unlocks again. `moveFocus` if focus was here. */
    onRecorded: (moveFocus: boolean) => void;
  },
) {
  const loader = useCallback(
    (signal: AbortSignal) =>
      p.client.read("/api/operator/discovery", discoveryStatusSchema, signal),
    [p.client],
  );
  // A tab with no conditions never shows the offer, so it makes no read.
  const status = useOperatorResource(p.csrfToken, loader, p.visible);
  const own = "discovery.configure:readiness-picker";
  const d = useDraft(p.drafts, own);
  // A new visit starts clean; an unsettled login stays until it is checked.
  useEffect(() => d.startOperation({ key: key() }), [d]);
  const elsewhere = useDiscoveryUnsettled(p.drafts, own);
  const elsewhereId = useId();
  const box = useRef<HTMLDivElement>(null);
  const announced = useRef<number | null>(null);
  const { onRecorded } = p;
  const { refresh } = status;
  // A recorded save is announced once, whichever instance sent it. Focus moves with it only
  // if it was still on the offer, or nowhere: the offer leaves once discovery reads as set.
  useEffect(() => {
    if (d.phase !== "recorded" || d.savedAt === null) return;
    if (announced.current === d.savedAt) return;
    announced.current = d.savedAt;
    refresh();
    const at = document.activeElement;
    onRecorded(at === document.body || Boolean(box.current?.contains(at)));
  }, [d, d.phase, d.savedAt, refresh, onRecorded]);
  // A recorded offer is spent once a read made after it answers.
  const { fetchedAt, pending } = status.state;
  useEffect(() => {
    if (
      d.phase === "recorded" &&
      !pending &&
      fetchedAt !== null &&
      d.savedAt !== null &&
      announced.current === d.savedAt &&
      fetchedAt >= d.savedAt
    )
      d.startOperation({ key: key() });
  }, [d, d.phase, d.savedAt, pending, fetchedAt]);
  const read = status.state.data?.data;
  const login =
    p.visible &&
    !status.state.error &&
    read &&
    !read.configured &&
    read.gh.state === "signed-in" &&
    d.phase !== "unknown"
      ? read.gh.login
      : null;
  const idle = login === null && d.phase === "editing";
  const offer = () =>
    d.submit(
      p.client,
      {
        type: "discovery.configure",
        key: d.values.key,
        credentialRef: "gh:github.com",
      },
      p.csrfToken,
    );
  return (
    <div
      ref={box}
      // Takes no row of the panel's grid while there is nothing to offer or say.
      hidden={idle}
      className={idle ? undefined : "settings-rows"}
    >
      {login !== null && (
        <>
          <Button
            type="button"
            variant="secondary"
            // Stays in place while saving so focus is not dropped; a pending, a recorded or
            // another surface's unconfirmed save is not sent over.
            aria-disabled={
              d.phase === "pending" || d.phase === "recorded" || elsewhere
            }
            aria-describedby={elsewhere ? elsewhereId : undefined}
            className="aria-disabled:opacity-50"
            onClick={() =>
              d.phase === "recorded" || elsewhere ? undefined : void offer()
            }
          >
            {d.phase === "pending"
              ? "Saving…"
              : `Use GitHub CLI login (@${login})`}
          </Button>
          <p className="metadata muted">{discoveryUseNote}</p>
          {elsewhere && (
            <p id={elsewhereId} className="metadata muted">
              {discoveryElsewhereNote}
            </p>
          )}
        </>
      )}
      <DraftMessage
        draft={d}
        success={null}
        check={() => d.reconcile(p.client, p.csrfToken)}
      />
    </div>
  );
}
