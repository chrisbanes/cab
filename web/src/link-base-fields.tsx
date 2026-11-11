import type { RepositoryBaseMode } from "../../src/core/github-source-contracts.js";
import { Input } from "./ui/input.js";
import { NativeSelect } from "./ui/native-select.js";

/** A repository link's base: where a new workspace starts, and whether cab fetches it first. */
export interface LinkBase {
  baseMode?: RepositoryBaseMode | undefined;
  fetchBeforeProvisioning?: boolean | undefined;
}

/** The Base choice and the fetch toggle, which an explicit ref disables. */
export function LinkBaseFields(p: {
  id: string;
  value: LinkBase;
  disabled?: boolean;
  onChange: (value: {
    baseMode: RepositoryBaseMode;
    fetchBeforeProvisioning: boolean;
  }) => void;
}) {
  const baseMode = p.value.baseMode ?? "ref";
  const fetch = p.value.fetchBeforeProvisioning === true;
  return (
    <>
      <label className="field body" htmlFor={`${p.id}-baseMode`}>
        Base
        <NativeSelect
          className="control"
          id={`${p.id}-baseMode`}
          aria-label="Base"
          value={baseMode}
          disabled={p.disabled}
          onChange={(e) => {
            const next = e.target.value as RepositoryBaseMode;
            // An explicit ref names no branch to fetch.
            p.onChange({
              baseMode: next,
              fetchBeforeProvisioning: next === "ref" ? false : fetch,
            });
          }}
        >
          <option value="ref">Explicit Git ref</option>
          <option value="remote-branch">Remote branch (Ref names it)</option>
          <option value="remote-default">Remote default branch</option>
        </NativeSelect>
      </label>
      <label className="check-field body" htmlFor={`${p.id}-fetch`}>
        <Input
          id={`${p.id}-fetch`}
          type="checkbox"
          className="native-check size-5 shrink-0 p-0 accent-foreground"
          checked={fetch}
          disabled={p.disabled || baseMode === "ref"}
          onChange={(e) =>
            p.onChange({ baseMode, fetchBeforeProvisioning: e.target.checked })
          }
        />
        Fetch latest before creating workspace
      </label>
    </>
  );
}
