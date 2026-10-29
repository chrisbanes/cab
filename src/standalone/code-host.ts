import type { z } from "zod";
import type {
  DeliveryActionRecord,
  DeliveryPolicy,
  ExternalAction,
  PrDeliveryObservation,
  ProviderActionObservation,
} from "../core/delivery.js";
import type { StoredRepositoryLink } from "../core/repository-links.js";
import type {
  AdoptionContext,
  ClosedIssueInspection,
  PrIdentity,
  PublicationContext,
  PublishedIssueInspection,
} from "./github-delivery.js";

export type CodeHost = StoredRepositoryLink["codeHost"];

/** What cab asks of a code host for one project; GitHub is the only implementation. */
export interface CodeHostDeliveryProvider {
  inspectPublishedIssue?(
    target: { repositoryId: string; number: number },
    operationId: string,
  ): Promise<PublishedIssueInspection>;
  inspectClosedIssue?(target: {
    repositoryId: string;
    nodeId: string;
    number: number;
  }): Promise<ClosedIssueInspection>;
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
