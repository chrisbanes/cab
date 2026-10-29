import { z } from "zod";
import {
  absentBranchHead,
  type DeliveryActionRecord,
  type ExternalAction,
  type ProviderActionObservation,
} from "../core/delivery.js";
import type { AdoptOutcome } from "./git-fetch.js";
import type { PushOutcome } from "./git-push.js";
import type { AdoptionContext, PublicationContext } from "./github-delivery.js";

/**
 * Branch delivery shared by the code hosts: the preflight comparisons, the push outcome mapping,
 * the adoption re-reads and the ref-only settlement. A code host supplies only how to read a ref and
 * how to move Git objects for one verified repository.
 */

const name = z.string().min(1);
const sha = z.string().regex(/^[0-9a-f]{40}$/);

/** A branch action refused at preflight; `outsideHeadSha` names a remote head cab did not push. */
export class PublicationRefusal extends Error {
  constructor(
    readonly reason:
      | "branch-outside-change"
      /** The remote is back at cab's last push: nothing outside remains to recover from. */
      | "branch-outside-cleared"
      | "branch-not-fast-forward"
      | "branch-force-push-needs-lease",
    readonly outsideHeadSha: string | null = null,
  ) {
    super(reason);
  }
}

/** One verified repository on a code host. */
export interface BranchRemote {
  /** The branch's head, or null when the branch does not exist. */
  readRef(branch: string): Promise<string | null>;
  push(request: {
    workspacePath: string;
    commitSha: string;
    branch: string;
    lease: string | null;
  }): Promise<PushOutcome>;
  adopt(request: {
    workspacePath: string;
    baseCommit: string;
    commitSha: string;
    branch: string;
  }): Promise<AdoptOutcome>;
}

/** How a code host binds a `BranchRemote` to a repository. */
export interface BranchRemotes {
  /** From the location recorded at preflight; throws when it is malformed. */
  recorded(beforeState: unknown): BranchRemote;
  /** From a fresh verification of the repository. */
  verified(repositoryId: string): Promise<BranchRemote>;
}

/** The actions this module delivers. */
export type BranchAction = Extract<
  ExternalAction,
  { kind: "branch.push" | "branch.force-push" | "branch.adopt" }
>;
export const isBranchKind = (kind: ExternalAction["kind"]) =>
  kind === "branch.push" ||
  kind === "branch.force-push" ||
  kind === "branch.adopt";
export const isBranchAction = (
  action: ExternalAction,
): action is BranchAction => isBranchKind(action.kind);

type PushAction = Extract<
  ExternalAction,
  { kind: "branch.push" | "branch.force-push" }
>;
type AdoptAction = Extract<ExternalAction, { kind: "branch.adopt" }>;

/** Every adopt outcome but success has its own reason, so a new outcome cannot reach the success path. */
const adoptFailures: Record<Exclude<AdoptOutcome, "adopted">, string> = {
  "not-attempted": "branch-adopt-workspace-unavailable",
  "fetch-failed": "branch-adopt-fetch-failed",
  "too-large": "branch-adopt-too-large",
  "not-on-base": "branch-adopt-not-on-base",
  unproved: "branch-adopt-unproved",
};

/** The branch-specific part of a preflight; the caller adds the code host's repository location. */
export async function branchPreflight(
  action: BranchAction,
  remote: BranchRemote,
  publication?: PublicationContext,
  adoption?: AdoptionContext,
) {
  if (action.kind === "branch.adopt") {
    if (!adoption) throw new Error("provider-adoption-unverified");
    const head = await remote.readRef(adoption.branch);
    // The approved head must still be the remote's; a branch back at cab's push has nothing to adopt.
    if (head !== action.outsideHeadSha) {
      if (head === adoption.lastPushedSha)
        throw new PublicationRefusal("branch-outside-cleared");
      throw new PublicationRefusal("branch-outside-change", head);
    }
    // Everything the effect needs survives a restart here, because adopt's only remote act is a read.
    return {
      repositoryId: action.target.repositoryId,
      branch: adoption.branch,
      beforeHead: head,
      outsideHeadSha: action.outsideHeadSha,
      lastPushedSha: adoption.lastPushedSha,
      workspacePath: adoption.workspacePath,
      baseCommit: adoption.baseCommit,
    };
  }
  if (!publication) throw new Error("provider-publication-unverified");
  const head = await remote.readRef(publication.branch);
  // An overwrite expects the approved outside head; any other publication needs the remote exactly
  // where cab left it. Only a retry may find it already at the commit: its earlier push could
  // have landed after the readback.
  const outside = publication.outsideHeadSha;
  const recovery = outside !== undefined;
  const expected = !recovery
    ? publication.lastPushedSha
    : outside === absentBranchHead
      ? null
      : outside;
  if (head !== expected && !(publication.retry && head === action.commitSha)) {
    if (recovery && head === publication.lastPushedSha)
      throw new PublicationRefusal("branch-outside-cleared");
    throw new PublicationRefusal("branch-outside-change", head);
  }
  if (action.kind === "branch.force-push") {
    // An overwrite's lease is the approved outside head, so it needs no earlier push.
    if (!recovery && publication.lastPushedSha === null)
      throw new PublicationRefusal("branch-force-push-needs-lease");
  } else if (publication.descendsFromLastPushed === false)
    throw new PublicationRefusal("branch-not-fast-forward");
  return {
    repositoryId: action.target.repositoryId,
    branch: publication.branch,
    beforeHead: head,
    lastPushedSha: publication.lastPushedSha,
    workspacePath: publication.workspacePath,
    uncommittedEntries: publication.uncommittedEntries,
    retry: publication.retry,
  };
}

/** Pushes the named commit unless the branch already has it, then settles by reading the ref. */
export async function publishBranch(
  record: DeliveryActionRecord,
  a: PushAction,
  remotes: BranchRemotes,
): Promise<ProviderActionObservation> {
  // Once Git reports the push done, the outcome stays unproved (never "not applied") until a read shows it.
  let pushed = false;
  const unsettled = (): ProviderActionObservation => ({
    state: "uncertain",
    reason: "provider-effect-unproved",
    receipt: null,
    ...(pushed ? { pushed: true } : {}),
  });
  const failure = (
    reason: string,
    extra: Partial<ProviderActionObservation> = {},
  ): ProviderActionObservation => ({
    state: "confirmed-failure",
    reason,
    receipt: null,
    ...extra,
  });
  try {
    const remote = remotes.recorded(record.beforeState);
    const before = z
      .object({
        branch: name,
        beforeHead: sha.nullable(),
        lastPushedSha: sha.nullable(),
        workspacePath: name,
        retry: z.boolean(),
      })
      .parse(record.beforeState);
    // Rejected by Git: unproved only in what the readback shows, never as a push that may have landed.
    const rejectedUnsettled = (): ProviderActionObservation => ({
      ...unsettled(),
      rejected: true,
    });
    const outside = (head: string | null) =>
      failure("branch-outside-change", {
        receipt: head
          ? {
              nodeId: a.target.repositoryId,
              ref: before.branch,
              headSha: head,
            }
          : null,
      });
    // A rejected update leaves the head it found: another writer's, unless an earlier attempt of
    // this operation may have landed that same commit.
    const afterRejection = async (
      outcomeFailure: ProviderActionObservation | null,
    ): Promise<ProviderActionObservation> => {
      let head: string | null;
      try {
        head = await remote.readRef(before.branch);
      } catch {
        return outcomeFailure ?? rejectedUnsettled();
      }
      if (head === before.beforeHead)
        return outcomeFailure ?? rejectedUnsettled();
      // An overwrite whose lease failed because the branch is back at cab's own push.
      if (
        a.kind === "branch.force-push" &&
        a.outsideHeadSha !== undefined &&
        head === before.lastPushedSha
      )
        return failure("branch-outside-cleared");
      if (head === a.commitSha)
        return before.retry ? unsettled() : outside(head);
      return outside(head);
    };
    if (before.beforeHead !== a.commitSha) {
      const outcome = await remote.push({
        workspacePath: before.workspacePath,
        commitSha: a.commitSha,
        branch: before.branch,
        // Every update is leased against the head preflight observed, so a branch another writer
        // created or advanced since then rejects the push instead of being recorded as ours.
        lease: before.beforeHead,
      });
      if (outcome === "uncertain") return unsettled();
      if (outcome === "not-attempted")
        return failure("push-not-attempted", {
          retryable: true,
          resumeAt: Date.now() + 60_000,
        });
      if (outcome === "rejected-non-fast-forward")
        return failure("branch-not-fast-forward");
      if (outcome === "rejected-remote")
        return afterRejection(failure("branch-push-rejected"));
      // Nothing was sent: an equal head is another writer's unless an earlier attempt may have landed.
      if (outcome === "rejected-lease" || outcome === "up-to-date")
        return afterRejection(null);
      pushed = true;
    }
    return await inspectBranchHead(record, a, pushed, remotes);
  } catch {
    return unsettled();
  }
}

/**
 * Adopts the approved outside head: reads the ref, fetches exactly that commit, then reads the ref
 * again. The only remote act is a read, so any failure is a confirmed no-effect failure that leaves
 * the hold in place, and a restart simply runs the sequence again from the recorded context.
 */
export async function adoptBranchHead(
  record: DeliveryActionRecord,
  a: AdoptAction,
  remotes: BranchRemotes,
): Promise<ProviderActionObservation> {
  const failure = (reason: string): ProviderActionObservation => ({
    state: "confirmed-failure",
    reason,
    receipt: null,
  });
  const at = (branch: string, headSha: string) => ({
    nodeId: a.target.repositoryId,
    ref: branch,
    headSha,
  });
  let remote: BranchRemote;
  let before: {
    branch: string;
    workspacePath: string;
    baseCommit: string;
    lastPushedSha: string | null;
  };
  try {
    remote = remotes.recorded(record.beforeState);
    before = z
      .object({
        branch: name,
        workspacePath: name,
        baseCommit: sha,
        lastPushedSha: sha.nullable(),
      })
      .parse(record.beforeState);
  } catch {
    return failure("branch-adopt-workspace-unavailable");
  }
  // A moved ref is another outside change: it is recorded and the approval is not reused.
  // A branch back at cab's own last push is not an outside change: nothing remains to recover from.
  const moved = (head: string | null): ProviderActionObservation =>
    head !== null && head === before.lastPushedSha
      ? failure("branch-outside-cleared")
      : {
          state: "confirmed-failure",
          reason: "branch-outside-change",
          receipt: head ? at(before.branch, head) : null,
        };
  try {
    const first = await remote.readRef(before.branch);
    if (first !== a.outsideHeadSha) return moved(first);
    const outcome = await remote.adopt({
      workspacePath: before.workspacePath,
      baseCommit: before.baseCommit,
      commitSha: a.outsideHeadSha,
      branch: before.branch,
    });
    if (outcome !== "adopted") return failure(adoptFailures[outcome]);
    const last = await remote.readRef(before.branch);
    if (last !== a.outsideHeadSha) return moved(last);
    return {
      state: "confirmed-success",
      reason: null,
      receipt: at(before.branch, a.outsideHeadSha),
    };
  } catch {
    return failure("branch-adopt-fetch-failed");
  }
}

/** Settles a branch action from the remote ref alone. */
export async function inspectBranchHead(
  record: DeliveryActionRecord,
  a: PushAction,
  pushed: boolean,
  remotes: BranchRemotes,
): Promise<ProviderActionObservation> {
  const remoteRepository = await remotes.verified(a.target.repositoryId);
  const before = z
    .object({
      branch: name,
      beforeHead: sha.nullable(),
      lastPushedSha: sha.nullable().optional(),
      uncommittedEntries: z.number().int().nonnegative(),
    })
    .parse(record.beforeState);
  const remote = await remoteRepository.readRef(before.branch);
  const at = (headSha: string) => ({
    nodeId: a.target.repositoryId,
    ref: before.branch,
    headSha,
  });
  const success = (extra: Partial<ProviderActionObservation> = {}) =>
    ({
      state: "confirmed-success",
      reason: null,
      receipt: {
        ...at(a.commitSha),
        uncommittedEntries: before.uncommittedEntries,
      },
      ...extra,
    }) as ProviderActionObservation;
  // An update Git rejected cannot own an equal head: that is another writer's.
  const rejected = record.observation?.rejected === true;
  if (remote === a.commitSha && !rejected) return success();
  if (remote === before.beforeHead && rejected)
    return {
      state: "confirmed-failure",
      reason: "branch-push-rejected",
      receipt: null,
    };
  if (remote === before.beforeHead)
    // Git said done but the read does not show it yet: unproved, never "not applied".
    return pushed
      ? {
          state: "uncertain",
          reason: "provider-effect-unproved",
          receipt: null,
          pushed: true,
        }
      : {
          state: "confirmed-failure",
          reason: "branch-push-not-applied",
          receipt: null,
          retryable: true,
        };
  // A third head: after a Git-confirmed push it is a later outside move; otherwise someone else moved
  // it, and an ambiguous attempt keeps its possible ownership of the commit it may have landed.
  const ambiguous =
    !pushed &&
    (record.state === "attempting" ||
      (record.observation?.state === "uncertain" && !rejected) ||
      record.observation?.ambiguous === true);
  // An overwrite that found the branch back at cab's own push has nothing left to replace.
  if (
    !pushed &&
    a.kind === "branch.force-push" &&
    a.outsideHeadSha !== undefined &&
    remote !== null &&
    remote === before.lastPushedSha
  )
    return {
      state: "confirmed-failure",
      reason: "branch-outside-cleared",
      receipt: null,
      ...(ambiguous ? { ambiguous: true } : {}),
    };
  return pushed
    ? success(remote ? { outsideHeadSha: remote } : { outsideDeleted: true })
    : {
        state: "confirmed-failure",
        reason: "branch-outside-change",
        receipt: remote ? at(remote) : null,
        ...(ambiguous ? { ambiguous: true } : {}),
      };
}
