import type { DeliveryPolicy } from "../core/delivery.js";
import type { CodeHostDeliveryProvider } from "./code-host.js";
import type {
  ClosedIssueInspection,
  PublishedIssueInspection,
} from "./github-delivery.js";
import type { GitHubSourceReader } from "./github-source.js";
import type { JiraSourceReader } from "./jira-source.js";

/** Issue trackers cab can read and write (ADR-1020). */
export type IssueTracker = "github" | "jira";

/** What cab reads of an issue tracker; today's GitHub source contract. */
export type IssueTrackerReader = GitHubSourceReader;
/** Builds the reader that uses the credential `credentialRef` names. */
export type IssueTrackerReaderFactory = (
  credentialRef: string,
) => IssueTrackerReader;
/** Builds the reader of the Jira site `instance`, which finds its own installation credential. */
export type JiraReaderFactory = (instance: string) => JiraSourceReader;
export type IssueTrackerReaderFactories = {
  github?: IssueTrackerReaderFactory;
  jira?: JiraReaderFactory;
};

/** What cab asks of an issue tracker for issue-action writes and their read-back. */
export interface IssueTrackerWriter
  extends Pick<
    CodeHostDeliveryProvider,
    "supportsAction" | "inspectAction" | "preflight" | "performAction"
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

/**
 * A status write the tracker skips before sending anything (the issue moved, is already there, or no
 * single transition reaches the status): the coordinator records `reason` as a confirmed failure
 * and does not retry it.
 */
export class StatusSkipRefusal extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}
