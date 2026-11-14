// Pure state for the Instruction proposals settings tab.
import {
  type DraftingRunRead,
  instructionFeedbackLimits,
} from "../../src/operator/contracts.js";

export { instructionFeedbackLimits };
export const instructionNoteLimit = 16_000;
/** The configure `instructions` limit. */
export const instructionTextLimit = 16_000;
export const instructionProposalPollMs = 2000;

export type InstructionRun = DraftingRunRead["data"];

/** How much of the 20-item, 64,000-character selection is used, and whether it can be sent. */
export function selectionSummary(texts: readonly string[]) {
  const characters = texts.reduce((total, text) => total + text.length, 0);
  const over =
    texts.length > instructionFeedbackLimits.items ||
    characters > instructionFeedbackLimits.characters;
  return {
    line: `${texts.length} of ${instructionFeedbackLimits.items} selected · ${characters.toLocaleString("en-GB")} of ${instructionFeedbackLimits.characters.toLocaleString("en-GB")} characters`,
    over,
    sendable: texts.length > 0 && !over,
  };
}

/** Why Accept is unavailable, or null when it can be sent. */
export function acceptBlock(
  run: Pick<
    InstructionRun,
    "state" | "proposalWithheld" | "instructionTarget" | "targetCurrent"
  >,
  finalText: string,
): string | null {
  if (run.state !== "proposed") return "There is no proposal to accept.";
  if (
    run.proposalWithheld ||
    run.instructionTarget?.observedInstructions == null
  )
    return "This proposal holds text that cannot be shown, so it cannot be accepted.";
  if (!run.targetCurrent?.unchanged)
    return "The instructions changed since this proposal was drafted. Redraft to review it against the current text.";
  if (finalText === run.instructionTarget.observedInstructions)
    return "The text is the same as the current instructions.";
  if (finalText.length > instructionTextLimit)
    return "Instructions can be at most 16,000 characters.";
  return null;
}

/** Who saving reaches and when; existing assignments keep their revision. */
export function impactLines(
  run: Pick<InstructionRun, "instructionTarget" | "impact">,
): string[] {
  const target = run.instructionTarget;
  const impact = run.impact;
  if (!target || !impact) return [];
  const assignments =
    impact.openAssignments === 1
      ? "1 open-task assignment uses"
      : `${impact.openAssignments} open-task assignments use`;
  const keep = `${assignments} the current revision and keeps it until you choose Apply current instructions on it.`;
  if (target.kind === "project")
    return [
      "Saving creates this project's next instructions revision. New assignments use it.",
      keep,
    ];
  const count = impact.projects.length;
  return [
    `Saving creates agent ${target.name ?? "(name withheld)"}'s next revision, used by ${count === 1 ? "1 project" : `${count} projects`}: ${impact.projects.map((p) => `${p.name ?? "(name withheld)"} (${p.role === "lead" ? "lead" : "permitted agent"})`).join(", ")}. New assignments in each use it.`,
    keep,
  ];
}

/** How to restore earlier wording with the existing configuration workflow. */
export function restoreLine(kind: "project" | "profile") {
  return `To restore earlier wording, open the ${kind === "project" ? "project" : "agent"}'s instructions in Settings, or run cab ${kind} prepare --restore-revision N.`;
}

/** The one line for an accepted save. */
export function savedLine(revision: number | null) {
  return revision === null
    ? "Saved the instructions."
    : `Saved as instructions revision ${revision}.`;
}

const runStateLabels: Record<InstructionRun["state"], string> = {
  queued: "Waiting for capacity",
  running: "Drafting",
  stopping: "Stopping",
  proposed: "Proposal ready",
  interrupted: "Stopped",
  failed: "Draft failed",
  accepted: "Accepted",
  discarded: "Rejected",
  expired: "Expired",
};
export const runStateLabel = (state: InstructionRun["state"]) =>
  runStateLabels[state];

export const evidenceUseLabel = {
  supports: "Supports",
  conflicts: "Conflicts",
  "not-used": "Not used",
} as const;

// Recovery is per-tab and bounded to the current start and the previous reviewed run.
import { z } from "zod";
import {
  commandReceiptSchema,
  operatorCommandSchema,
} from "../../src/operator/contracts.js";
import {
  matchesConfigurationReceipt,
  type DraftRecovery,
} from "./settings-state.js";

const targetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("project") }).strict(),
  z
    .object({ kind: z.literal("profile"), profileId: z.string().uuid() })
    .strict(),
]);
const selectionSchema = z
  .object({
    runId: z.string().uuid().optional(),
    startKey: z.string().uuid().optional(),
    expectedProjectVersion: z.number().int().positive().optional(),
    refs: z
      .array(
        z
          .object({
            kind: z.enum(["message", "follow-up", "comment"]),
            id: z.string().uuid(),
            text: z.string().max(instructionFeedbackLimits.characters),
          })
          .strict(),
      )
      .max(instructionFeedbackLimits.items),
    target: targetSchema,
    note: z.string().max(instructionNoteLimit),
  })
  .strict()
  .refine(
    (v) =>
      v.refs.reduce((n, r) => n + r.text.length, 0) <=
      instructionFeedbackLimits.characters,
  );
const startSchema = operatorCommandSchema
  .transform((c, ctx) => {
    if (c.type === "instruction.draft.start") return c;
    ctx.addIssue({ code: "custom", message: "Expected instruction start" });
    return z.NEVER;
  })
  .refine((c) => new TextEncoder().encode(JSON.stringify(c)).length <= 65536);
const configureSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("project.configure"),
      key: z.string().uuid(),
      projectId: z.string().uuid(),
      expectedVersion: z.number().int().positive(),
      instructions: z.string().max(instructionTextLimit),
    })
    .strict(),
  z
    .object({
      type: z.literal("profile.configure"),
      key: z.string().uuid(),
      profileId: z.string().uuid(),
      expectedVersion: z.number().int().positive(),
      instructions: z.string().max(instructionTextLimit),
    })
    .strict(),
]);
const recoverySchema = z
  .object({
    values: z
      .record(z.string(), z.string())
      .refine(
        (v) =>
          Object.keys(v).every((k) => k === "key" || k === "instructions") &&
          (!v.key || z.string().uuid().safeParse(v.key).success) &&
          (v.instructions?.length ?? 0) <= instructionTextLimit,
      ),
    command: configureSchema.nullable(),
    receipt: commandReceiptSchema.nullable(),
  })
  .strict()
  .refine((v) =>
    !v.command
      ? v.receipt === null
      : v.command.key === v.values.key &&
        v.command.instructions === v.values.instructions &&
        (!v.receipt || matchesConfigurationReceipt(v.command, v.receipt)),
  );
const storedSchema = selectionSchema
  .safeExtend({
    pendingStart: startSchema.optional(),
    previous: selectionSchema.optional(),
    drafts: z.record(z.string().uuid(), recoverySchema).default({}),
    close: z
      .object({
        runId: z.string().uuid(),
        key: z.string().uuid(),
        disposition: z.enum(["accept", "discard"]),
      })
      .strict()
      .optional(),
  })
  .refine((v) => {
    const ids = new Set([v.runId, v.previous?.runId]);
    return (
      Object.keys(v.drafts).every((id) => ids.has(id)) &&
      (!v.previous ||
        Boolean(v.runId && v.previous.runId && v.runId !== v.previous.runId)) &&
      (!v.pendingStart ||
        (v.pendingStart.runId === v.runId &&
          v.pendingStart.key === v.startKey &&
          v.pendingStart.expectedProjectVersion ===
            v.expectedProjectVersion)) &&
      (!v.close || v.close.runId === v.runId)
    );
  });
export type StoredProposal = z.infer<typeof storedSchema>;
export const proposalStorageKey = (projectId: string) =>
  `cab.instruction-proposal:${projectId}`;
const emptyProposal = (): StoredProposal => ({
  refs: [],
  target: { kind: "project" },
  note: "",
  drafts: {},
});
export const proposalStorage = {
  getItem: (key: string) => sessionStorage.getItem(key),
  setItem: (key: string, value: string) => sessionStorage.setItem(key, value),
  removeItem: (key: string) => sessionStorage.removeItem(key),
};
type Storage = Pick<globalThis.Storage, "getItem" | "setItem" | "removeItem">;
/** One authoritative journal also receives completions while its tab is unmounted. */
export class ProposalJournal {
  private value = emptyProposal();
  private active = true;
  available = true;
  private listeners = new Set<() => void>();
  constructor(
    readonly projectId: string,
    private storage: Storage = proposalStorage,
  ) {
    try {
      const raw = storage.getItem(proposalStorageKey(projectId));
      const parsed = raw ? storedSchema.safeParse(JSON.parse(raw)) : null;
      if (
        parsed?.success &&
        (!parsed.data.pendingStart ||
          parsed.data.pendingStart.projectId === projectId)
      )
        this.value = parsed.data;
    } catch {
      this.available = false;
    }
  }
  snapshot = () => this.value;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  matches(runId: string | undefined) {
    return this.active && this.value.runId === runId;
  }
  change(patch: Partial<StoredProposal>) {
    if (!this.active) return;
    const next = { ...this.value, ...patch };
    const ids = new Set([next.runId, next.previous?.runId]);
    next.drafts = Object.fromEntries(
      Object.entries(next.drafts).filter(([id]) => ids.has(id)),
    );
    this.value = next;
    try {
      this.storage.setItem(
        proposalStorageKey(this.projectId),
        JSON.stringify(next),
      );
    } catch {
      this.available = false;
    }
    for (const listener of this.listeners) listener();
  }
  started(runId: string) {
    if (
      this.matches(runId) &&
      (this.value.pendingStart || this.value.previous || this.value.startKey)
    )
      this.change({
        pendingStart: undefined,
        previous: undefined,
        startKey: undefined,
        expectedProjectVersion: undefined,
      });
  }
  refused(runId: string) {
    if (!this.matches(runId)) return;
    const previous = this.value.previous;
    this.change({
      ...(previous ?? {
        runId: undefined,
        startKey: undefined,
        expectedProjectVersion: undefined,
      }),
      previous: undefined,
      pendingStart: undefined,
    });
  }
  clear() {
    this.change({
      runId: undefined,
      startKey: undefined,
      expectedProjectVersion: undefined,
      pendingStart: undefined,
      previous: undefined,
      drafts: {},
      close: undefined,
    });
  }
  recovery(
    run: Pick<InstructionRun, "projectId" | "runId" | "instructionTarget">,
  ): DraftRecovery {
    return {
      read: () => {
        const saved = this.value.drafts[run.runId];
        const c = saved?.command;
        const target = run.instructionTarget;
        if (
          c &&
          (c.type === "project.configure"
            ? target?.kind !== "project" || c.projectId !== run.projectId
            : target?.kind !== "profile" || c.profileId !== target.profileId)
        )
          return null;
        return saved ?? null;
      },
      write: (value) => {
        if (
          !this.active ||
          ![this.value.runId, this.value.previous?.runId].includes(run.runId)
        )
          return;
        const parsed = recoverySchema.safeParse(value);
        if (parsed.success)
          this.change({
            drafts: { ...this.value.drafts, [run.runId]: parsed.data },
          });
        else {
          this.available = false;
          this.change({});
        }
      },
    };
  }
  purge() {
    this.active = false;
    this.value = emptyProposal();
    try {
      this.storage.removeItem(proposalStorageKey(this.projectId));
    } catch {
      this.available = false;
    }
    for (const listener of this.listeners) listener();
  }
}
const journals = new Map<string, ProposalJournal>();
export function proposalJournal(projectId: string) {
  let journal = journals.get(projectId);
  if (!journal) {
    journal = new ProposalJournal(projectId);
    journals.set(projectId, journal);
  }
  return journal;
}
export function purgeProposalRecovery() {
  for (const journal of journals.values()) journal.purge();
  journals.clear();
  try {
    for (const key of Object.keys(sessionStorage))
      if (key.startsWith("cab.instruction-proposal:"))
        sessionStorage.removeItem(key);
  } catch {
    /* A blocked store cannot be read or written. */
  }
}
