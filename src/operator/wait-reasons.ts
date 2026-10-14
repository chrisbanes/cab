import { z } from "zod";

/**
 * Why a task would not start a turn now, in the fixed order of the first-task flow
 * (docs/user-flows/first-task.md). The first wait is primary; the rest are listed.
 * A read-side projection only: admission keeps its own reasons and order.
 */
export const waitCodes = [
  "project-paused",
  "project-lead-unconfigured",
  "project-lead-revoked",
  "runtime-unavailable",
  "claude-token-unavailable",
  "profile-runtime-not-configured",
  "power-held",
  "local-dependency",
  "imported-blockers-blocked",
  "imported-blockers-unknown",
  "source-held",
  "approval",
  "admission-blocked",
  "capacity",
] as const;
export type WaitCode = (typeof waitCodes)[number];
/** Waits that come from the executing profile's runtime rather than the project or task. */
export const runtimeWaitCodes: readonly WaitCode[] = [
  "runtime-unavailable",
  "claude-token-unavailable",
  "profile-runtime-not-configured",
];

const id = z.string().uuid();
// Redaction can lengthen a title, so this matches the task read's text bound.
const label = z.string().min(1).max(16000);
/** A Fix performs exactly one named command (Resume project) or opens one screen. */
export const waitFixSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("resume-project"), projectId: id }).strict(),
  z.object({ kind: z.literal("choose-lead"), projectId: id }).strict(),
  z.object({ kind: z.literal("readiness") }).strict(),
  z.object({ kind: z.literal("add-claude") }).strict(),
  z.object({ kind: z.literal("open-profile"), profileId: id }).strict(),
]);
/** Holds link to their blocker and never carry a Fix. */
export const waitLinkSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("task"), id, label }).strict(),
  z
    .object({ kind: z.literal("request"), id: z.string().min(1), label })
    .strict(),
  z
    .object({
      kind: z.literal("source"),
      url: z.url().startsWith("https://"),
      label,
    })
    .strict(),
  z.object({ kind: z.literal("tasks-running"), label }).strict(),
]);
export const waitSchema = z
  .object({
    code: z.enum(waitCodes),
    fix: waitFixSchema.nullable(),
    links: z.array(waitLinkSchema).max(10000),
    /** Context a hold has no link for; omitted when absent. */
    detail: label.optional(),
  })
  .strict();
export type Wait = z.infer<typeof waitSchema>;
export type WaitFix = z.infer<typeof waitFixSchema>;
export type WaitLink = z.infer<typeof waitLinkSchema>;

export const waitLabels: Record<WaitCode, string> = {
  "project-paused": "Project paused",
  "project-lead-unconfigured": "Project has no lead",
  "project-lead-revoked": "Project lead revoked",
  "runtime-unavailable": "Runtime unavailable",
  "claude-token-unavailable": "Claude token unavailable",
  "profile-runtime-not-configured": "Lead profile runtime not configured",
  "power-held": "Held by power supervision",
  "local-dependency": "Blocked by a task dependency",
  "imported-blockers-blocked": "Blocked by a GitHub dependency",
  "imported-blockers-unknown": "GitHub dependencies unconfirmed",
  "source-held": "Held by the source",
  approval: "Approval needs a decision",
  "admission-blocked": "Waiting to start",
  capacity: "Capacity full",
};

export const fixLabels: Record<WaitFix["kind"], string> = {
  "resume-project": "Resume project",
  "choose-lead": "Choose a lead",
  readiness: "Open readiness check",
  "add-claude": "Add Claude",
  "open-profile": "Open profile",
};

/** Sorts by the flow's order and keeps the first wait per code. */
export function orderWaits(waits: readonly Wait[]): Wait[] {
  const seen = new Set<WaitCode>();
  return [...waits]
    .sort((a, b) => waitCodes.indexOf(a.code) - waitCodes.indexOf(b.code))
    .filter((w) => !seen.has(w.code) && seen.add(w.code));
}

export interface WaitFacts {
  projectId: string;
  /** Admission reasons as the operator API maps them; `task-unready` is a Draft, not a wait. */
  admissionReasons: readonly string[];
  /** Runtime facts of the profile that runs the next turn; absent when none resolves. */
  lead?:
    | {
        profileId: string;
        runtimeUnavailable: boolean;
        claudeTokenUnavailable: boolean;
        runtimeNotConfigured: boolean;
      }
    | undefined;
  dependencies?: readonly { id: string; label: string }[];
  nativeBlockers?: readonly { url: string | null; label: string }[];
  sourceUrl?: string | null;
  approvals?: readonly { id: string; label: string }[];
  /** Set when capacity holds the task; the label says what uses it. */
  capacity?: string | null;
  /** Installation-wide: set while the power supervisor holds admission. */
  powerHold?: { reason: string | null } | null;
}

/** Builds the ordered waits from current facts. Pure: no reads, no clocks. */
export function deriveWaits(f: WaitFacts): Wait[] {
  const waits: Wait[] = [];
  const add = (code: WaitCode, fix: WaitFix | null, links: WaitLink[] = []) =>
    waits.push({ code, fix, links });
  const source: WaitLink[] = f.sourceUrl
    ? [{ kind: "source", url: f.sourceUrl, label: "Open source issue" }]
    : [];
  for (const reason of f.admissionReasons) {
    if (reason === "task-unready") continue;
    if (reason === "project-paused")
      add(reason, { kind: "resume-project", projectId: f.projectId });
    else if (
      reason === "project-lead-unconfigured" ||
      reason === "project-lead-revoked"
    )
      add(reason, { kind: "choose-lead", projectId: f.projectId });
    else if (reason === "local-dependency")
      add(
        reason,
        null,
        (f.dependencies ?? []).map((d) => ({
          kind: "task",
          id: d.id,
          label: d.label,
        })),
      );
    else if (
      reason === "imported-blockers-blocked" ||
      reason === "imported-blockers-unknown"
    ) {
      const blockers = (f.nativeBlockers ?? []).flatMap((b): WaitLink[] =>
        b.url ? [{ kind: "source", url: b.url, label: b.label }] : [],
      );
      add(reason, null, blockers.length ? blockers : source);
    } else if (reason === "source-held" || reason.startsWith("source-"))
      add("source-held", null, source);
    else add("admission-blocked", null);
  }
  if (f.lead) {
    if (f.lead.runtimeUnavailable)
      add("runtime-unavailable", { kind: "readiness" });
    else if (f.lead.runtimeNotConfigured)
      add("profile-runtime-not-configured", {
        kind: "open-profile",
        profileId: f.lead.profileId,
      });
    if (f.lead.claudeTokenUnavailable)
      add("claude-token-unavailable", { kind: "add-claude" });
  }
  if (f.powerHold)
    waits.push({
      code: "power-held",
      fix: null,
      links: [],
      ...(f.powerHold.reason ? { detail: f.powerHold.reason } : {}),
    });
  if (f.approvals?.length)
    add(
      "approval",
      null,
      f.approvals.map((a) => ({ kind: "request", id: a.id, label: a.label })),
    );
  if (f.capacity)
    add("capacity", null, [{ kind: "tasks-running", label: f.capacity }]);
  return orderWaits(waits);
}

/** The CLI's Fix line: the command to run or the Settings path to open. */
export function cliFix(fix: WaitFix): string[] {
  switch (fix.kind) {
    case "resume-project":
      return [
        `ensemble project prepare ${fix.projectId} --out project.json --paused false`,
        "ensemble project apply --file project.json",
      ];
    case "choose-lead":
      return [
        `ensemble project prepare ${fix.projectId} --out project.json --lead-profile PROFILE_ID`,
        "ensemble project apply --file project.json",
      ];
    case "readiness":
      return ["ensemble doctor"];
    case "add-claude":
      return ["Settings → Add Claude"];
    case "open-profile":
      return [`Settings → Profiles → ${fix.profileId}`];
  }
}
