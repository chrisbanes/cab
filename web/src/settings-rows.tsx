import { useEffect } from "react";
import { Button } from "./components.js";
import { parseRows, type SourceRow } from "./settings-changes.js";
import type { ConfigurationDraft } from "./settings-state.js";
import { key } from "./settings.js";
import { Input } from "./ui/input.js";

export const withKeys = (rows: object[]) =>
  JSON.stringify(rows.map((r) => ({ ...r, rowKey: key() })));

/** The row-editing pieces Settings tabs share: JSON-encoded rows held in a draft field. */
export function useSettingsRows(o: {
  draft: ConfigurationDraft;
  /** The session-only read of saved private values, and whether any read has returned. */
  priv: {
    state: { pending: boolean; error: unknown };
    refresh: () => void;
  };
  privateRead: boolean;
  controlId: (field: string, index: number, name: string) => string;
  errorId: (field: string) => string;
  /** The field's path in service errors, when it differs from the draft field. */
  errorPath?: (field: string) => string;
  /** The row key that names a row in Try again labels. */
  rowName: string;
  onRows?: (rows: SourceRow[]) => void;
}) {
  const { draft: d, priv } = o;
  const setRows = (field: string, rows: SourceRow[]) => {
    d.set(field, JSON.stringify(rows));
    o.onRows?.(rows);
  };
  const update = (
    field: string,
    index: number,
    patch: SourceRow | undefined,
    /** The row without the patch's keys, when the patch is undefined (an edit reverted). */
    reverted?: SourceRow,
  ) => {
    const rows = parseRows(d.values[field]);
    rows[index] = patch ? { ...rows[index], ...patch } : (reverted ?? {});
    setRows(field, rows);
  };
  /** Undoing a removal drops the marker, so the row reads exactly as it was loaded. */
  const toggleRemoved = (field: string, index: number) => {
    const rows = parseRows(d.values[field]);
    const { removed, ...rest } = rows[index] ?? {};
    rows[index] = removed ? rest : { ...rest, removed: true };
    setRows(field, rows);
  };
  const drop = (field: string, index: number) =>
    setRows(
      field,
      parseRows(d.values[field]).filter((_, i) => i !== index),
    );
  const add = (field: string, row: SourceRow) =>
    setRows(field, [...parseRows(d.values[field]), { ...row, rowKey: key() }]);
  const rowError = (field: string, index: number, name: string) => {
    const path = o.errorPath?.(field) ?? field;
    return (
      d.errors[path] ||
      d.errors[`${path}.${index}.${name}`] ||
      d.errors[`${path}.${name}`]
    );
  };
  const input = (
    field: string,
    index: number,
    name: string,
    label: string,
    /** What shows until the operator edits the field. */
    fallback = "",
    /** Replaces the plain row update, for a saved value that tracks its baseline. */
    change?: (value: string) => void,
  ) => (
    <label className="field body" htmlFor={o.controlId(field, index, name)}>
      {label}
      <Input
        className="control"
        id={o.controlId(field, index, name)}
        aria-label={label}
        aria-invalid={Boolean(rowError(field, index, name))}
        aria-describedby={
          rowError(field, index, name) ? o.errorId(field) : undefined
        }
        value={String(parseRows(d.values[field])[index]?.[name] ?? fallback)}
        onChange={(e) =>
          change
            ? change(e.target.value)
            : update(field, index, { [name]: e.target.value })
        }
      />
    </label>
  );
  /** A saved private value, editable once read; otherwise unavailable with a way to read it again. */
  const savedValue = (
    field: string,
    index: number,
    name: string,
    label: string,
    unavailable: string,
    baseline: string | undefined,
  ) => {
    const row = parseRows(d.values[field])[index];
    const edited = typeof row?.[name] === "string";
    // The text an edit started from; typing it back removes the edit, so the row is kept again.
    const base = edited ? String(row?.[`${name}Base`] ?? "") : baseline;
    const id = String(row?.[o.rowName] ?? "");
    if (baseline !== undefined || edited)
      return (
        <>
          {input(field, index, name, label, baseline ?? "", (value) => {
            const {
              [name]: _value,
              [`${name}Base`]: _base,
              ...rest
            } = row ?? {};
            update(
              field,
              index,
              value === (baseline ?? base ?? "")
                ? undefined
                : { [name]: value, [`${name}Base`]: base ?? "" },
              rest,
            );
          })}
          {edited && baseline !== undefined && baseline !== base && (
            <p className="metadata muted" role="status">
              This was changed elsewhere since you started editing. Saving
              replaces it.
            </p>
          )}
          {edited &&
            baseline === undefined &&
            !priv.state.pending &&
            (priv.state.error !== null || o.privateRead) && (
              <p className="body error-text" role="alert">
                Couldn't check whether this changed elsewhere.{" "}
                <Button
                  type="button"
                  variant="secondary"
                  aria-label={`Try again to check the ${label.toLowerCase()} for ${id}`}
                  onClick={priv.refresh}
                >
                  Try again
                </Button>
              </p>
            )}
        </>
      );
    return (
      <div className="field body">
        <span>{label}</span>
        <p className="metadata muted">
          {priv.state.pending ? `Loading ${label.toLowerCase()}…` : unavailable}
        </p>
        <div>
          <Button
            type="button"
            variant="secondary"
            aria-label={`Try again to load the ${label.toLowerCase()} for ${id}`}
            aria-busy={priv.state.pending || undefined}
            aria-disabled={priv.state.pending || undefined}
            onClick={() => {
              if (!priv.state.pending) priv.refresh();
            }}
          >
            Try again
          </Button>
        </div>
      </div>
    );
  };
  return {
    setRows,
    update,
    toggleRemoved,
    drop,
    add,
    rowError,
    input,
    savedValue,
  };
}

/**
 * An edit that now equals the saved value (another writer saved the same) is no edit: drop it
 * so the form is clean and later reads apply. Returns whether any row matched.
 */
export function useDropMatchedEdits(
  d: ConfigurationDraft,
  field: string,
  name: string,
  equalsSaved: (row: SourceRow) => unknown,
  /** The saved read the comparison depends on. */
  read: unknown,
) {
  const rows = parseRows(d.values[field]);
  const matchedSaved =
    (d.phase === "editing" ||
      d.phase === "conflict" ||
      d.phase === "rejected") &&
    rows.some(equalsSaved);
  // biome-ignore lint/correctness/useExhaustiveDependencies: act when a read makes an edit equal.
  useEffect(() => {
    if (!matchedSaved) return;
    d.set(
      field,
      JSON.stringify(
        rows.map((r) => {
          if (!equalsSaved(r)) return r;
          const { [name]: _v, [`${name}Base`]: _b, ...rest } = r;
          return rest;
        }),
      ),
    );
  }, [matchedSaved, read]);
}
