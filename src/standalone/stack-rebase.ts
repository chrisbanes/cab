import {
  canonicalMaterial,
  acceptableBaseRefs,
  type DeliveryStore,
} from "../core/delivery.js";
import { rebaseProofSchema } from "../core/rebase-proof.js";
import type { DomainStore } from "../core/domain.js";
import {
  projectLifecycle,
  projectLifecycleMatches,
} from "../core/project-lifecycle.js";
import type { Database } from "../core/store.js";
import type { CodeHostDeliveryProvider } from "./code-host.js";
import type { SqliteWorkspaceBindingStore } from "./workspaces.js";

/** Called only inside the service-owned ProjectWrites lease, already registered before any await. */
export async function adoptMergedStackRebase(input: {
  db: Database;
  domain: DomainStore;
  delivery: DeliveryStore;
  workspaces: SqliteWorkspaceBindingStore;
  taskId: string;
  provider: CodeHostDeliveryProvider;
  notify?: () => void;
}): Promise<boolean> {
  const { db, domain, delivery, workspaces, taskId, provider } = input;
  if (!provider.proveRebase || !provider.readRebaseHead) return false;
  const task = domain.task(taskId),
    projectId = String(task.projectId);
  const lifecycle = projectLifecycle(db, projectId);
  if (lifecycle.archived || lifecycle.paused || task.state !== "open")
    return false;
  const edge = domain.stackedDependency(taskId),
    bound = delivery.delivery(taskId);
  if (
    !edge ||
    !bound ||
    bound.projectId !== projectId ||
    bound.readError ||
    bound.baseChange ||
    edge.restack !== "current"
  )
    return false;
  const p = bound.observation,
    branch = delivery.taskBranch(taskId, edge.repositoryId);
  const link = domain
    .repositoryLinks(projectId)
    .links.find((l) => l.repositoryId === edge.repositoryId);
  const lower = delivery.delivery(edge.blockerTaskId),
    lowerBranch = delivery.taskBranch(edge.blockerTaskId, edge.repositoryId);
  const workspace = workspaces.get(taskId),
    repository = workspace?.repositories.find(
      (r) => r.repositoryId === edge.repositoryId,
    );
  if (!/^[0-9a-f]{40}$/.test(edge.parentHead)) return false;
  if (
    link?.codeHost !== "github" ||
    p.repositoryId !== edge.repositoryId ||
    p.state !== "OPEN" ||
    p.merged ||
    p.baseRef !== bound.acceptedBaseRef ||
    !acceptableBaseRefs(link.ref).includes(p.baseRef) ||
    !branch?.lastPushedSha ||
    branch.branch !== p.headRef ||
    branch.outsideHeadSha !== p.headSha ||
    p.headSha === branch.lastPushedSha ||
    !lower ||
    lower.readError ||
    lower.projectId !== projectId ||
    domain.task(edge.blockerTaskId).projectId !== projectId ||
    !lowerBranch ||
    lower.observation.repositoryId !== edge.repositoryId ||
    lower.observation.headRef !== lowerBranch.branch ||
    bound.acceptedRetarget?.fromRef !== lowerBranch.branch ||
    bound.acceptedRetarget.toRef !== p.baseRef ||
    workspace?.state !== "ready" ||
    workspace.gitUncertain ||
    !repository ||
    repository.commit !== edge.parentHead ||
    (bound.rebaseProofs?.length ?? 0) >= 256
  )
    return false;
  // Unresolved actions and unused/open approvals retain their authority; automatic proof cannot replace them.
  const approval = () =>
    db
      .prepare(
        "SELECT b.* FROM delivery_approval_bindings b JOIN coordination_interactions i ON i.interactionId=b.interactionId WHERE b.taskId=? AND b.operationId IS NULL AND i.status IN ('open','approved') ORDER BY b.interactionId",
      )
      .all(taskId);
  if (delivery.actionBlockers(taskId).length || approval().length) return false;
  const ownership = () => ({
    holds: db
      .prepare("SELECT * FROM task_writer_holds WHERE taskId=?")
      .all(taskId),
    ambiguity: db
      .prepare("SELECT * FROM task_writer_ambiguity_holds WHERE taskId=?")
      .all(taskId),
    executions: db
      .prepare(
        "SELECT e.* FROM execution_intents e JOIN task_execution_bindings b ON b.workId=e.workId WHERE b.taskId=? ORDER BY e.workId",
      )
      .all(taskId),
    targets: db
      .prepare(
        "SELECT * FROM execution_stop_targets WHERE taskId=? ORDER BY workId",
      )
      .all(taskId),
  });
  const approvals = () =>
    db
      .prepare(
        "SELECT b.*, i.status, i.revision FROM delivery_approval_bindings b JOIN coordination_interactions i ON i.interactionId=b.interactionId WHERE b.taskId=? ORDER BY b.interactionId",
      )
      .all(taskId);
  const held = ownership();
  if (held.holds.length || held.ambiguity.length) return false;
  const snapshot = () =>
    canonicalMaterial({
      task: domain.task(taskId),
      edge: db
        .prepare("SELECT * FROM stacked_dependencies WHERE taskId=?")
        .get(taskId),
      branch: delivery.taskBranch(taskId, edge.repositoryId),
      bound: delivery.delivery(taskId),
      lower: delivery.delivery(edge.blockerTaskId),
      lowerBranch: delivery.taskBranch(edge.blockerTaskId, edge.repositoryId),
      workspace: workspaces.get(taskId),
      links: domain.repositoryLinks(projectId),
      policy: delivery.configuration(projectId),
      approvals: approvals(),
      ownership: ownership(),
      blockers: delivery.actionBlockers(taskId),
    });
  const captured = snapshot(),
    policy = delivery.configuration(projectId);
  const lowerIdentity = {
    repositoryId: edge.repositoryId,
    prNumber: lower.observation.number,
    expectedPrNodeId: lower.observation.nodeId,
    expectedHeadSha: lower.observation.headSha,
    recordedBaseRef: lower.acceptedBaseRef,
  };
  const ownIdentity = {
    repositoryId: p.repositoryId,
    prNumber: p.number,
    expectedPrNodeId: p.nodeId,
    expectedHeadSha: p.headSha,
    recordedBaseRef: bound.acceptedBaseRef,
  };
  const readLower = async () => {
    try {
      return await provider.inspectPr(lowerIdentity, policy);
    } catch {
      return null;
    }
  };
  const validLower = (value: Awaited<ReturnType<typeof readLower>>) =>
    !!value &&
    value.repositoryId === edge.repositoryId &&
    value.nodeId === lowerIdentity.expectedPrNodeId &&
    value.number === lowerIdentity.prNumber &&
    value.headRef === lowerBranch.branch &&
    value.headSha === lower.observation.headSha &&
    value.state === "MERGED" &&
    value.merged &&
    value.baseRef === p.baseRef;
  if (!validLower(await readLower())) return false;
  let proof: Awaited<
    ReturnType<NonNullable<CodeHostDeliveryProvider["proveRebase"]>>
  >;
  try {
    proof = await provider.proveRebase({
      repositoryId: p.repositoryId,
      branch: branch.branch,
      workspacePath: repository.workspacePath,
      oldBase: edge.parentHead,
      oldHead: branch.lastPushedSha,
      newBase: p.baseSha,
      newHead: p.headSha,
    });
  } catch {
    return false;
  }
  if (!proof) return false;
  const parsed = rebaseProofSchema.safeParse(proof);
  if (
    !parsed.success ||
    parsed.data.oldBase !== repository.commit ||
    parsed.data.oldHead !== branch.lastPushedSha ||
    parsed.data.newBase !== p.baseSha ||
    parsed.data.newHead !== p.headSha
  )
    return false;
  let fresh: Awaited<ReturnType<CodeHostDeliveryProvider["inspectPr"]>>;
  try {
    fresh = await provider.inspectPr(ownIdentity, policy);
  } catch {
    return false;
  }
  if (
    fresh.repositoryId !== p.repositoryId ||
    fresh.nodeId !== p.nodeId ||
    fresh.number !== p.number ||
    fresh.headRef !== p.headRef ||
    fresh.headSha !== p.headSha ||
    fresh.baseRef !== p.baseRef ||
    fresh.baseSha !== p.baseSha ||
    fresh.state !== "OPEN" ||
    fresh.merged ||
    !validLower(await readLower())
  )
    return false;
  try {
    if (
      (await provider.readRebaseHead(p.repositoryId, p.headRef)) !== p.headSha
    )
      return false;
  } catch {
    return false;
  }
  // No await from this final CAS through proof, edge and workspace metadata commit.
  return delivery.transaction(() => {
    if (!projectLifecycleMatches(db, lifecycle) || snapshot() !== captured)
      return false;
    delivery.recordRebaseWithinTransaction(taskId, parsed.data);
    db.prepare(
      "UPDATE stacked_dependencies SET parentHead=?, settledHead=?, restack='current', restackFromSha=NULL WHERE taskId=?",
    ).run(p.baseSha, p.baseSha, taskId);
    workspaces.advanceCommit(taskId, p.repositoryId, p.baseSha);
    input.notify?.();
    return true;
  });
}
