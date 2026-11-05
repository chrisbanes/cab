import { useCallback, useId, useRef, useState } from "react";
import {
  type ExecutionHarness,
  type ProfilePlugin,
  pluginToolLabels,
} from "../../src/core/execution-runtime.js";
import { installedPluginsSchema } from "../../src/operator/contracts.js";
import { Button, ResourceStatus, StatusBadge } from "./components.js";
import { useOperatorResource } from "./resource.js";
import { locked, type SettingsProps } from "./settings.js";
import type { ConfigurationDraft } from "./settings-state.js";
import {
  allSelected,
  entryErrors,
  entryLabel,
  entryUnavailable,
  filterSkills,
  type InstalledPlugin,
  installedStatusNotes,
  maxEnabledSkills,
  offeredPlugins,
  parseSkillsDraft,
  selectableSkills,
  skillsDraft,
  toggleShown,
  typedSkills,
  withEntry,
  withoutEntry,
} from "./skill-plugins.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "./ui/dialog.js";
import { Input } from "./ui/input.js";
import { NativeSelect } from "./ui/native-select.js";

/** What the skills dialog is editing; `index` is the entry it replaces, else it adds one. */
type Editing =
  | {
      kind: "installed";
      index?: number;
      plugin: InstalledPlugin;
      selected: string[];
      /** Saved skills the plugin no longer offers; saving the dialog drops them. */
      dropped?: string[];
      query: string;
    }
  | { kind: "local"; index?: number; path: string; skills: string };

/**
 * A profile's skill plugins as rows, with a select of the plugins installed in Claude Code
 * and Codex and a dialog to choose their skills; both runtimes load them.
 */
export function SkillFields({
  draft,
  harness,
  client,
  session,
}: {
  draft: ConfigurationDraft;
  harness: ExecutionHarness;
} & Pick<SettingsProps, "client" | "session">) {
  const loader = useCallback(
    (signal: AbortSignal) =>
      client.read(
        "/api/operator/installed-plugins",
        installedPluginsSchema,
        signal,
      ),
    [client],
  );
  const resource = useOperatorResource(
    `${session.csrfToken}:installed-plugins`,
    loader,
  );
  const listing = resource.state.data?.data;
  const skills = parseSkillsDraft(String(draft.values.skills ?? ""));
  const [choice, setChoice] = useState("");
  const [editing, setEditingState] = useState<Editing | null>(null);
  const [dialogError, setDialogError] = useState<string | null>(null);
  // The control that opened the dialog gets focus back when it closes.
  const opener = useRef<HTMLElement | null>(null);
  const localButton = useRef<HTMLButtonElement | null>(null);
  const setEditing = (next: Editing | null) => {
    if (next && !editing)
      opener.current =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
    setEditingState(next);
  };
  const selectId = useId();
  const disabled = locked(draft) || skills === null;
  const offered =
    listing && skills ? offeredPlugins(listing.plugins, harness, skills) : [];
  const set = (next: NonNullable<typeof skills>) =>
    draft.set("skills", skillsDraft(next));
  const editEntry = (entry: ProfilePlugin, index: number) => {
    if ("path" in entry) {
      setEditing({
        kind: "local",
        index,
        path: entry.path,
        skills: entry.skills.join(", "),
      });
      return;
    }
    const plugin = listing?.plugins.find((p) => p.plugin === entry.plugin);
    if (!plugin) return;
    const offered = selectableSkills(plugin, harness);
    setEditing({
      kind: "installed",
      index,
      plugin,
      selected: entry.skills.filter((name) => offered.includes(name)),
      dropped: entry.skills.filter((name) => !offered.includes(name)),
      query: "",
    });
  };
  return (
    <fieldset className="field body" aria-describedby={`${selectId}-help`}>
      <legend>Skill plugins</legend>
      <p id={`${selectId}-help`} className="metadata muted">
        Plugins installed in {pluginToolLabels.claude} or{" "}
        {pluginToolLabels.codex} for the service user, or a local plugin
        directory. Each turn loads the plugin as installed then.
      </p>
      {skills === null && (
        <span className="error-text" role="alert">
          The skill plugins in this draft are not valid. Discard changes to
          start again.
        </span>
      )}
      {skills && skills.plugins.length === 0 && (
        <p className="metadata muted">No skills enabled.</p>
      )}
      {skills && skills.plugins.length > 0 && (
        <ul className="skill-plugin-rows" aria-label="Enabled skill plugins">
          {skills.plugins.map((entry, index) => {
            const label = entryLabel(entry, listing?.plugins);
            const unavailable = entryUnavailable(entry, listing?.plugins);
            return (
              <li key={"path" in entry ? entry.path : entry.plugin}>
                <span className="body">{label}</span>{" "}
                <span className="metadata muted">
                  {entry.skills.length} skill
                  {entry.skills.length === 1 ? "" : "s"}
                </span>{" "}
                {unavailable && (
                  <StatusBadge tone="warning">Unavailable</StatusBadge>
                )}{" "}
                {(!unavailable || "path" in entry) && (
                  <Button
                    type="button"
                    variant="secondary"
                    // An installed plugin's skills come from the listing.
                    disabled={disabled || (!("path" in entry) && !listing)}
                    aria-label={`Edit skills of ${label}`}
                    onClick={() => editEntry(entry, index)}
                  >
                    Edit skills
                  </Button>
                )}{" "}
                <Button
                  type="button"
                  variant="secondary"
                  disabled={disabled}
                  aria-label={`Remove ${label}`}
                  onClick={() => set(withoutEntry(skills, index))}
                >
                  Remove
                </Button>
                {entryErrors(draft.errors, index, entry).map((message) => (
                  <span key={message} className="error-text" role="alert">
                    {message}
                  </span>
                ))}
              </li>
            );
          })}
        </ul>
      )}
      <ResourceStatus
        label="Installed plugins"
        state={resource.state}
        retry={resource.refresh}
      />
      {listing &&
        installedStatusNotes(listing.status).map((note) => (
          <p key={note} className="metadata muted">
            {note}
          </p>
        ))}
      <div className="skill-plugin-add">
        <label className="field body" htmlFor={selectId}>
          Installed plugin
          <NativeSelect
            id={selectId}
            aria-label="Installed plugin"
            value={choice}
            disabled={disabled || offered.length === 0}
            onChange={(e) => setChoice(e.target.value)}
          >
            <option value="">
              {offered.length === 0
                ? "No other installed plugins"
                : "Choose a plugin"}
            </option>
            {(["claude", "codex"] as const).map((tool) => {
              const plugins = offered.filter((p) => p.tool === tool);
              return plugins.length === 0 ? null : (
                <optgroup key={tool} label={pluginToolLabels[tool]}>
                  {plugins.map((p) => (
                    <option key={p.plugin} value={p.plugin}>
                      {p.name}
                    </option>
                  ))}
                </optgroup>
              );
            })}
          </NativeSelect>
        </label>
        <Button
          type="button"
          variant="secondary"
          disabled={disabled || !offered.some((p) => p.plugin === choice)}
          onClick={() => {
            const plugin = offered.find((p) => p.plugin === choice);
            if (plugin)
              setEditing({
                kind: "installed",
                plugin,
                selected: [],
                query: "",
              });
          }}
        >
          Add
        </Button>{" "}
        <Button
          ref={localButton}
          type="button"
          variant="secondary"
          disabled={disabled}
          onClick={() => setEditing({ kind: "local", path: "", skills: "" })}
        >
          Add local directory
        </Button>
      </div>
      <SkillDialog
        editing={editing}
        harness={harness}
        error={dialogError}
        opener={opener}
        fallbackFocus={() => {
          // The opener may be gone or disabled after an add: the select, else Add local directory.
          const select = document.getElementById(selectId);
          return select instanceof HTMLSelectElement && !select.disabled
            ? select
            : localButton.current;
        }}
        onChange={(next) => {
          setDialogError(null);
          setEditing(next);
        }}
        onDone={(entry, index) => {
          if (!skills) return;
          const next = withEntry(skills, entry, index);
          // A typed directory must be a valid entry; the server checks it exists on save.
          if (parseSkillsDraft(skillsDraft(next)) === null) {
            setDialogError(
              "Enter an absolute, normalised directory that is not already listed, and skill names of letters, digits, dots, dashes or underscores.",
            );
            return;
          }
          set(next);
          setEditing(null);
          setChoice("");
        }}
      />
    </fieldset>
  );
}

function SkillDialog({
  editing,
  harness,
  error,
  opener,
  fallbackFocus,
  onChange,
  onDone,
}: {
  editing: Editing | null;
  harness: ExecutionHarness;
  error: string | null;
  opener: { current: HTMLElement | null };
  fallbackFocus: () => HTMLElement | null;
  onChange: (editing: Editing | null) => void;
  onDone: (entry: ProfilePlugin, index?: number) => void;
}) {
  const filterId = useId(),
    countId = useId(),
    pathId = useId(),
    namesId = useId();
  const title =
    editing?.kind === "installed"
      ? `${editing.plugin.name} · ${pluginToolLabels[editing.plugin.tool]}`
      : "Local plugin directory";
  const names =
    editing?.kind === "installed"
      ? selectableSkills(editing.plugin, harness)
      : [];
  const shown =
    editing?.kind === "installed" ? filterSkills(names, editing.query) : [];
  const tooMany =
    editing?.kind === "installed" && editing.selected.length > maxEnabledSkills;
  const localSkills =
    editing?.kind === "local" ? typedSkills(editing.skills) : [];
  const ready =
    editing?.kind === "installed"
      ? editing.selected.length > 0 && !tooMany
      : editing?.kind === "local"
        ? editing.path.trim() !== "" &&
          localSkills.length > 0 &&
          localSkills.length <= maxEnabledSkills
        : false;
  return (
    <Dialog
      open={editing !== null}
      onOpenChange={(open) => {
        if (!open) onChange(null);
      }}
    >
      <DialogContent
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          const target = opener.current;
          if (
            target?.isConnected &&
            !(target instanceof HTMLButtonElement && target.disabled)
          )
            target.focus();
          else fallbackFocus()?.focus();
        }}
      >
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>
          {editing?.kind === "installed"
            ? `Choose up to ${maxEnabledSkills} skills to enable.`
            : "The plugin's absolute directory on the service host and the skills to enable, separated by commas. Both are checked when you save."}
        </DialogDescription>
        {editing?.kind === "installed" && (
          <>
            <label className="field body" htmlFor={filterId}>
              Filter skills
              <Input
                id={filterId}
                aria-label="Filter skills"
                value={editing.query}
                onChange={(e) =>
                  onChange({ ...editing, query: e.target.value })
                }
              />
            </label>
            <div className="settings-row-heading">
              <span id={countId} className="metadata muted">
                {editing.selected.length} of {names.length} selected
              </span>
              {shown.length > 0 && (
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() =>
                    onChange({
                      ...editing,
                      selected: toggleShown(names, shown, editing.selected),
                    })
                  }
                >
                  {allSelected(shown, editing.selected)
                    ? "Clear selection"
                    : "Select all"}
                </Button>
              )}
            </div>
            <fieldset
              className="skill-plugin-choices"
              aria-labelledby={countId}
            >
              {shown.map((name) => (
                <label
                  key={name}
                  className="metadata check-field"
                  htmlFor={`${countId}-${name}`}
                >
                  <Input
                    id={`${countId}-${name}`}
                    type="checkbox"
                    className="native-check size-5 shrink-0 p-0 accent-foreground"
                    checked={editing.selected.includes(name)}
                    onChange={(e) =>
                      onChange({
                        ...editing,
                        selected: e.target.checked
                          ? [...editing.selected, name]
                          : editing.selected.filter((s) => s !== name),
                      })
                    }
                  />
                  {name}
                </label>
              ))}
              {shown.length === 0 && (
                <p className="metadata muted">No skill matches the filter.</p>
              )}
            </fieldset>
            {editing.dropped && editing.dropped.length > 0 && (
              <p className="metadata" role="status">
                Not offered by the plugin now, removed when you update:{" "}
                {editing.dropped.join(", ")}.
                {editing.selected.length === 0 &&
                  " Select a skill, or remove the plugin."}
              </p>
            )}
            {tooMany && (
              <span className="error-text" role="alert">
                A profile can enable at most {maxEnabledSkills} skills of one
                plugin.
              </span>
            )}
          </>
        )}
        {editing?.kind === "local" && (
          <>
            <label className="field body" htmlFor={pathId}>
              Plugin directory
              <Input
                id={pathId}
                aria-label="Plugin directory"
                value={editing.path}
                onChange={(e) => onChange({ ...editing, path: e.target.value })}
              />
            </label>
            <label className="field body" htmlFor={namesId}>
              Skills
              <Input
                id={namesId}
                aria-label="Skills"
                value={editing.skills}
                onChange={(e) =>
                  onChange({ ...editing, skills: e.target.value })
                }
              />
            </label>
          </>
        )}
        {error && (
          <span className="error-text" role="alert">
            {error}
          </span>
        )}
        <div>
          <Button
            type="button"
            variant="secondary"
            onClick={() => onChange(null)}
          >
            Cancel
          </Button>{" "}
          <Button
            type="button"
            disabled={!ready}
            onClick={() => {
              if (editing?.kind === "installed")
                onDone(
                  {
                    plugin: editing.plugin.plugin,
                    skills: editing.selected,
                  },
                  editing.index,
                );
              else if (editing?.kind === "local")
                onDone(
                  { path: editing.path.trim(), skills: localSkills },
                  editing.index,
                );
            }}
          >
            {editing?.index === undefined ? "Add plugin" : "Update skills"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
