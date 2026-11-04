import { z } from "zod";
import { canonicalMaterial, materialDigest } from "../core/delivery.js";
import { DomainConflictError } from "../core/domain-errors.js";
import {
  unstackCommandSchema,
  unstackIdentitySchema,
  type UnstackCommand,
  type UnstackIdentity,
  type UnstackRecord,
  type UnstackStore,
} from "../core/unstack.js";

export class UnstackAuthorityChangedError extends DomainConflictError {}

export class UnstackDispatchFailure extends Error {
  constructor(readonly failure: unknown) {
    super("Unstack dispatch guard failed", { cause: failure });
  }
}
export function unstackDispatchGuard(guard: () => void): () => void {
  return () => {
    try {
      guard();
    } catch (error) {
      throw error instanceof UnstackDispatchFailure
        ? error
        : new UnstackDispatchFailure(error);
    }
  };
}

export type UnstackMaterial = Pick<
  UnstackIdentity,
  "repositoryPath" | "pr" | "stack"
>;
export type UnstackReadback =
  | { state: "changed" }
  | { state: "member"; material: UnstackMaterial }
  | { state: "removed"; baseRef: string; baseSha: string };
export interface UnstackProvider {
  read(identity: UnstackIdentity): Promise<UnstackReadback>;
  /** A response never confirms success. Only a definite validation rejection proves no send effect. */
  sendUnstack(
    record: UnstackRecord,
    beforeSend: () => void,
  ): Promise<"unknown" | "refused">;
  sendRetarget(
    record: UnstackRecord,
    beforeSend: () => void,
  ): Promise<"unknown" | "refused">;
}
export interface UnstackAuthority {
  /** The existing service ProjectWrites registry must register synchronously, before run's first await. */
  projectWrite<T>(taskId: string, run: () => Promise<T>): Promise<T>;
  /** Synchronous lifecycle, version, policy, task, branch, selected edge and ownership CAS. */
  validate(identity: UnstackIdentity): void;
  /** One SQLite transaction: recheck authority, accept base, retire selected edge, enqueue dedup restack, confirm journal. */
  confirm(record: UnstackRecord): UnstackRecord;
}

/** Intent-before-effect, readback-only after an unknown send; no retry clock or provider-effect recovery loop. */
export class UnstackCoordinator {
  private readonly active = new Map<string, Promise<UnstackRecord>>();
  constructor(
    private readonly journal: UnstackStore,
    private readonly provider: UnstackProvider,
    private readonly authority: UnstackAuthority,
  ) {}
  execute(
    command: UnstackCommand,
    identity: UnstackIdentity,
  ): Promise<UnstackRecord> {
    const c = unstackCommandSchema.parse(command),
      i = unstackIdentitySchema.parse(identity);
    if (
      materialDigest(i) !== c.materialHash ||
      i.taskId !== c.taskId ||
      i.taskVersion !== c.expectedVersion
    )
      return Promise.reject(
        new DomainConflictError("Unstack command has different material"),
      );
    const replay = this.journal.replay(c);
    if (replay && ["confirmed", "failed"].includes(replay.phase))
      return Promise.resolve(replay);
    return this.serial(c.taskId, async () => {
      const record = this.journal.prepare(c, i, () =>
        this.authority.validate(i),
      );
      return this.advance(record);
    });
  }
  reconcile(operationId: string): Promise<UnstackRecord> {
    const record = this.journal.get(operationId);
    if (!record) throw new DomainConflictError("Unstack operation unavailable");
    if (["confirmed", "failed"].includes(record.phase))
      return Promise.resolve(record);
    return this.serial(record.identity.taskId, async () => {
      const current = this.journal.get(operationId);
      if (!current)
        throw new DomainConflictError("Unstack operation disappeared");
      return this.advance(current);
    });
  }
  private serial(
    taskId: string,
    run: () => Promise<UnstackRecord>,
  ): Promise<UnstackRecord> {
    const previous = this.active.get(taskId);
    // Register now, not in a microtask after an archive/delete could start.
    const result = this.authority.projectWrite(taskId, async () => {
      if (previous) await previous.catch(() => {});
      return run();
    });
    this.active.set(taskId, result);
    void result
      .finally(() => {
        if (this.active.get(taskId) === result) this.active.delete(taskId);
      })
      .catch(() => {});
    return result;
  }
  private guard(record: UnstackRecord): void {
    this.authority.validate(record.identity);
    if (this.journal.get(record.operationId)?.revision !== record.revision)
      throw new DomainConflictError("Unstack send authority changed");
  }
  private async read(record: UnstackRecord): Promise<UnstackReadback | null> {
    try {
      const read = await this.provider.read(record.identity);
      if (read.state === "removed")
        return z
          .object({
            state: z.literal("removed"),
            baseRef: z.string().min(1).max(512),
            baseSha: z.string().regex(/^[0-9a-f]{40}$/),
          })
          .strict()
          .parse(read);
      if (read.state === "changed") return { state: "changed" };
      // Member material is compared byte-for-byte with the already validated immutable preview.
      if (read.state === "member") return read;
      return null;
    } catch {
      return null;
    }
  }
  private async advance(initial: UnstackRecord): Promise<UnstackRecord> {
    let r = initial;
    if (r.phase === "confirmed" || r.phase === "failed") return r;
    if (r.phase === "prepared") {
      const observed = await this.read(r);
      // Prepared proves no send happened. Changed authority can be refused definitively here only.
      try {
        this.guard(r);
      } catch (error) {
        if (!(error instanceof UnstackAuthorityChangedError)) throw error;
        return this.journal.update(r, {
          phase: "failed",
          reason: "authority-changed",
          noEffect: "prepared-authority-refused",
        });
      }
      if (!observed)
        return this.journal.update(r, { reason: "readback-unavailable" });
      const i = r.identity;
      if (
        observed.state !== "member" ||
        canonicalMaterial(observed.material) !==
          canonicalMaterial({
            repositoryPath: i.repositoryPath,
            pr: i.pr,
            stack: i.stack,
          })
      )
        return this.journal.update(r, { reason: "identity-changed" });
      r = this.journal.update(
        r,
        { phase: "unstack-attempting", reason: "readback-required" },
        () => this.guard(r),
      );
      const attempting = r;
      let response: "unknown" | "refused" = "unknown";
      try {
        response = await this.provider.sendUnstack(
          attempting,
          unstackDispatchGuard(() => this.guard(attempting)),
        );
      } catch (error) {
        if (
          error instanceof UnstackDispatchFailure &&
          !(error.failure instanceof DomainConflictError)
        )
          throw error.failure;
        // Intent remains uncertain, including cancellation and transport failure.
      }
      if (response === "refused")
        return this.journal.update(r, {
          phase: "failed",
          reason: "unstack-refused",
          noEffect: "unstack-422",
        });
    }
    if (r.phase === "unstack-attempting") {
      const observed = await this.read(r);
      if (!observed)
        return this.journal.update(r, { reason: "readback-unavailable" });
      if (observed.state !== "removed")
        return this.journal.update(r, {
          reason:
            observed.state === "changed"
              ? "identity-changed"
              : "readback-required",
        });
      // Removed alone is never terminal and never advances the accepted base.
      r = this.journal.update(r, {
        phase: "unstack-confirmed",
        removed: true,
        reason: "pending",
      });
    }
    if (r.phase === "unstack-confirmed") {
      const observed = await this.read(r);
      if (!observed)
        return this.journal.update(r, { reason: "readback-unavailable" });
      if (observed.state !== "removed")
        return this.journal.update(r, { reason: "identity-changed" });
      if (observed.baseRef === r.identity.targetBaseRef) {
        r = this.journal.update(r, {
          phase: "retarget-confirmed",
          newBaseSha: observed.baseSha,
          reason: "pending",
        });
      } else {
        if (observed.baseRef !== r.identity.pr.baseRef)
          return this.journal.update(r, { reason: "identity-changed" });
        try {
          this.guard(r);
        } catch (error) {
          if (!(error instanceof UnstackAuthorityChangedError)) throw error;
          return this.journal.update(r, { reason: "authority-changed" });
        }
        r = this.journal.update(
          r,
          { phase: "retarget-attempting", reason: "readback-required" },
          () => this.guard(r),
        );
        const attempting = r;
        let response: "unknown" | "refused" = "unknown";
        try {
          response = await this.provider.sendRetarget(
            attempting,
            unstackDispatchGuard(() => this.guard(attempting)),
          );
        } catch (error) {
          if (
            error instanceof UnstackDispatchFailure &&
            !(error.failure instanceof DomainConflictError)
          )
            throw error.failure;
          // A partial Unstack never becomes failed to release drain.
        }
        if (response === "refused")
          r = this.journal.update(r, {
            reason: "retarget-refused",
            retargetRejected: true,
          });
      }
    }
    if (r.phase === "retarget-attempting") {
      const observed = await this.read(r);
      if (!observed)
        return this.journal.update(r, { reason: "readback-unavailable" });
      if (
        observed.state !== "removed" ||
        observed.baseRef !== r.identity.targetBaseRef
      )
        return this.journal.update(r, {
          reason: r.retargetRejected ? "retarget-refused" : "readback-required",
        });
      r = this.journal.update(r, {
        phase: "retarget-confirmed",
        newBaseSha: observed.baseSha,
        reason: "pending",
      });
    }
    if (r.phase === "retarget-confirmed") {
      // Renew both proofs after restart and immediately before the atomic local commit.
      const observed = await this.read(r);
      if (!observed)
        return this.journal.update(r, { reason: "readback-unavailable" });
      if (
        observed.state !== "removed" ||
        observed.baseRef !== r.identity.targetBaseRef ||
        observed.baseSha !== r.newBaseSha
      )
        return this.journal.update(r, { reason: "identity-changed" });
      try {
        this.guard(r);
      } catch (error) {
        if (!(error instanceof UnstackAuthorityChangedError)) throw error;
        return this.journal.update(r, { reason: "authority-changed" });
      }
      const confirmed = this.authority.confirm(r);
      if (
        confirmed.phase !== "confirmed" ||
        this.journal.get(r.operationId)?.revision !== confirmed.revision
      )
        throw new Error("Unstack confirmation was not persisted atomically");
      return confirmed;
    }
    return r;
  }
}
