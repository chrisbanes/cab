import type { DeliveryPolicy } from "../core/delivery.js";
import type { CodeHostDeliveryProvider } from "./code-host.js";
import type {
  ClosedIssueInspection,
  PublishedIssueInspection,
} from "./github-delivery.js";
import type { GitHubSourceReader } from "./github-source.js";

/** Issue trackers cab can read and write; GitHub is the only implementation (ADR-1020). */
export type IssueTracker = "github";

/** What cab reads of an issue tracker; today's GitHub source contract. */
export type IssueTrackerReader = GitHubSourceReader;
/** Builds the reader that uses the credential `credentialRef` names. */
export type IssueTrackerReaderFactory = (
  credentialRef: string,
) => IssueTrackerReader;
export type IssueTrackerReaderFactories = Partial<
  Record<IssueTracker, IssueTrackerReaderFactory>
>;

/** What cab asks of an issue tracker for issue-action writes and their read-back. */
export interface IssueTrackerWriter
  extends Pick<
    CodeHostDeliveryProvider,
    "inspectAction" | "preflight" | "performAction"
  > {
  inspectPublishedIssue(
    target: { repositoryId: string; number: number },
    operationId: string,
  ): Promise<PublishedIssueInspection>;
  inspectClosedIssue(target: {
    repositoryId: string;
    nodeId: string;
    number: number;
  }): Promise<ClosedIssueInspection>;
}
/** Builds the writer for a project's issue tracker on `instance`. */
export type IssueTrackerWriterFactory = (
  projectId: string,
  policy: DeliveryPolicy,
  instance: string,
) => IssueTrackerWriter;
export type IssueTrackerWriterFactories = Partial<
  Record<IssueTracker, IssueTrackerWriterFactory>
>;
