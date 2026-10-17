import { z } from "zod";
import {
  operatorCommandSchema,
  uuid,
  type OperatorCommand,
  type CommandReceipt,
} from "../../src/operator/contracts.js";
import type { OperatorClient } from "./api.js";
import { CommandLifecycle } from "./command-lifecycle.js";
import { failureCause, type ReceiptDetails } from "./outcome-copy.js";
export const storageKey = "ensemble.ui03.composer.v1";
export const recoveryLimit = 262144,
  commandLimit = 65536;
export const byteLength = (text: string) =>
  new TextEncoder().encode(text).length;
export const composerInputSchema = z
  .object({
    projectId: z.union([uuid, z.literal("")]),
    title: z.string(),
    outcome: z.string(),
    context: z.string(),
    links: z.array(z.string()),
    profileId: z.union([uuid, z.literal("")]),
    blockerTaskIds: z.array(uuid),
  })
  .strict();
export type ComposerInput = z.infer<typeof composerInputSchema>;
export const emptyInput = (): ComposerInput => ({
  projectId: "",
  title: "",
  outcome: "",
  context: "",
  links: [],
  profileId: "",
  blockerTaskIds: [],
});
const validInputSchema = composerInputSchema.extend({
  projectId: uuid,
  title: z.string().trim().min(1).max(512),
  outcome: z
    .string()
    .refine((s) => s.trim().length > 0, "Enter a desired outcome")
    .max(16000),
  context: z.string().max(16000),
  links: z
    .array(
      z
        .string()
        .max(2048)
        .refine((s) => {
          try {
            return ["http:", "https:"].includes(new URL(s).protocol);
          } catch {
            return false;
          }
        }, "Use an HTTP or HTTPS link"),
    )
    .max(32),
  blockerTaskIds: z
    .array(uuid)
    .max(128)
    .refine((ids) => new Set(ids).size === ids.length, "Duplicate dependency"),
});
const briefLimit = 16000;
/** The brief as submitted: outcome plus the Context and Reference links sections. */
export function composeOutcome(input: ComposerInput) {
  let outcome = input.outcome;
  if (input.context) outcome += `\n\nContext:\n${input.context}`;
  if (input.links.length)
    outcome += `\n\nReference links (passive context; no repository access):\n${input.links.join("\n")}`;
  return outcome;
}
/** True within 10% of the brief limit, or over it. */
export function briefNearLimit(input: ComposerInput) {
  return composeOutcome(input).length >= briefLimit * 0.9;
}
export function encodeOutcome(input: ComposerInput) {
  const outcome = composeOutcome(input);
  if (outcome.length > briefLimit)
    throw Error(
      "Combined outcome, context and links must be at most 16,000 characters.",
    );
  return outcome;
}
const creationSchema = operatorCommandSchema.options[0];
export const composerRecoverySchema = z.discriminatedUnion("status", [
  z
    .object({
      version: z.literal(1),
      status: z.literal("unfinished"),
      input: composerInputSchema,
    })
    .strict(),
  z
    .object({
      version: z.literal(1),
      status: z.literal("unknown"),
      input: composerInputSchema,
      command: creationSchema,
    })
    .strict(),
]);
export type ComposerRecovery = z.infer<typeof composerRecoverySchema>;
export interface RecoveryStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}
export function encodeRecovery(record: ComposerRecovery) {
  const valid = composerRecoverySchema.parse(record);
  if (valid.status === "unknown") {
    const input = validInputSchema.parse(valid.input),
      command = valid.command;
    if (
      command.projectId !== input.projectId ||
      command.title !== input.title ||
      command.outcome !== encodeOutcome(input) ||
      (command.initialAssignment?.profileId ?? "") !== input.profileId ||
      JSON.stringify(command.blockerTaskIds ?? []) !==
        JSON.stringify(input.blockerTaskIds)
    )
      throw Error("frozen-input-mismatch");
  }
  const bytes = JSON.stringify(valid);
  if (byteLength(bytes) > recoveryLimit) throw Error("recovery-too-large");
  if (
    valid.status === "unknown" &&
    byteLength(JSON.stringify(valid.command)) > commandLimit
  )
    throw Error("command-too-large");
  return bytes;
}
export function readRecovery(
  storage: RecoveryStorage,
): ComposerRecovery | null {
  try {
    const bytes = storage.getItem(storageKey);
    if (!bytes || byteLength(bytes) > recoveryLimit) return null;
    const record = composerRecoverySchema.parse(JSON.parse(bytes));
    if (encodeRecovery(record) !== bytes) return null;
    return record;
  } catch {
    return null;
  }
}
export function writeRecovery(
  storage: RecoveryStorage,
  record: ComposerRecovery,
) {
  const bytes = encodeRecovery(record);
  storage.setItem(storageKey, bytes);
  if (storage.getItem(storageKey) !== bytes || !readRecovery(storage))
    throw Error("recovery-readback-failed");
}
type CreationCommand = Extract<OperatorCommand, { type: "task.create" }>;
function matchesCreationReceipt(
  command: CreationCommand,
  receipt: CommandReceipt,
) {
  return (
    receipt.kind === "domain" &&
    receipt.key === command.key &&
    "state" in receipt.result &&
    receipt.result.id === command.taskId &&
    receipt.result.projectId === command.projectId &&
    receipt.result.state === "open" &&
    receipt.result.ready === command.ready &&
    receipt.result.version === 1 + (command.blockerTaskIds?.length ?? 0)
  );
}
/** The plain outcome copy of a creation; Details, not these lines, carry the codes. */
export const creationCopy = {
  created: "Task created.",
  drafted: "Draft saved.",
  unknown: (ready: boolean) =>
    `We couldn't confirm the ${ready ? "task was created" : "draft was saved"}. Your input is kept until you check.`,
  unsafeToCheck: (ready: boolean) =>
    `We couldn't check whether the ${ready ? "task was created" : "draft was saved"}: this browser can't keep your input safe. Your input is kept until you check.`,
  refused: (ready: boolean, cause: string, kept = true) =>
    `Couldn't ${ready ? "create the task" : "save the draft"}: ${cause}. ${
      kept
        ? "Your input is still here."
        : "Your input is still here, but reloading may lose it."
    }`,
};

export class ComposerState {
  input: ComposerInput = emptyInput();
  phase: "editable" | "pending" | "unknown" | "recorded" = "editable";
  /** The line to show: an outcome while `failed` or unknown, otherwise a quiet note. */
  notice = "";
  /** `notice` reports a creation that was refused; the next edit clears it. */
  failed = false;
  /** The receipt fields behind the outcome, shown only in its collapsed Details. */
  details: ReceiptDetails = {};
  errors: Record<string, string> = {};
  /** The latest edit is stored in this tab; never true after a failed write. */
  savedOnDevice = false;
  private readonly lifecycle = new CommandLifecycle<CreationCommand>();
  private generation = 0;
  private active = true;
  get receipt() {
    return this.lifecycle.receipt;
  }
  get frozen() {
    return this.lifecycle.frozen;
  }
  activate(changed: () => void) {
    this.generation++;
    this.active = true;
    this.changed = changed;
  }
  captureScope() {
    const generation = this.generation;
    return () => this.active && generation === this.generation;
  }
  dispose() {
    this.generation++;
    this.active = false;
    const command = this.frozen;
    if (this.phase === "pending" && command) {
      this.lifecycle.reset();
      this.lifecycle.restoreUnknown(command);
      this.phase = "unknown";
      this.notice = creationCopy.unknown(command.ready);
      this.details = this.describe(command);
    }
  }
  recovered = false;
  constructor(
    private readonly storage: RecoveryStorage,
    private changed: () => void = () => {},
  ) {
    const saved = readRecovery(storage);
    if (saved) {
      this.input = saved.input;
      this.recovered = true;
      this.savedOnDevice = true;
      if (saved.status === "unknown") {
        this.phase = "unknown";
        this.lifecycle.restoreUnknown(saved.command);
        this.notice = creationCopy.unknown(saved.command.ready);
        this.details = this.describe(saved.command);
      } else
        this.notice =
          "On-device unfinished input recovered. This is not a saved Ensemble task.";
    }
  }
  private publish() {
    if (this.active) this.changed();
  }
  private describe(command: CreationCommand, code?: string): ReceiptDetails {
    const receipt = this.receipt;
    return {
      command: command.type,
      resource: command.taskId,
      requestKey: command.key,
      ...(receipt?.kind === "domain" && "state" in receipt.result
        ? { version: receipt.result.version }
        : {}),
      ...(code ? { code } : {}),
    };
  }
  /** Refuse a creation before anything is sent, keeping the input. */
  refuse(ready: boolean, cause: string) {
    this.failed = true;
    this.notice = creationCopy.refused(ready, cause);
    this.details = {};
    this.publish();
  }
  edit(patch: Partial<ComposerInput>) {
    if (this.phase !== "editable") return;
    this.input = { ...this.input, ...patch };
    this.errors = {};
    this.notice = "";
    this.failed = false;
    try {
      writeRecovery(this.storage, {
        version: 1,
        status: "unfinished",
        input: this.input,
      });
      this.savedOnDevice = true;
    } catch {
      this.savedOnDevice = false;
      this.notice =
        "Couldn't keep your edits on this device. Reloading may lose them.";
    }
    this.publish();
  }
  discard() {
    if (this.phase !== "editable") return;
    try {
      this.storage.removeItem(storageKey);
    } catch {}
    this.input = emptyInput();
    this.recovered = false;
    this.savedOnDevice = false;
    this.notice = "";
    this.failed = false;
    this.publish();
  }
  async submit(client: OperatorClient, csrfToken: string, ready: boolean) {
    if (!this.active || this.phase === "pending" || this.phase === "recorded")
      return;
    const wasUnknown = this.phase === "unknown";
    if (!wasUnknown) {
      this.errors = {};
      this.failed = false;
      this.notice = "";
      const validated = validInputSchema.safeParse(this.input);
      if (!validated.success) {
        for (const issue of validated.error.issues)
          this.errors[String(issue.path[0] ?? "outcome")] = issue.message;
        this.publish();
        return;
      }
      let outcome: string;
      try {
        outcome = encodeOutcome(this.input);
      } catch (e) {
        this.errors.outcome =
          e instanceof Error ? e.message : "Invalid outcome";
        this.publish();
        return;
      }
      const command = creationSchema.parse({
        type: "task.create",
        key: crypto.randomUUID(),
        projectId: this.input.projectId,
        taskId: crypto.randomUUID(),
        title: validated.data.title,
        outcome,
        ready,
        ...(this.input.blockerTaskIds.length
          ? { blockerTaskIds: [...this.input.blockerTaskIds] }
          : {}),
        ...(this.input.profileId
          ? {
              initialAssignment: {
                assignmentId: crypto.randomUUID(),
                profileId: this.input.profileId,
              },
            }
          : {}),
      });
      if (byteLength(JSON.stringify(command)) > commandLimit) {
        this.errors.outcome =
          "The encoded command exceeds the 64 KiB service limit. Shorten the brief.";
        this.publish();
        return;
      }
      this.lifecycle.freeze(command);
    }
    const command = this.frozen;
    if (!command) return;
    try {
      writeRecovery(this.storage, {
        version: 1,
        status: "unknown",
        input: this.input,
        command,
      });
      this.savedOnDevice = true;
    } catch {
      this.savedOnDevice = false;
      if (wasUnknown) {
        // The unconfirmed creation stays as it was, with its one action.
        this.notice = creationCopy.unsafeToCheck(command.ready);
      } else {
        this.lifecycle.reset();
        this.phase = "editable";
        this.failed = true;
        this.notice = creationCopy.refused(
          command.ready,
          "this browser can't keep your input safe, so nothing was sent",
          false,
        );
        this.details = {};
      }
      this.publish();
      return;
    }
    const sending = this.lifecycle.begin();
    if (!sending) return;
    const isCurrent = this.captureScope();
    this.phase = "pending";
    this.failed = false;
    this.notice = "";
    this.publish();
    const result = await client.command(sending, csrfToken);
    if (!isCurrent()) return;
    const disposition = this.lifecycle.settle(result, matchesCreationReceipt);
    if (disposition === "recorded") {
      this.phase = "recorded";
      this.details = this.describe(command);
      this.notice = command.ready ? creationCopy.created : creationCopy.drafted;
      try {
        this.storage.removeItem(storageKey);
      } catch {}
      this.recovered = false;
      this.savedOnDevice = false;
    } else if (disposition === "unknown") {
      this.phase = "unknown";
      this.details = this.describe(
        command,
        result.state === "recorded" ? undefined : result.code,
      );
      this.notice = creationCopy.unknown(command.ready);
    } else {
      this.phase = "editable";
      const code =
        result.state === "recorded" ? "command-outcome-unknown" : result.code;
      this.failed = true;
      this.details = this.describe(command, code);
      this.notice = creationCopy.refused(command.ready, failureCause(code));
      try {
        writeRecovery(this.storage, {
          version: 1,
          status: "unfinished",
          input: this.input,
        });
        this.savedOnDevice = true;
      } catch {
        this.savedOnDevice = false;
        this.notice = creationCopy.refused(
          command.ready,
          failureCause(code),
          false,
        );
      }
    }
    this.publish();
  }
}
