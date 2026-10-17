import {
  useCallback,
  useEffect,
  useState,
  useReducer,
  useRef,
  useId,
  type FormEvent,
  type ReactNode,
} from "react";
import type { z } from "zod";
import type { Workspace, Session } from "../../src/operator/contracts.js";
import type { OperatorClient } from "./api.js";
import { useOperatorResource, type ResourceState } from "./resource.js";
import { ActionOutcome, detailRows } from "./action-feedback.js";
import {
  outcomeCopy,
  type ConfigurationDraft,
  type ConfigurationDrafts,
} from "./settings-state.js";
import { sameText, type Values } from "./settings-changes.js";
import { Button } from "./components.js";
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
    if (d.phase === "recorded") d.startOperation(fresh(values), true);
    else d.initialize(fresh(values));
  }, [d, serialized, loadedAt]);
  // A read that arrived while the form had edits was left alone. When every edit is undone
  // the form is clean again, so it takes the latest read at once.
  const clean = !d.dirty;
  const wasClean = useRef({ d, clean });
  // biome-ignore lint/correctness/useExhaustiveDependencies: only the form turning clean matters.
  useEffect(() => {
    // Another draft (the page now edits something else) starts from its own state.
    const was = wasClean.current.d === d ? wasClean.current.clean : clean;
    if (values && clean && !was && d.phase !== "recorded")
      d.initialize(fresh(values), true);
    wasClean.current = { d, clean };
  }, [d, clean]);
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
  // Each commit reports the changes it shows, so `afterRender` runs on the one that shows its own.
  const revision = d.revision;
  useEffect(() => d.committed(revision));
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
/**
 * Run `act` while `due` holds, at most `cap` times for one `key`. The decision is derived from
 * state on every render: the effect depends on the key and on `due` itself, so any change that
 * makes it due again (a read settling stale, failing, or the version moving) re-evaluates it.
 */
function useBoundedRetry(key: unknown, due: boolean, act: () => void, cap = 2) {
  const latest = useRef(act);
  latest.current = act;
  const tries = useRef({ key, count: 0 });
  useEffect(() => {
    if (!Object.is(tries.current.key, key)) tries.current = { key, count: 0 };
    if (due && tries.current.count < cap) {
      tries.current.count++;
      latest.current();
    }
  }, [key, due, cap]);
}
/** Whether a draft still holds input that a read could be compared with. */
export const editable = (phase: ConfigurationDraft["phase"]) =>
  phase === "editing" || phase === "conflict" || phase === "rejected";
/**
 * One owner's private values, read only for this signed-in session. The result lives in
 * component state alone: the scope (session token and owner) clears it on sign-out and
 * owner change, and unmounting aborts a read in flight. Nothing here is stored or logged.
 *
 * The read is kept in step with the loaded configuration. It is read again, at most twice per
 * loaded version, when it is wanted (autoLoad, a Reveal the operator asked for, or an edit that
 * must be compared with the saved text) and no read at the loaded version is available, none is
 * in flight and the last one did not fail at this version. A read that is newer than the loaded
 * configuration instead re-reads the configuration.
 */
export function usePrivateValues<T>(
  client: OperatorClient,
  session: Session,
  path: string,
  schema: z.ZodType<T>,
  options: {
    autoLoad?: boolean;
    /** The section version of the configuration now loaded. */
    loaded?: number | undefined;
    /** The section version a private read was made at. */
    version?: (data: T) => number;
    /** The form holds an edit that has to be compared with the saved text. */
    edit?: boolean;
    /** Re-read the configuration (used when a private read is newer than it). */
    refreshLoaded?: () => void;
  } = {},
) {
  const { autoLoad = false, loaded, version, edit = false } = options;
  // The loader must stay stable: a new one would clear the revealed state.
  const loader = useCallback(
    (signal: AbortSignal) => client.read(path, schema, signal),
    [client, path, schema],
  );
  const resource = useOperatorResource(
    `${session.csrfToken}:${path}`,
    loader,
    autoLoad,
  );
  const { state } = resource;
  const [requested, setRequested] = useState(autoLoad);
  const read = state.data && version ? version(state.data) : undefined;
  const inFlight = state.pending || (autoLoad && state.status === "empty");
  // A current read settles a Reveal the operator asked for.
  useEffect(() => {
    if (!autoLoad && read !== undefined && read === loaded) setRequested(false);
  }, [autoLoad, read, loaded]);
  // A failure is the operator's to retry, unless the version moved on since it happened. The
  // version it happened at is noted the first time the failure is seen (idempotent per state).
  const failure = useRef<{ failed: boolean; at: number | undefined }>({
    failed: false,
    at: undefined,
  });
  if (state.error === null) failure.current = { failed: false, at: undefined };
  else if (!failure.current.failed)
    failure.current = { failed: true, at: loaded };
  useBoundedRetry(
    loaded,
    (requested || edit) &&
      loaded !== undefined &&
      !inFlight &&
      (read === undefined || read < loaded) &&
      (state.error === null || failure.current.at !== loaded),
    resource.refresh,
  );
  useBoundedRetry(
    read,
    loaded !== undefined &&
      read !== undefined &&
      read > loaded &&
      !inFlight &&
      options.refreshLoaded !== undefined,
    () => options.refreshLoaded?.(),
  );
  return {
    ...resource,
    /** The operator asked for the text: read it, and again if the version moves meanwhile. */
    reveal: () => {
      setRequested(true);
      void resource.refresh();
    },
  };
}
/** The revealed text, only while it was read at the section version now loaded. */
export function revealedText<T>(
  state: ResourceState<T>,
  pick: (data: T) => { version: number; text: string },
  version: number,
): string | undefined {
  const value = state.data ? pick(state.data) : undefined;
  return value && value.version === version ? value.text : undefined;
}
export const textHold =
  "Save is on hold until the saved text is read again to compare it with your edit.";
export const sourceHold =
  "Save is on hold until the saved queries and paths are read again to compare them with your edits.";
/**
 * "Kept · Reveal" until the signed-in operator reveals a private text, then the same
 * multiline field. Revealed text is shown from `revealed` and enters the draft only once
 * the operator edits it, so an unedited reveal is never sent or kept across pages.
 */
export function PrivateTextField({
  draft,
  field,
  label,
  noun,
  revealed,
  state,
  onReveal,
  children,
}: {
  draft: ConfigurationDraft;
  field: string;
  label: string;
  /** Lower-case name used in the button and error copy, such as "instructions". */
  noun: string;
  revealed: string | undefined;
  state: ResourceState<unknown>;
  onReveal: () => void;
  /** Guidance shown under the control in both states. */
  children?: ReactNode;
}) {
  const id = useId(),
    error = draft.errors[field],
    area = useRef<HTMLTextAreaElement>(null),
    focusNext = useRef(false),
    edited = typeof draft.values[field] === "string",
    // The text the edit started from; typing it back removes the edit.
    base = edited ? String(draft.values[`${field}Base`] ?? "") : revealed,
    changedElsewhere = edited && revealed !== undefined && revealed !== base,
    open = edited || revealed !== undefined,
    loading = state.pending,
    failed = !loading && state.error !== null;
  // An edit exists only while it differs from the text saved now. When a current read shows
  // the same text (another writer saved it), the edit and its baseline are dropped, so the
  // form is clean and later reads apply.
  const value = edited ? String(draft.values[field]) : undefined;
  // biome-ignore lint/correctness/useExhaustiveDependencies: act when the read or the edit changes.
  useEffect(() => {
    if (
      value !== undefined &&
      revealed !== undefined &&
      sameText(value, revealed) &&
      (draft.phase === "editing" ||
        draft.phase === "conflict" ||
        draft.phase === "rejected")
    )
      draft.setPrivate(
        field,
        value,
        String(draft.values[`${field}Base`] ?? ""),
        revealed,
      );
  }, [value, revealed, draft.phase]);
  // Focus moves to the field once, after a Reveal the operator asked for has rendered it.
  useEffect(() => {
    if (failed) focusNext.current = false;
    else if (open && focusNext.current) {
      focusNext.current = false;
      area.current?.focus();
    }
  });
  if (open)
    return (
      <div className="field body">
        <label className="field body" htmlFor={id}>
          {label}
          <Textarea
            ref={area}
            id={id}
            rows={4}
            aria-label={label}
            disabled={locked(draft)}
            aria-invalid={Boolean(error)}
            aria-describedby={error ? `${id}-error` : undefined}
            className="control"
            value={edited ? String(draft.values[field]) : (revealed ?? "")}
            onChange={(e) =>
              draft.setPrivate(field, e.target.value, base ?? "", revealed)
            }
          />
          {error && (
            <span id={`${id}-error`} className="error-text" role="alert">
              {error}
            </span>
          )}
        </label>
        {changedElsewhere && (
          <p className="metadata muted" role="status">
            This was changed elsewhere since you started editing. Saving
            replaces it.
          </p>
        )}
        {edited &&
          revealed === undefined &&
          !loading &&
          (failed || state.data !== null) && (
            <p className="body error-text" role="alert">
              Couldn't check whether this changed elsewhere.{" "}
              <Button type="button" variant="secondary" onClick={onReveal}>
                Try again
              </Button>
            </p>
          )}
        {children}
      </div>
    );
  return (
    <fieldset className="field body private-field">
      <legend>{label}</legend>
      <p className="body">
        Kept <span aria-hidden="true">·</span>{" "}
        <Button
          type="button"
          variant="secondary"
          aria-label={failed ? `Try again to reveal ${noun}` : `Reveal ${noun}`}
          aria-busy={loading || undefined}
          aria-disabled={loading || locked(draft) || undefined}
          onClick={() => {
            if (loading || locked(draft)) return;
            focusNext.current = true;
            onReveal();
          }}
        >
          {failed ? "Try again" : "Reveal"}
        </Button>
      </p>
      {failed && (
        <span className="error-text" role="alert">
          Couldn't load the {noun}.
        </span>
      )}
      {children}
    </fieldset>
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
/**
 * The one message a draft leaves behind, chosen by its phase. In progress shows nothing
 * here (the button says "Saving…"); a save stays confirmed until the next edit.
 */
export function DraftMessage({
  draft,
  check,
  review,
  success,
  children,
}: {
  draft: ConfigurationDraft;
  /** The single action of an unknown outcome: resend the exact original request. */
  check?: (() => void | Promise<void>) | undefined;
  /** The single action of a newer version saved elsewhere. */
  review?: (() => void) | undefined;
  /** One plain sentence that replaces "Saved."; `null` leaves the confirmation to the caller. */
  success?: string | null | undefined;
  /** More under the success line, such as what was created and where to go next. */
  children?: ReactNode;
}) {
  const details = detailRows(draft.details);
  // A message that follows a send replaces the control the operator used, so it takes the
  // focus; one restored on a later visit does not. Checking removes its own button, so any
  // answer to a check takes the focus too.
  const sent = useRef(false);
  const checking = useRef(false);
  if (draft.phase === "pending") sent.current = true;
  const answersCheck = checking.current;
  useEffect(() => {
    if (draft.phase !== "pending") checking.current = false;
  });
  const checkAndFocus =
    check &&
    (() => {
      checking.current = true;
      return check();
    });
  switch (draft.phase) {
    case "pending":
      return null;
    case "rejected":
      return (
        <ActionOutcome
          tone="error"
          title={
            !draft.credentialRefusal && Object.keys(draft.errors).length
              ? outcomeCopy.fieldsTitle
              : undefined
          }
          message={draft.notice}
          focus={answersCheck}
          details={details}
        />
      );
    case "conflict":
      return draft.credentialRefusal ? (
        <ActionOutcome
          tone="error"
          message={draft.notice}
          focus={answersCheck}
          details={details}
        />
      ) : (
        <ActionOutcome
          tone="warning"
          message={draft.notice}
          action={review && { label: "Review changes", onClick: review }}
          focus={answersCheck}
          details={details}
        />
      );
    case "unknown":
      return (
        <ActionOutcome
          tone="warning"
          message={draft.notice}
          action={
            checkAndFocus && {
              label: "Check whether it saved",
              onClick: checkAndFocus,
            }
          }
          focus={sent.current}
          details={details}
        />
      );
    default: {
      // Recorded, or re-read after a save: confirmed until the operator edits again.
      if (draft.phase === "recorded" || draft.savedAt !== null)
        return success === null ? null : (
          <ActionOutcome
            tone="success"
            message={success ?? outcomeCopy.saved}
            focus={answersCheck}
            details={details}
          >
            {children}
          </ActionOutcome>
        );
      // Otherwise only the note left by loading the latest version.
      return draft.notice ? (
        <ActionOutcome tone="success" message={draft.notice} />
      ) : null;
    }
  }
}

export function DraftOutcome({
  draft,
  client,
  session,
  label,
  saveDisabled = false,
  hold,
  discard,
  refresh,
  review,
  success,
  children,
}: {
  draft: ConfigurationDraft;
  client: OperatorClient;
  session: Session;
  label: string;
  /** Save stays disabled until the change list is non-empty. */
  saveDisabled?: boolean;
  /**
   * Why Save waits: an edit of private text cannot be sent until the saved text has been
   * read again to compare with it. Save stays focusable (`aria-disabled`) and the reason is
   * shown and announced.
   */
  hold?: string | undefined;
  /** Restores the loaded values; shown while there is unsaved input. */
  discard?: () => void;
  /**
   * Re-read what this form saved. Called when a check settles the outcome as recorded or
   * as changed elsewhere, exactly as `submitDraft` does for a direct save, because the
   * form unlocks and the message resolves from that re-read.
   */
  refresh: () => void;
  /** Adopts the newer saved version; offered in the alert when one was saved elsewhere. */
  review?: (() => void) | undefined;
  /** A plain sentence for the success line, or `null` when the caller shows its own. */
  success?: string | null | undefined;
  /** More under the success line, passed to `DraftMessage`. */
  children?: ReactNode;
}) {
  const idle = draft.phase !== "unknown";
  const holdId = useId();
  const held = Boolean(hold) && idle && draft.phase !== "recorded";
  return (
    <>
      {idle && (
        <div className="settings-actions">
          <Button
            type="submit"
            disabled={
              draft.phase === "pending" ||
              draft.phase === "recorded" ||
              saveDisabled
            }
            aria-disabled={held || undefined}
            aria-describedby={held ? holdId : undefined}
            onClick={(e) => {
              if (held) e.preventDefault();
            }}
          >
            {draft.phase === "pending" ? "Saving…" : label}
          </Button>
          {discard &&
            draft.dirty &&
            draft.phase !== "pending" &&
            draft.phase !== "recorded" && (
              <Button type="button" variant="secondary" onClick={discard}>
                Discard changes
              </Button>
            )}
        </div>
      )}
      {held && (
        <p id={holdId} className="metadata muted" role="status">
          {hold}
        </p>
      )}
      <DraftMessage
        draft={draft}
        review={review}
        success={success}
        check={async () => {
          await draft.reconcile(client, session.csrfToken);
          if (draft.phase === "recorded" || draft.phase === "conflict")
            refresh();
        }}
      >
        {children}
      </DraftMessage>
    </>
  );
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
  /** Pre-submit field errors: when any is present nothing is sent. */
  errors: Record<string, string> = {},
  /** Save is on hold (see `DraftOutcome`): nothing is sent, however it was triggered. */
  held = false,
) {
  e.preventDefault();
  if (held) return;
  await sendDraft(
    e.currentTarget,
    d,
    client,
    session,
    command,
    refresh,
    errors,
  );
}
/** Send a draft's command from inside `scope`, which receives the focus when a field is rejected. */
export async function sendDraft(
  scope: ParentNode,
  d: ConfigurationDraft,
  client: OperatorClient,
  session: Session,
  command: unknown,
  refresh: () => void,
  errors: Record<string, string> = {},
) {
  if (Object.keys(errors).length) d.reject(errors);
  else await d.submit(client, command, session.csrfToken);
  if (d.phase === "recorded" || d.phase === "conflict") refresh();
  else if (d.phase === "rejected")
    // The fields are off until the commit that shows the rejection, so focus waits for it.
    d.afterRender(() =>
      scope.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus(),
    );
}
export const key = () => crypto.randomUUID();
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
