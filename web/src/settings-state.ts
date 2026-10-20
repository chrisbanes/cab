import type { z } from "zod";
import {
  type CommandReceipt,
  type OperatorCommand,
  operatorCommandSchema,
} from "../../src/operator/contracts.js";
import type { OperatorClient } from "./api.js";
import { CommandLifecycle } from "./command-lifecycle.js";
import type { ReceiptDetails } from "./outcome-copy.js";
import { sameText } from "./settings-changes.js";
import { sourceCredentialCopy } from "./settings-view.js";
/** The plain outcome copy of a configuration save. Details, not these lines, carry the codes. */
export const outcomeCopy = {
  saved: "Saved.",
  /** The title above `fields` when the save was refused for highlighted fields. */
  fieldsTitle: "Couldn't save.",
  fields: (count: number) =>
    `Fix the ${count > 1 ? `${count} highlighted fields` : "highlighted field"}. Your changes are still here.`,
  tooLarge:
    "Couldn't save: the change is too large. Your changes are still here.",
  rejected: "Couldn't save. Your changes are still here.",
  conflict: "A newer version was saved elsewhere.",
  unknown: "We couldn't confirm the save.",
  adopted: "Loaded the latest version. Your changes are still here.",
};

/** The resource a command names, or null for installation-wide commands. */
function commandResource(c: OperatorCommand) {
  return "profileId" in c
    ? c.profileId
    : "taskId" in c
      ? c.taskId
      : "projectId" in c
        ? c.projectId
        : null;
}

function matchesConfigurationReceipt(c: OperatorCommand, r: CommandReceipt) {
  if (r.key !== c.key || r.kind !== "configuration") return false;
  const result = r.result;
  if (result.commandType !== c.type) return false;
  if (c.type === "capacity.configure") {
    if (
      result.commandType !== "capacity.configure" ||
      result.resourceId !== "system:capacity" ||
      result.globalLimit !== c.globalLimit
    )
      return false;
    return Object.entries(c.projectOverrides).every(([id, limit]) =>
      limit === null
        ? !(id in result.projectOverrides)
        : result.projectOverrides[id] === limit,
    );
  }
  if (c.type === "discovery.configure")
    return (
      result.commandType === "discovery.configure" &&
      result.configured === (c.credentialRef !== null)
    );
  if (c.type === "claude-token.configure")
    return (
      result.commandType === "claude-token.configure" &&
      result.configured === (c.credentialRef !== null)
    );
  if (c.type === "getting-started.configure")
    return (
      result.commandType === "getting-started.configure" &&
      result.dismissed === c.dismissed
    );
  if (result.resourceId !== commandResource(c)) return false;
  if (
    c.type === "github.place" &&
    (result.commandType !== "github.place" ||
      result.projectId !== c.chosenProjectId)
  )
    return false;
  if (c.type === "github.preview")
    return (
      result.commandType === "github.preview" &&
      result.configVersion === c.expectedVersion &&
      result.selectionId === c.selectionId &&
      result.active
    );
  if (!("version" in result)) return false;
  if (c.type === "project.create" || c.type === "profile.create")
    return result.version === 1;
  return "expectedVersion" in c && result.version === c.expectedVersion + 1;
}

/** A UUID record key, such as a project override, kept so the error names its own field. */
const uuidSegment =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const namedLengths = new Set([
  "name",
  "summary",
  "instructions",
  "capabilities",
  "guidance",
]);
/**
 * The fix a schema issue asks for under its field (frames 156 and 167–169). Fields
 * without drawn copy keep the generic line.
 */
function fieldFix(issue: z.core.$ZodIssue, input: unknown) {
  const [field] = issue.path,
    command = (input ?? {}) as Record<PropertyKey, unknown>;
  if (field === "globalLimit" || field === "projectOverrides")
    return "Enter a whole number of 1 or more.";
  if (issue.path.length !== 1 || typeof field !== "string")
    return "Check this field.";
  const noun = String(command.type).split(".")[0],
    value = command[field];
  if (field === "credentialRef" && command.type === "routing.configure")
    return "Use env: followed by a capital letter, then capital letters, digits or underscores, such as env:TYPESAFE_API_KEY.";
  if (
    field === "name" &&
    issue.code === "too_small" &&
    (noun === "profile" || noun === "project")
  )
    return `Enter a ${noun} name.`;
  if (
    namedLengths.has(field) &&
    issue.code === "too_big" &&
    typeof value === "string"
  )
    return `Keep the ${field} to ${issue.maximum} characters or fewer. It has ${value.length}.`;
  return "Check this field.";
}

/** Fields that change with every operation and are not input. */
const housekeeping = (field: string) =>
  field === "key" || field === "expectedVersion";
/** Draft fields that hold JSON rows; their per-render `rowKey` and property order are not input. */
const jsonFields = new Set([
  "selections",
  "repositories",
  "conditions",
  "rows",
]);
/** A field only counts while the field that controls it is on (hidden residue is not input). */
const noRows = (value: unknown) => {
  try {
    const rows: unknown = JSON.parse(String(value ?? "[]"));
    return Array.isArray(rows) && rows.length === 0;
  } catch {
    return false;
  }
};
const inactive = (
  field: string,
  values: Record<string, string | boolean | string[]>,
) =>
  (field === "credentialRef" && values.referenceMode !== "set") ||
  // A project's cap counts only while its override is on.
  (field.startsWith("limit-") && !values[`override-${field.slice(6)}`]) ||
  // Matching applies to conditions; with none there is nothing to match.
  (field === "mode" && "conditions" in values && noRows(values.conditions));
/**
 * A comparable form of a draft value: lists of ids are sets, whole-number limits compare as
 * numbers, JSON rows ignore `rowKey` and property order, and all other text is exact.
 */
function canonical(field: string, value: unknown): string {
  if (Array.isArray(value)) return JSON.stringify([...value].sort());
  if (typeof value !== "string") return JSON.stringify(value ?? null);
  if (jsonFields.has(field))
    try {
      return JSON.stringify(
        JSON.parse(value, (k, v: unknown) =>
          k === "rowKey"
            ? undefined
            : v && typeof v === "object" && !Array.isArray(v)
              ? Object.fromEntries(
                  Object.entries(v as object).sort(([x], [y]) =>
                    x < y ? -1 : 1,
                  ),
                )
              : v,
        ),
      );
    } catch {
      return `s:${value}`;
    }
  if (
    (field === "globalLimit" || field.startsWith("limit-")) &&
    /^\d+$/.test(value)
  )
    return `n:${Number(value)}`;
  return `s:${value}`;
}

export class ConfigurationDraft {
  values: Record<string, string | boolean | string[]> = {};
  phase:
    | "editing"
    | "pending"
    | "recorded"
    | "rejected"
    | "conflict"
    | "unknown" = "editing";
  notice = "";
  /** Set while the last save is confirmed; the next edit or new operation clears it. */
  savedAt: number | null = null;
  details: ReceiptDetails = {};
  /** A source credential refusal is a failure to fix, not a newer version to review. */
  credentialRefusal = false;
  errors: Record<string, string> = {};
  private readonly lifecycle = new CommandLifecycle<OperatorCommand>();
  get frozen() {
    return this.lifecycle.frozen;
  }
  get bytes() {
    return this.lifecycle.bytes;
  }
  get receipt() {
    return this.lifecycle.receipt;
  }
  private generation = 0;
  /** Counts announced changes, so a caller can wait for the commit that shows them. */
  revision = 0;
  private shown = 0;
  private afterCommit: (() => void)[] = [];
  constructor(
    private render: () => void = () => {},
    private onSaved: (receipt: CommandReceipt) => void = () => {},
  ) {}
  bind(render: () => void) {
    this.render = render;
  }
  private changed = () => {
    this.revision++;
    this.render();
  };
  /** The page committed a render that shows every change up to `revision`. */
  committed(revision: number) {
    this.shown = Math.max(this.shown, revision);
    if (this.shown < this.revision) return;
    for (const run of this.afterCommit.splice(0)) run();
  }
  /** Run `run` once the page has committed every change announced so far. */
  afterRender(run: () => void) {
    if (this.shown >= this.revision) run();
    else this.afterCommit.push(run);
  }
  /** Drop field errors under a path prefix once the input they named has changed. */
  clearErrors(prefix: string) {
    this.errors = Object.fromEntries(
      Object.entries(this.errors).filter(
        ([field]) => !field.startsWith(prefix),
      ),
    );
  }
  set(field: string, value: string | boolean | string[]) {
    if (
      this.phase === "pending" ||
      this.phase === "recorded" ||
      this.lifecycle.uncertain
    )
      return false;
    // Model names belong to one runtime, so a runtime switch starts from its defaults.
    const switched =
      field === "runtimeHarness" && this.values.runtimeHarness !== value;
    this.values = {
      ...this.values,
      [field]: value,
      ...(switched ? { runtimeModel: "", runtimeEffort: "" } : {}),
    };
    this.savedAt = null;
    this.changed();
    return true;
  }
  /**
   * Record an edit of a private text together with the text it was edited against
   * (`<field>Base`). Typing the baseline back removes the edit, so a field holds a string
   * only while it really differs, and that survives leaving and returning to the page.
   */
  setPrivate(
    field: string,
    value: string,
    baseline: string,
    /** The saved text now, when it was read again and may differ from the baseline. */
    current?: string,
  ) {
    if (
      this.phase === "pending" ||
      this.phase === "recorded" ||
      this.lifecycle.uncertain
    )
      return false;
    const { [field]: _value, [`${field}Base`]: _base, ...rest } = this.values;
    this.values = sameText(value, current ?? baseline)
      ? rest
      : { ...rest, [field]: value, [`${field}Base`]: baseline };
    this.savedAt = null;
    this.changed();
    return true;
  }
  /** The loaded values the current input started from; adoption compares against it. */
  private base: Record<string, string | boolean | string[]> = {};
  /**
   * Whether any field differs from the loaded values it started from. Derived from the
   * contents every time, never stored: an edit that is reverted leaves the form clean, so a
   * later read is picked up and Discard is offered only while something differs.
   */
  get dirty() {
    for (const field of new Set([
      ...Object.keys(this.values),
      ...Object.keys(this.base),
    ]))
      if (
        !housekeeping(field) &&
        canonical(
          field,
          inactive(field, this.values) ? undefined : this.values[field],
        ) !==
          canonical(
            field,
            inactive(field, this.base) ? undefined : this.base[field],
          )
      )
        return true;
    return false;
  }
  initialize(
    values: Record<string, string | boolean | string[]>,
    /** The input a refused or conflicting save was about was undone, so its outcome goes too. */
    undone = false,
  ) {
    if (!this.dirty && !this.frozen) {
      // A read at another version was saved by someone else, so the confirmation of this
      // session's save no longer describes what the page now shows.
      if (
        this.savedAt !== null &&
        values.expectedVersion !== this.base.expectedVersion
      ) {
        this.savedAt = null;
        this.details = {};
      }
      // A refused or conflicting save belongs to input that is gone now.
      if (undone && (this.phase === "rejected" || this.phase === "conflict")) {
        this.generation++;
        this.lifecycle.reset();
        this.phase = "editing";
        this.errors = {};
        this.notice = "";
        this.details = {};
        this.credentialRefusal = false;
      }
      // The note that the latest version was loaded described input that is gone now.
      if (undone && this.notice === outcomeCopy.adopted) this.notice = "";
      this.values = { ...values };
      this.base = { ...values };
      this.changed();
    }
  }
  /**
   * Adopt a newer loaded revision: fields the operator has not changed since loading take
   * the latest values, edited fields keep the input, and the version moves forward.
   */
  adoptLatest(
    version: number,
    latest: Record<string, string | boolean | string[]>,
    /** Fields adopted as one unit: all take the latest only when none was edited. */
    groups: string[][] = [],
  ) {
    if (this.phase === "pending" || this.lifecycle.uncertain) return;
    const untouched = (field: string) =>
      canonical(field, this.values[field]) ===
      canonical(field, this.base[field]);
    const values = { ...this.values };
    for (const [field, value] of Object.entries(latest)) {
      const unit = groups.find((g) => g.includes(field)) ?? [field];
      if (unit.every(untouched)) values[field] = value;
    }
    this.values = values;
    this.base = { ...latest };
    this.adoptVersion(version);
  }
  adoptVersion(version: number) {
    if (this.phase === "pending" || this.lifecycle.uncertain) return;
    this.generation++;
    this.lifecycle.reset();
    this.phase = "editing";
    this.savedAt = null;
    this.details = {};
    this.credentialRefusal = false;
    this.notice = outcomeCopy.adopted;
    this.values = {
      ...this.values,
      expectedVersion: String(version),
      key: crypto.randomUUID(),
    };
    this.changed();
  }
  /**
   * Begin a new operation from `values`. A re-read after a save keeps that save's
   * confirmation (`keepSaved`) only when it loaded the version the save produced; if
   * another writer committed first the page shows their version, so the confirmation is
   * dropped. Saves without a version (capacity, credential references) cannot tell.
   * Any other new operation starts without a confirmation.
   */
  startOperation(
    values: Record<string, string | boolean | string[]>,
    keepSaved = false,
  ) {
    if (this.phase === "pending" || this.lifecycle.uncertain) return;
    const { savedAt, details } = this;
    this.purge();
    this.initialize(values);
    if (
      keepSaved &&
      (details.version === undefined ||
        String(details.version) === values.expectedVersion)
    ) {
      this.savedAt = savedAt;
      this.details = details;
    }
  }
  purge() {
    this.generation++;
    this.values = {};
    this.base = {};
    this.lifecycle.reset();
    this.errors = {};
    this.phase = "editing";
    this.notice = "";
    this.savedAt = null;
    this.details = {};
    this.credentialRefusal = false;
    this.changed();
  }
  /** Reject before sending: field errors keyed by command path, as after a rejected send. */
  reject(errors: Record<string, string>) {
    if (
      this.phase === "pending" ||
      this.phase === "recorded" ||
      this.lifecycle.uncertain
    )
      return;
    this.errors = errors;
    this.phase = "rejected";
    this.notice = outcomeCopy.fields(Object.keys(errors).length);
    this.details = { code: "invalid-input" };
    this.credentialRefusal = false;
    this.changed();
  }
  async submit(client: OperatorClient, input: unknown, csrf: string) {
    if (
      this.phase === "pending" ||
      this.phase === "recorded" ||
      this.lifecycle.uncertain
    )
      return;
    const parsed = operatorCommandSchema.safeParse(input);
    if (!parsed.success) {
      this.errors = {};
      for (const issue of parsed.error.issues) {
        const path = issue.path
          .filter(
            (p) =>
              (typeof p === "string" &&
                (/^[A-Za-z][A-Za-z0-9]*$/.test(p) || uuidSegment.test(p))) ||
              (typeof p === "number" && Number.isSafeInteger(p) && p >= 0),
          )
          .join(".");
        // The first issue on a field is the one it shows.
        this.errors[path] ??= fieldFix(issue, input);
      }
      this.phase = "rejected";
      this.notice = outcomeCopy.fields(Object.keys(this.errors).length);
      this.details = { code: "invalid-input" };
      this.credentialRefusal = false;
      this.changed();
      return;
    }
    const bytes = JSON.stringify(parsed.data);
    if (new TextEncoder().encode(bytes).length > 65536) {
      this.errors = {};
      this.notice = outcomeCopy.tooLarge;
      this.phase = "rejected";
      this.details = { code: "request-too-large" };
      this.credentialRefusal = false;
      this.changed();
      return;
    }
    if (!this.lifecycle.freeze(parsed.data)) return;
    this.errors = {};
    await this.send(client, csrf);
  }
  async reconcile(client: OperatorClient, csrf: string) {
    if (this.phase !== "unknown" || !this.frozen) return;
    await this.send(client, csrf);
  }
  private async send(client: OperatorClient, csrf: string) {
    const c = this.lifecycle.begin();
    if (!c) return;
    const generation = this.generation;
    this.phase = "pending";
    this.savedAt = null;
    this.changed();
    const result = await client.command(c, csrf);
    if (generation !== this.generation) return;
    const disposition = this.lifecycle.settle(
      result,
      matchesConfigurationReceipt,
    );
    const receipt =
      this.receipt?.kind === "configuration" ? this.receipt : null;
    this.credentialRefusal = false;
    this.details = {
      command: c.type,
      requestKey: c.key,
      resource: receipt?.result.resourceId ?? commandResource(c) ?? undefined,
      ...(receipt
        ? {
            version:
              "version" in receipt.result
                ? receipt.result.version
                : "configVersion" in receipt.result
                  ? receipt.result.configVersion
                  : undefined,
          }
        : {}),
      ...(result.state === "recorded" ? {} : { code: result.code }),
    };
    if (disposition === "recorded") {
      this.phase = "recorded";
      if (this.receipt) this.onSaved(this.receipt);
      this.savedAt = Date.now();
      this.notice = outcomeCopy.saved;
    } else if (disposition === "unknown") {
      this.phase = "unknown";
      this.notice = outcomeCopy.unknown;
    } else {
      this.phase = disposition;
      const fieldPaths =
        result.state === "recorded" ? [] : (result.fieldPaths ?? []);
      // The service names the project that already has this name; the form shows it as is.
      const nameTaken =
        result.state !== "recorded" &&
        (c.type === "project.create" || c.type === "project.configure") &&
        result.code === "invalid-input" &&
        fieldPaths.length === 1 &&
        fieldPaths[0] === "name"
          ? result.message
          : undefined;
      this.errors = Object.fromEntries(
        fieldPaths.map((p) => [p, nameTaken ?? "Check this field."]),
      );
      this.credentialRefusal =
        result.state !== "recorded" &&
        Boolean(result.credentialReason) &&
        (c.type === "github.preview" || c.type === "github.configure");
      this.notice =
        result.state !== "recorded" && this.credentialRefusal
          ? `${sourceCredentialCopy(result.credentialReason)} Your changes are still here.`
          : disposition === "conflict"
            ? outcomeCopy.conflict
            : Object.keys(this.errors).length
              ? outcomeCopy.fields(Object.keys(this.errors).length)
              : outcomeCopy.rejected;
    }
    this.changed();
  }
}
/** A save this browser session recorded: its original receipt and when it settled. */
export interface SavedRecord {
  at: number;
  receipt: CommandReceipt;
}
export class ConfigurationDrafts {
  private drafts = new Map<string, ConfigurationDraft>();
  private savedRecords = new Map<string, SavedRecord>();
  saved(key: string) {
    return this.savedRecords.get(key);
  }
  unsettledPlacements(projectId: string) {
    return [...this.drafts.values()].flatMap((draft) =>
      draft.frozen?.type === "github.place" &&
      (draft.values.placementOriginProjectId ?? draft.frozen.projectId) ===
        projectId &&
      (draft.phase === "pending" || draft.phase === "unknown")
        ? [draft.frozen]
        : [],
    );
  }
  /**
   * Placements this session recorded from `projectId`. The conflict row disappears once a
   * placement is recorded, so the page shows the confirmation from the draft instead.
   */
  recordedPlacements(projectId: string) {
    return [...this.drafts.values()].filter(
      (draft) =>
        draft.phase === "recorded" &&
        draft.frozen?.type === "github.place" &&
        (draft.values.placementOriginProjectId ?? draft.frozen.projectId) ===
          projectId &&
        draft.receipt?.kind === "configuration" &&
        draft.receipt.result.commandType === "github.place",
    );
  }
  get(key: string, render: () => void) {
    let draft = this.drafts.get(key);
    if (!draft) {
      draft = new ConfigurationDraft(render, (receipt) =>
        this.savedRecords.set(key, { at: Date.now(), receipt }),
      );
      this.drafts.set(key, draft);
    }
    draft.bind(render);
    return draft;
  }
  purge() {
    for (const draft of this.drafts.values()) draft.purge();
    this.drafts.clear();
    this.savedRecords.clear();
  }
}
