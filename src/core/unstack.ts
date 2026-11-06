import { z } from "zod";
import { materialDigest } from "./delivery.js";
import { DomainConflictError } from "./domain-errors.js";
import {
  type ArchiveBlocker,
  assertTaskProjectWritable,
} from "./project-lifecycle.js";
import { transaction, type Database } from "./store.js";
const id = z.string().uuid();
const text = z.string().min(1).max(512);
const sha = z.string().regex(/^[0-9a-f]{40}$/);
const digest = z.string().regex(/^[0-9a-f]{64}$/);
export const unstackPhases = [
  "prepared",
  "unstack-attempting",
  "unstack-confirmed",
  "retarget-attempting",
  "retarget-confirmed",
  "confirmed",
  "failed",
] as const;
export const unstackCommandSchema = z
  .object({
    key: id,
    taskId: id,
    expectedVersion: z.number().int().positive(),
    materialHash: digest,
  })
  .strict();
export type UnstackCommand = z.output<typeof unstackCommandSchema>;
export const unstackIdentitySchema = z
  .object({
    projectId: id,
    taskId: id,
    projectVersion: z.number().int().positive(),
    taskVersion: z.number().int().positive(),
    policyVersion: z.number().int().positive(),
    deliveryRevision: z.number().int().positive(),
    authorityDigest: digest,
    repositoryId: text,
    // A GitHub repository, or a GitLab project by numeric ID.
    repositoryPath: z
      .string()
      .regex(/^(?:\/repos\/[^/?#]+\/[^/?#]+|\/projects\/[1-9][0-9]{0,18})$/),
    pr: z
      .object({
        nodeId: text,
        number: z.number().int().positive(),
        headRef: text,
        headSha: sha,
        baseRef: text,
      })
      .strict(),
    targetBaseRef: text,
    edge: z
      .object({
        blockerTaskId: id,
        repositoryId: text,
        parentHead: sha,
        settledHead: sha.nullable(),
        restack: z.enum(["current", "pending"]),
        restackFromSha: sha.nullable(),
        restackSeq: z.number().int().nonnegative(),
        recordedAt: z.number().int().nonnegative(),
        seq: z.number().int().positive(),
      })
      .strict(),
    stack: z
      .object({
        // GitLab has no stack object, so no stack ID or number.
        id: z.number().int().positive().nullable(),
        number: z.number().int().positive().nullable(),
        baseRef: text,
        members: z
          .array(
            z
              .object({
                nodeId: text,
                number: z.number().int().positive(),
                headRef: text,
                headSha: sha,
                state: z.enum(["OPEN", "CLOSED", "MERGED"]),
              })
              .strict(),
          )
          .min(2)
          .max(128),
      })
      .strict(),
  })
  .strict()
  .superRefine((i, c) => {
    const members = i.stack.members;
    const gitlab = i.repositoryPath.startsWith("/projects/");
    if (
      i.edge.repositoryId !== i.repositoryId ||
      // GitLab: no stack object, and the stack is the blocker's merge request then this one.
      (gitlab
        ? i.stack.id !== null ||
          i.stack.number !== null ||
          members.length !== 2 ||
          members[1]?.nodeId !== i.pr.nodeId
        : i.stack.id === null || i.stack.number === null) ||
      new Set(members.map((m) => m.nodeId)).size !== members.length ||
      new Set(members.map((m) => m.number)).size !== members.length ||
      !members.some(
        (m) =>
          m.nodeId === i.pr.nodeId &&
          m.number === i.pr.number &&
          m.headRef === i.pr.headRef &&
          m.headSha === i.pr.headSha &&
          m.state === "OPEN",
      )
    )
      c.addIssue({
        code: "custom",
        message: "Unstack material is inconsistent",
      });
  });
export type UnstackIdentity = z.output<typeof unstackIdentitySchema>;
export const unstackRecordSchema = z
  .object({
    operationId: id,
    command: unstackCommandSchema,
    identity: unstackIdentitySchema,
    phase: z.enum(unstackPhases),
    revision: z.number().int().positive(),
    reason: z.enum([
      "pending",
      "readback-required",
      "readback-unavailable",
      "authority-changed",
      "identity-changed",
      "unstack-refused",
      "retarget-refused",
      "confirmed",
    ]),
    removed: z.boolean(),
    retargetRejected: z.boolean(),
    newBaseSha: sha.nullable(),
    noEffect: z.enum(["prepared-authority-refused", "unstack-422"]).nullable(),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((r, c) => {
    if (
      r.operationId !== r.command.key ||
      r.command.taskId !== r.identity.taskId ||
      r.command.expectedVersion !== r.identity.taskVersion ||
      r.command.materialHash !== materialDigest(r.identity) ||
      ([
        "unstack-confirmed",
        "retarget-attempting",
        "retarget-confirmed",
        "confirmed",
      ].includes(r.phase) &&
        !r.removed) ||
      (["retarget-confirmed", "confirmed"].includes(r.phase) &&
        !r.newBaseSha) ||
      (["prepared", "unstack-attempting", "failed"].includes(r.phase) &&
        r.removed) ||
      (!["retarget-confirmed", "confirmed"].includes(r.phase) &&
        r.newBaseSha !== null) ||
      (!["retarget-attempting", "retarget-confirmed", "confirmed"].includes(
        r.phase,
      ) &&
        r.retargetRejected) ||
      (r.phase === "failed") !== (r.noEffect !== null) ||
      (r.phase === "failed" &&
        (r.reason === "unstack-refused"
          ? r.noEffect !== "unstack-422"
          : r.reason !== "authority-changed" ||
            r.noEffect !== "prepared-authority-refused")) ||
      (r.phase === "confirmed") !== (r.reason === "confirmed")
    )
      c.addIssue({
        code: "custom",
        message: "Unstack journal cannot prove its phase",
      });
  });
export type UnstackRecord = z.output<typeof unstackRecordSchema>;
/** Explicit private identity/ref/object traversal; phase, counts, flags and digests are metadata. */
export function unstackPrivateValues(r: UnstackRecord): string[] {
  const i = r.identity;
  return [
    ...new Set([
      r.operationId,
      r.command.key,
      r.command.taskId,
      i.projectId,
      i.taskId,
      i.repositoryId,
      i.repositoryPath,
      i.pr.nodeId,
      i.pr.headRef,
      i.pr.headSha,
      i.pr.baseRef,
      i.targetBaseRef,
      i.edge.blockerTaskId,
      i.edge.repositoryId,
      i.edge.parentHead,
      ...(i.edge.settledHead ? [i.edge.settledHead] : []),
      ...(i.edge.restackFromSha ? [i.edge.restackFromSha] : []),
      i.stack.baseRef,
      ...i.stack.members.flatMap((m) => [m.nodeId, m.headRef, m.headSha]),
      ...(r.newBaseSha ? [r.newBaseSha] : []),
    ]),
  ];
}
export const unstackTables = `CREATE TABLE IF NOT EXISTS delivery_unstack_operations (
  operationId TEXT PRIMARY KEY, taskId TEXT NOT NULL REFERENCES domain_tasks(id),
  projectId TEXT NOT NULL REFERENCES domain_projects(id), blockerTaskId TEXT NOT NULL REFERENCES domain_tasks(id),
  edgeSequence INTEGER NOT NULL, payloadHash TEXT NOT NULL, phase TEXT NOT NULL,
  revision INTEGER NOT NULL, recordJson TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS delivery_unstack_task ON delivery_unstack_operations(taskId);`;

/** Separate operator journal: not an agent action and never a new delivery grant. */
export class UnstackStore {
  constructor(private readonly db: Database) {}
  migrate() {
    this.db.exec(unstackTables);
  }
  parse(row: unknown): UnstackRecord {
    const columns = z
      .object({
        operationId: id,
        taskId: id,
        projectId: id,
        blockerTaskId: id,
        edgeSequence: z.number().int().positive(),
        payloadHash: digest,
        phase: z.enum(unstackPhases),
        revision: z.number().int().positive(),
        recordJson: z.string(),
      })
      .strict()
      .parse(row);
    const r = unstackRecordSchema.parse(JSON.parse(columns.recordJson));
    if (
      r.operationId !== columns.operationId ||
      r.identity.taskId !== columns.taskId ||
      r.identity.projectId !== columns.projectId ||
      r.identity.edge.blockerTaskId !== columns.blockerTaskId ||
      r.identity.edge.seq !== columns.edgeSequence ||
      r.phase !== columns.phase ||
      r.revision !== columns.revision ||
      materialDigest(r.command) !== columns.payloadHash
    )
      throw new Error("Invalid persisted Unstack owner/phase");
    return r;
  }
  get(operationId: string): UnstackRecord | null {
    const row = this.db
      .prepare("SELECT * FROM delivery_unstack_operations WHERE operationId=?")
      .get(operationId);
    return row ? this.parse(row) : null;
  }
  records(taskId?: string): UnstackRecord[] {
    const rows = taskId
      ? this.db
          .prepare(
            "SELECT * FROM delivery_unstack_operations WHERE taskId=? ORDER BY rowid",
          )
          .all(taskId)
      : this.db
          .prepare("SELECT * FROM delivery_unstack_operations ORDER BY rowid")
          .all();
    return rows.map((r) => this.parse(r));
  }
  replay(command: UnstackCommand): UnstackRecord | null {
    const r = this.get(command.key);
    if (r && materialDigest(r.command) !== materialDigest(command))
      throw new DomainConflictError("Unstack key has different material");
    return r;
  }
  prepare(
    command: UnstackCommand,
    identity: UnstackIdentity,
    validate: () => void,
  ): UnstackRecord {
    return transaction(this.db, () => {
      const prior = this.replay(command);
      if (prior) return prior;
      assertTaskProjectWritable(this.db, command.taskId);
      validate();
      if (
        this.records().some(
          (r) =>
            !["confirmed", "failed"].includes(r.phase) &&
            (r.identity.taskId === command.taskId ||
              (r.identity.repositoryId === identity.repositoryId &&
                r.identity.stack.id === identity.stack.id &&
                r.identity.stack.number === identity.stack.number)),
        )
      )
        throw new DomainConflictError(
          "Unstack already has an unfinished owner for this task or provider stack",
        );
      const now = Date.now();
      const r = unstackRecordSchema.parse({
        operationId: command.key,
        command,
        identity,
        phase: "prepared",
        revision: 1,
        reason: "pending",
        removed: false,
        retargetRejected: false,
        newBaseSha: null,
        noEffect: null,
        createdAt: now,
        updatedAt: now,
      });
      this.db
        .prepare(
          "INSERT INTO delivery_unstack_operations VALUES (?,?,?,?,?,?,?,?,?)",
        )
        .run(
          r.operationId,
          identity.taskId,
          identity.projectId,
          identity.edge.blockerTaskId,
          identity.edge.seq,
          materialDigest(command),
          r.phase,
          r.revision,
          JSON.stringify(r),
        );
      return r;
    });
  }
  /** Caller holds the transaction for phase plus local metadata/event changes. */
  updateWithinTransaction(
    before: UnstackRecord,
    patch: Partial<
      Pick<
        UnstackRecord,
        | "phase"
        | "reason"
        | "removed"
        | "retargetRejected"
        | "newBaseSha"
        | "noEffect"
      >
    >,
  ): UnstackRecord {
    if (!this.db.isTransaction)
      throw new Error("Unstack transition requires a transaction");
    assertTaskProjectWritable(this.db, before.identity.taskId);
    const current = this.get(before.operationId);
    if (!current || current.revision !== before.revision)
      throw new DomainConflictError("Unstack journal changed");
    const next = unstackRecordSchema.parse({
      ...current,
      ...patch,
      revision: current.revision + 1,
      updatedAt: Date.now(),
    });
    const allowed: Record<
      UnstackRecord["phase"],
      readonly UnstackRecord["phase"][]
    > = {
      prepared: ["prepared", "unstack-attempting", "failed"],
      "unstack-attempting": [
        "unstack-attempting",
        "unstack-confirmed",
        "failed",
      ],
      "unstack-confirmed": [
        "unstack-confirmed",
        "retarget-attempting",
        "retarget-confirmed",
      ],
      "retarget-attempting": ["retarget-attempting", "retarget-confirmed"],
      "retarget-confirmed": ["retarget-confirmed", "confirmed"],
      confirmed: [],
      failed: [],
    };
    if (
      next.phase === "failed" &&
      (current.phase === "prepared"
        ? next.noEffect !== "prepared-authority-refused"
        : next.noEffect !== "unstack-422")
    )
      throw new DomainConflictError(
        "Unstack failure lacks definite no-effect evidence",
      );
    if (
      !allowed[current.phase].includes(next.phase) ||
      (current.removed && !next.removed) ||
      (current.retargetRejected && !next.retargetRejected)
    )
      throw new DomainConflictError(
        "Unstack phase cannot be replayed or rewound",
      );
    this.db
      .prepare(
        "UPDATE delivery_unstack_operations SET phase=?,revision=?,recordJson=? WHERE operationId=? AND revision=?",
      )
      .run(
        next.phase,
        next.revision,
        JSON.stringify(next),
        next.operationId,
        current.revision,
      );
    return next;
  }
  update(
    before: UnstackRecord,
    patch: Parameters<UnstackStore["updateWithinTransaction"]>[1],
    validate: () => void = () => {},
  ) {
    return transaction(this.db, () => {
      validate();
      return this.updateWithinTransaction(before, patch);
    });
  }
  pending(taskId: string, except?: string): UnstackRecord[] {
    return this.records(taskId).filter(
      (r) =>
        r.operationId !== except && !["confirmed", "failed"].includes(r.phase),
    );
  }
  projectBlockers(projectId: string): ArchiveBlocker[] {
    const orphan = this.db
      .prepare(`SELECT 1 FROM delivery_unstack_operations u LEFT JOIN domain_tasks t ON t.id=u.taskId
      LEFT JOIN domain_tasks b ON b.id=u.blockerTaskId WHERE t.id IS NULL OR b.id IS NULL OR t.projectId<>u.projectId OR b.projectId<>u.projectId LIMIT 1`)
      .get();
    if (orphan)
      return [
        {
          kind: "unavailable",
          reason: "Unstack task/project ownership is unproved",
        },
      ];
    const rows = this.db
      .prepare(`SELECT u.* FROM delivery_unstack_operations u
      LEFT JOIN domain_tasks t ON t.id=u.taskId WHERE u.projectId=? OR t.projectId=? LIMIT 129`)
      .all(projectId, projectId);
    if (rows.length > 128)
      return [
        {
          kind: "unavailable",
          reason: "Unstack drain exceeds its inspection bound",
        },
      ];
    return rows.flatMap((row): ArchiveBlocker[] => {
      try {
        const r = this.parse(row);
        const task = this.db
          .prepare("SELECT projectId FROM domain_tasks WHERE id=?")
          .get(r.identity.taskId) as { projectId: string } | undefined;
        if (
          task?.projectId !== r.identity.projectId ||
          r.identity.projectId !== projectId
        )
          throw new Error("Unstack owner mismatch");
        if (["confirmed", "failed"].includes(r.phase)) return [];
      } catch {
        return [
          {
            kind: "unavailable",
            reason: "Unstack ownership or terminal outcome is unproved",
          },
        ];
      }
      return [
        {
          kind: "delivery-action",
          reason: "An Unstack or retarget remains unfinished",
        },
      ];
    });
  }
  retiredSelected(taskId: string, blockerTaskId: string): boolean {
    return this.records(taskId).some(
      (r) =>
        r.phase === "confirmed" &&
        r.identity.edge.blockerTaskId === blockerTaskId,
    );
  }
  retired(taskId: string, blockerTaskId: string): boolean {
    const edge = this.db
      .prepare(
        "SELECT seq FROM task_dependency_records WHERE taskId=? AND blockerTaskId=?",
      )
      .get(taskId, blockerTaskId) as { seq: number } | undefined;
    return this.records(taskId).some(
      (r) =>
        r.phase === "confirmed" &&
        r.identity.edge.blockerTaskId === blockerTaskId &&
        (!edge || r.identity.edge.seq === edge.seq),
    );
  }
}
