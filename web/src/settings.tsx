import {
  useEffect,
  useReducer,
  useRef,
  useId,
  type FormEvent,
  type ReactNode,
} from "react";
import type {
  CommandReceipt,
  Workspace,
  Session,
} from "../../src/operator/contracts.js";
import type { OperatorClient } from "./api.js";
import type {
  ConfigurationDraft,
  ConfigurationDrafts,
  SavedRecord,
} from "./settings-state.js";
import type { Values } from "./settings-changes.js";
import { clock } from "./settings-view.js";
import { Button } from "./components.js";
import { Alert } from "./ui/alert.js";
import { Input } from "./ui/input.js";
import { NativeSelect } from "./ui/native-select.js";
import { Textarea } from "./ui/textarea.js";
import "./settings.css";
export interface SettingsProps {
  client: OperatorClient;
  session: Session;
  drafts: ConfigurationDrafts;
  workspace: Workspace | null;
  refresh: () => void;
  /** Bumped by the header Refresh; each settings page re-reads its own resources. */
  refreshNonce?: number;
}
/** Re-read a page's resources when the header Refresh is pressed. */
export function useHeaderRefresh(nonce: number | undefined, read: () => void) {
  const latest = useRef(read);
  latest.current = read;
  const first = useRef(nonce);
  useEffect(() => {
    if (nonce !== first.current) latest.current();
  }, [nonce]);
}
/**
 * Load a draft from the current read. After a recorded save the draft is purged and
 * re-initialised from the next completed read (`loadedAt` changes); `initialize` itself
 * never replaces dirty or frozen input, and an unknown outcome is never reset.
 */
export function useLoadedDraft(
  d: ConfigurationDraft,
  values: Values | null,
  loadedAt: number | null,
  /** Identity of the load; defaults to the values themselves. */
  signature: unknown = values,
) {
  const serialized = values && JSON.stringify(signature);
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run only when a read completes or the loaded values change.
  useEffect(() => {
    if (!values) return;
    if (d.phase === "recorded") d.startOperation(fresh(values));
    else d.initialize(fresh(values));
  }, [d, serialized, loadedAt]);
}
const fresh = (values: Values) => ({ ...values, key: crypto.randomUUID() });
/** Discard unsaved input: start a new operation from the loaded values. */
export const reloadDraft = (d: ConfigurationDraft, values: Values) =>
  d.startOperation(fresh(values));
export const locked = (d: ConfigurationDraft) =>
  d.phase === "pending" || d.phase === "unknown" || d.phase === "recorded";
export function useDraft(drafts: ConfigurationDrafts, key: string) {
  const [, render] = useReducer((v) => v + 1, 0);
  const d = drafts.get(key, render);
  return d;
}
export function DraftField({
  draft,
  field,
  errorField = field,
  label,
  multiline = false,
  children,
  type = "text",
}: {
  draft: ConfigurationDraft;
  field: string;
  errorField?: string;
  label: string;
  multiline?: boolean;
  children?: ReactNode;
  type?: string;
}) {
  const id = useId(),
    error = draft.errors[errorField];
  const props = {
    id,
    "aria-label": label,
    disabled: locked(draft),
    "aria-invalid": Boolean(error),
    "aria-describedby": error ? `${id}-error` : undefined,
    className: "control",
    value: String(draft.values[field] ?? ""),
    onChange: (e: { target: { value: string } }) =>
      draft.set(field, e.target.value),
  };
  return (
    <label className="field body" htmlFor={id}>
      {label}
      {children ? (
        <NativeSelect {...props}>{children}</NativeSelect>
      ) : multiline ? (
        <Textarea {...props} rows={4} />
      ) : (
        <Input {...props} type={type} />
      )}{" "}
      {error && (
        <span id={`${id}-error`} className="error-text" role="alert">
          {error}
        </span>
      )}
    </label>
  );
}
export function DraftCheck({
  draft,
  field,
  label,
  toggle = false,
}: {
  draft: ConfigurationDraft;
  field: string;
  label: string;
  /** Draw the checkbox as a switch (frames draw switches for on/off settings). */
  toggle?: boolean;
}) {
  const id = useId();
  return (
    <label className="body check-field" htmlFor={id}>
      <Input
        id={id}
        data-slot="checkbox-input"
        type="checkbox"
        role={toggle ? "switch" : undefined}
        className={`native-check size-5 shrink-0 p-0 accent-foreground${toggle ? " settings-switch" : ""}`}
        checked={Boolean(draft.values[field])}
        disabled={locked(draft)}
        onChange={(e) => draft.set(field, e.target.checked)}
      />
      {label}
    </label>
  );
}
export function DraftOutcome({
  draft,
  client,
  session,
  label,
  saveDisabled = false,
  discard,
  onRecorded,
}: {
  draft: ConfigurationDraft;
  client: OperatorClient;
  session: Session;
  label: string;
  /** Save stays disabled until the change list is non-empty. */
  saveDisabled?: boolean;
  /** Restores the loaded values; shown while there is unsaved input. */
  discard?: () => void;
  /** Re-read after a reconciled submission is recorded, as `submitDraft` does after a save. */
  onRecorded?: () => void;
}) {
  return (
    <>
      <div className="settings-actions">
        {draft.phase === "unknown" ? (
          <Button
            type="button"
            onClick={async () => {
              await draft.reconcile(client, session.csrfToken);
              if (draft.phase === "recorded") onRecorded?.();
            }}
          >
            Reconcile exact submission
          </Button>
        ) : (
          <Button
            type="submit"
            disabled={
              draft.phase === "pending" ||
              draft.phase === "recorded" ||
              saveDisabled
            }
          >
            {draft.phase === "pending" ? "Saving…" : label}
          </Button>
        )}
        {discard &&
          draft.dirty &&
          draft.phase !== "pending" &&
          draft.phase !== "unknown" &&
          draft.phase !== "recorded" && (
            <Button type="button" variant="secondary" onClick={discard}>
              Discard changes
            </Button>
          )}
      </div>
      {draft.notice && (
        <Alert
          variant={
            draft.phase === "unknown" ||
            draft.phase === "rejected" ||
            draft.phase === "conflict"
              ? "destructive"
              : "default"
          }
          role={
            draft.phase === "unknown" ||
            draft.phase === "rejected" ||
            draft.phase === "conflict"
              ? "alert"
              : "status"
          }
        >
          {draft.notice}
        </Alert>
      )}
      {draft.receipt && (
        <Alert role="status">
          <ReceiptText receipt={draft.receipt} />
        </Alert>
      )}
    </>
  );
}
function ReceiptText({ receipt }: { receipt: CommandReceipt }) {
  if (receipt.kind !== "configuration") return null;
  const r = receipt.result;
  return r.commandType === "capacity.configure" ? (
    <>
      Recorded capacity limits: global {r.globalLimit}; default project{" "}
      {r.defaultProjectLimit}; project overrides{" "}
      {Object.entries(r.projectOverrides)
        .map(([id, limit]) => `${id}: ${limit}`)
        .join(", ") || "none"}
      .
    </>
  ) : (
    <>
      Recorded {r.commandType}: {r.resourceId}; version{" "}
      {"version" in r ? r.version : r.configVersion}.
    </>
  );
}
/** Persistent confirmation of a save this browser session recorded, from its original receipt. */
export function SavedNotice({
  saved,
  label,
}: {
  saved: SavedRecord | undefined;
  label: string;
}) {
  return saved ? (
    <Alert role="status" className="settings-saved">
      <strong>
        {label} · {clock(saved.at)}.
      </strong>{" "}
      <ReceiptText receipt={saved.receipt} /> Latest observations may differ
      from this original receipt.
    </Alert>
  ) : null;
}
/** The "Changes to save" panel: one line per change, never a private value. */
export function ChangeList({
  lines,
  children,
}: {
  lines: string[];
  children?: ReactNode;
}) {
  return (
    <section className="settings-changes" aria-label="Changes to save">
      <h3 className="small-heading">
        Changes to save{lines.length ? ` · ${lines.length}` : ""}
      </h3>
      {lines.length ? (
        <ul className="body">
          {lines.map((line, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: lines can repeat; the list is rebuilt from the draft.
            <li key={i}>{line}</li>
          ))}
        </ul>
      ) : (
        <p className="metadata muted">
          No changes yet. Save is available once something changes.
        </p>
      )}
      {children}
    </section>
  );
}
/** A titled panel of the settings layouts. */
export function Panel({
  title,
  description,
  action,
  className,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <section className={`settings-panel${className ? ` ${className}` : ""}`}>
      <div className="settings-panel-header">
        <div>
          <h2 className="settings-panel-title">{title}</h2>
          {description && <p className="metadata muted">{description}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}
/** A muted aside list (boundaries and related links). */
export function Aside({ title, items }: { title: string; items: ReactNode[] }) {
  return (
    <aside className="settings-aside" aria-label={title}>
      <h2 className="small-heading">{title}</h2>
      <ul className="body">
        {items.map((item, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: static list.
          <li key={i}>{item}</li>
        ))}
      </ul>
    </aside>
  );
}
export async function submitDraft(
  e: FormEvent,
  d: ConfigurationDraft,
  client: OperatorClient,
  session: Session,
  command: unknown,
  refresh: () => void,
) {
  const form = e.currentTarget;
  e.preventDefault();
  await d.submit(client, command, session.csrfToken);
  if (d.phase === "recorded") refresh();
  else if (d.phase === "rejected")
    requestAnimationFrame(() =>
      form.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus(),
    );
}
export const key = () => crypto.randomUUID();
export function ProjectSetup(p: SettingsProps) {
  const d = useDraft(p.drafts, "project.create");
  useEffect(
    () =>
      d.initialize({
        name: "",
        leadProfileId: "",
        projectId: key(),
        key: key(),
      }),
    [d],
  );
  const recorded =
    d.receipt?.kind === "configuration" ? d.receipt.result : null;
  return (
    <section className="settings-stack">
      <a href="/app/settings">Settings home</a>
      <h2 className="section-heading">Create project</h2>
      <p className="body muted">
        First choose a lead, or leave it unconfigured. A new project starts
        paused. Creating it starts no execution. Instructions and optional
        repository access are separately saved steps.
      </p>
      <a href="/app/settings/profiles/new">Create a lead profile</a>
      <form
        onSubmit={(e) =>
          void submitDraft(
            e,
            d,
            p.client,
            p.session,
            {
              type: "project.create",
              key: d.values.key,
              projectId: d.values.projectId,
              name: d.values.name,
              leadProfileId: d.values.leadProfileId || null,
            },
            p.refresh,
          )
        }
      >
        <DraftField draft={d} field="name" label="Project name" />
        <DraftField draft={d} field="leadProfileId" label="Lead profile">
          <option value="">Unconfigured</option>
          {p.workspace?.data.profiles
            .filter((r) => !r.revoked)
            .map((r) => (
              <option key={r.id} value={r.id}>
                {r.name ?? "Name unavailable"}
              </option>
            ))}
        </DraftField>
        <DraftOutcome
          draft={d}
          client={p.client}
          session={p.session}
          label="Create paused project"
        />
      </form>
      {recorded && (
        <a href={`/app/projects/${recorded.resourceId}/settings`}>
          Set instructions and optional source access
        </a>
      )}
      {recorded && (
        <Button
          type="button"
          variant="secondary"
          onClick={() =>
            d.startOperation({
              name: "",
              leadProfileId: "",
              projectId: key(),
              key: key(),
            })
          }
        >
          Create another project
        </Button>
      )}
    </section>
  );
}
export function ReferenceInput({ draft }: { draft: ConfigurationDraft }) {
  return (
    <>
      <DraftField
        draft={draft}
        field="referenceMode"
        label="Credential reference change"
      >
        <option value="preserve">Preserve current reference</option>
        <option value="set">Set new environment reference</option>
        <option value="clear">Clear reference</option>
      </DraftField>
      {draft.values.referenceMode === "set" && (
        <DraftField
          draft={draft}
          field="credentialRef"
          label="New environment reference"
        />
      )}
      <p className="metadata muted">
        Only an env:NAME reference is accepted. Its value stays server-side.
      </p>
    </>
  );
}
