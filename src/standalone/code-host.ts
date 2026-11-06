import type { z } from "zod";
import type {
  DeliveryActionRecord,
  DeliveryPolicy,
  ExternalAction,
  PrDeliveryObservation,
  ProviderActionObservation,
  RequiredCheck,
  StackLinkTarget,
} from "../core/delivery.js";
import type { StoredRepositoryLink } from "../core/repository-links.js";
import type {
  AdoptionContext,
  PrIdentity,
  PublicationContext,
} from "./github-delivery.js";

export type CodeHost = StoredRepositoryLink["codeHost"];

/** What cab asks of a code host for one project. */
export interface CodeHostDeliveryProvider {
  /** Operator Unstack freezes full provider membership; durable orchestration owns every send. */
  prepareUnstack?(
    repositoryId: string,
    prNumber: number,
  ): Promise<import("./unstack.js").UnstackMaterial>;
  unstackProvider?(
    policy: DeliveryPolicy,
  ): import("./unstack.js").UnstackProvider;
  /** Optional unchanged-rebase proof; verifies the exact remote ref before and after fetch. */
  readRebaseHead?(repositoryId: string, branch: string): Promise<string | null>;
  proveRebase?(input: {
    repositoryId: string;
    branch: string;
    workspacePath: string;
    oldBase: string;
    oldHead: string;
    newBase: string;
    newHead: string;
  }): Promise<import("../core/rebase-proof.js").RebaseProof | null>;
  /** Whether the provider delivers this kind of action; omitted means all of them. */
  supportsAction?(kind: ExternalAction["kind"]): boolean;
  inspectAction(
    record: DeliveryActionRecord,
  ): Promise<ProviderActionObservation>;
  preflight(
    action: ExternalAction,
    policy: DeliveryPolicy,
    publication?: PublicationContext,
    adoption?: AdoptionContext,
    /** For a merge: whether to ask the host to remove the source branch, for a stacked blocker. */
    merge?: { removeSourceBranch: boolean },
  ): Promise<Record<string, z.output<ReturnType<typeof z.json>>>>;
  performAction(
    record: DeliveryActionRecord,
  ): Promise<ProviderActionObservation>;
  inspectPr(
    identity: PrIdentity,
    policy: DeliveryPolicy,
  ): Promise<PrDeliveryObservation>;
  /** Stacked creates use a durable coordinator-owned send boundary. */
  prepareStackLink?(record: DeliveryActionRecord): Promise<StackLinkTarget>;
  performStackLink?(
    record: DeliveryActionRecord,
  ): Promise<ProviderActionObservation>;
  inspectStackLink?(
    record: DeliveryActionRecord,
  ): Promise<ProviderActionObservation>;
  /** A fresh read of what the code host requires before merging into the repository's default branch. */
  repositoryRequirements?(
    repositoryId: string,
  ): Promise<RepositoryRequirements>;
}
export interface RepositoryRequirements {
  hostChecks: RequiredCheck[];
  allowedMethods: PrDeliveryObservation["allowedMethods"];
}
/** Builds the provider for a project's repository on `host`. */
export type CodeHostProviderFactory = (
  projectId: string,
  policy: DeliveryPolicy,
  host: string,
) => CodeHostDeliveryProvider;
export type CodeHostProviderFactories = Partial<
  Record<CodeHost, CodeHostProviderFactory>
>;
