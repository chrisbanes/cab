import {
  operatorCommandSchema,
  type OperatorCommand,
  type CommandReceipt,
} from "../../src/operator/contracts.js";
import type { OperatorClient } from "./api.js";
import { sourceCredentialCopy } from "./settings-view.js";
import { CommandLifecycle } from "./command-lifecycle.js";
/** The plain outcome copy of a configuration save. Details, not these lines, carry the codes. */
export const outcomeCopy = {
  saved: "Saved.",
  fields:
    "Couldn't save: check the highlighted fields. Your changes are still here.",
  tooLarge:
    "Couldn't save: the change is too large. Your changes are still here.",
  rejected: "Couldn't save. Your changes are still here.",
  conflict: "A newer version was saved elsewhere.",
  unknown: "We couldn't confirm the save.",
  adopted: "Loaded the latest version. Your changes are still here.",
};

/** The receipt fields behind an outcome, shown only in its collapsed Details. */
export interface DraftDetails {
  command?: string | undefined;
  resource?: string | undefined;
  version?: number | undefined;
  requestKey?: string | undefined;
  code?: string | undefined;
}

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

export class ConfigurationDraft {
  values: Record<string, string | boolean | string[]> = {};
  phase:
    | "editing"
    | "pending"
    | "recorded"
    | "rejected"
    | "conflict"
    | "unknown" = "editing";
  dirty = false;
  notice = "";
  /** Set while the last save is confirmed; the next edit or new operation clears it. */
  savedAt: number | null = null;
  details: DraftDetails = {};
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
  constructor(
    private changed: () => void = () => {},
    private onSaved: (receipt: CommandReceipt) => void = () => {},
  ) {}
  bind(changed: () => void) {
    this.changed = changed;
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
    this.values = { ...this.values, [field]: value };
    this.dirty = true;
    this.savedAt = null;
    this.changed();
    return true;
  }
  /** The loaded values the current input started from; adoption compares against it. */
  private base: Record<string, string | boolean | string[]> = {};
  initialize(values: Record<string, string | boolean | string[]>) {
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
    // Lists are sets here (candidate ids), so order alone is not an edit.
    const norm = (x: unknown) =>
      JSON.stringify(Array.isArray(x) ? [...x].sort() : x);
    const untouched = (field: string) =>
      norm(this.values[field]) === norm(this.base[field]);
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
    this.dirty = false;
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
    this.notice = outcomeCopy.fields;
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
              (typeof p === "string" && /^[A-Za-z][A-Za-z0-9]*$/.test(p)) ||
              (typeof p === "number" && Number.isSafeInteger(p) && p >= 0),
          )
          .join(".");
        this.errors[path] = "Check this field.";
      }
      this.phase = "rejected";
      this.notice = outcomeCopy.fields;
      this.details = { code: "invalid-input" };
      this.credentialRefusal = false;
      this.changed();
      return;
    }
    const bytes = JSON.stringify(parsed.data);
    if (new TextEncoder().encode(bytes).length > 65536) {
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
      this.errors = Object.fromEntries(
        (result.state === "recorded" ? [] : (result.fieldPaths ?? [])).map(
          (p) => [p, "Check this field."],
        ),
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
              ? outcomeCopy.fields
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
  get(key: string, changed: () => void) {
    let draft = this.drafts.get(key);
    if (!draft) {
      draft = new ConfigurationDraft(changed, (receipt) =>
        this.savedRecords.set(key, { at: Date.now(), receipt }),
      );
      this.drafts.set(key, draft);
    }
    draft.bind(changed);
    return draft;
  }
  purge() {
    for (const draft of this.drafts.values()) draft.purge();
    this.drafts.clear();
    this.savedRecords.clear();
  }
}
