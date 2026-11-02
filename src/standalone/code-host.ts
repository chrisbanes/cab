import type { z } from "zod";
import type {
  DeliveryActionRecord,
  DeliveryPolicy,
  ExternalAction,
  PrDeliveryObservation,
  ProviderActionObservation,
  RequiredCheck,
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
  ): Promise<Record<string, z.output<ReturnType<typeof z.json>>>>;
  performAction(
    record: DeliveryActionRecord,
  ): Promise<ProviderActionObservation>;
  inspectPr(
    identity: PrIdentity,
    policy: DeliveryPolicy,
  ): Promise<PrDeliveryObservation>;
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
