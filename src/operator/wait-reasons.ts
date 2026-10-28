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
  "repository-access-revoked",
  "assignment-profile-revoked",
  "assignment-profile-stale",
  "assignment-instructions-stale",
  "assignment-profile-not-permitted",
  "assignment-held",
  "assignment-recovery-unresolved",
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
  z.object({ kind: z.literal("open-repositories"), projectId: id }).strict(),
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
  /** Opens the assignment's recovery; reading it releases nothing. */
  z.object({ kind: z.literal("recovery"), assignmentId: id, label }).strict(),
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
  "repository-access-revoked": "Repository access revoked",
  "assignment-profile-revoked": "Assignment profile revoked",
  "assignment-profile-stale": "Assignment profile changed",
  "assignment-instructions-stale": "Assignment instructions changed",
  "assignment-profile-not-permitted": "Assignment profile not permitted",
  "assignment-held": "Assignment held",
  "assignment-recovery-unresolved": "Assignment recovery unresolved",
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
  "open-repositories": "Open repositories",
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
  /** Set when the task's workspace uses a repository the project no longer links. */
  repositoryAccessRevoked?: boolean;
  /**
   * The assignments whose turns are next, each with the admission reasons it has beyond the
   * task's own. An unmapped reason is never dropped: it becomes `admission-blocked`.
   */
  assignments?: readonly {
    assignmentId: string;
    profileId: string;
    profileName: string | null;
    reasons: readonly string[];
  }[];
}

/**
 * Assignment-only admission reasons; `openProfile` is the Fix, the others have none.
 * `recovery` links the assignment's recovery instead.
 */
const assignmentReasonWaits = new Map<
  string,
  { code: WaitCode; openProfile: boolean; recovery?: boolean }
>([
  [
    "profile-revoked",
    { code: "assignment-profile-revoked", openProfile: true },
  ],
  [
    "assignment-profile-revision-stale",
    { code: "assignment-profile-stale", openProfile: true },
  ],
  [
    "assignment-instructions-revision-stale",
    { code: "assignment-instructions-stale", openProfile: false },
  ],
  [
    "profile-not-permitted",
    { code: "assignment-profile-not-permitted", openProfile: false },
  ],
  ["assignment-held", { code: "assignment-held", openProfile: false }],
  [
    "recovery-continuation-unresolved",
    {
      code: "assignment-recovery-unresolved",
      openProfile: false,
      recovery: true,
    },
  ],
]);

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
  if (f.repositoryAccessRevoked)
    add("repository-access-revoked", {
      kind: "open-repositories",
      projectId: f.projectId,
    });
  for (const a of f.assignments ?? [])
    for (const reason of a.reasons) {
      const wait = assignmentReasonWaits.get(reason);
      if (!wait) add("admission-blocked", null);
      else
        waits.push({
          code: wait.code,
          fix: wait.openProfile
            ? { kind: "open-profile", profileId: a.profileId }
            : null,
          links: wait.recovery
            ? [
                {
                  kind: "recovery",
                  assignmentId: a.assignmentId,
                  label: "Open recovery",
                },
              ]
            : [],
          ...(a.profileName ? { detail: a.profileName } : {}),
        });
    }
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

/** A hold that outlasts Resume project: what it is, what clears it, and what the Fix confirmation calls it. */
export interface HoldLine {
  kind: "stop" | "task" | "writer" | "capacity" | "uncertainty";
  label: string;
  clears: string;
  name: string;
}

const sentence = (text: string) =>
  /[.!?…)"'”]$/.test(text) ? text : `${text}.`;
const knownEnded = "Clears when we know the execution ended.";

/**
 * The task's execution holds in a fixed order, each with what clears it (149c). Labels equal
 * the recovery page's hold pills. `taskHold` is the reason of a hold other than Stop, so a
 * Stop-only task lists Stop once; a null reason means the text is withheld.
 */
export function holdLines(
  holds: {
    stop: boolean;
    writer: boolean;
    capacity: boolean;
    uncertainty: boolean;
  },
  taskHold: { reason: string | null } | null,
): HoldLine[] {
  const lines: HoldLine[] = [];
  if (holds.stop)
    lines.push({
      kind: "stop",
      label: "Operator Stop",
      clears: "Clears when the task's Stop is resumed.",
      name: "Operator Stop",
    });
  if (taskHold)
    lines.push({
      kind: "task",
      label: "Task hold",
      clears: `${sentence(taskHold.reason?.trim() || "No reason recorded.")} Recovery stays blocked while it remains.`,
      name: "task hold",
    });
  if (holds.writer)
    lines.push({
      kind: "writer",
      label: "Writer ownership",
      clears: knownEnded,
      name: "writer ownership",
    });
  if (holds.capacity)
    lines.push({
      kind: "capacity",
      label: "Capacity",
      clears: knownEnded,
      name: "capacity hold",
    });
  if (holds.uncertainty)
    lines.push({
      kind: "uncertainty",
      label: "Uncertainty",
      clears: knownEnded,
      name: "uncertainty hold",
    });
  return lines;
}

/** The CLI's Fix line: the command to run or the Settings path to open. */
export function cliFix(fix: WaitFix): string[] {
  switch (fix.kind) {
    case "resume-project":
      return [
        `cab project prepare ${fix.projectId} --out project.json --paused false`,
        "cab project apply --file project.json",
      ];
    case "choose-lead":
      return [
        `cab project prepare ${fix.projectId} --out project.json --lead-profile PROFILE_ID`,
        "cab project apply --file project.json",
      ];
    case "readiness":
      return ["cab doctor"];
    case "add-claude":
      return ["Settings → Add Claude"];
    case "open-profile":
      return [`Settings → Profiles → ${fix.profileId}`];
    case "open-repositories":
      return [
        `cab project sources ${fix.projectId}`,
        `cab project prepare-source ${fix.projectId} --out source.json --edit-file EDIT_FILE`,
        "cab project apply --file source.json",
      ];
  }
}
