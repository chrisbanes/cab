import type {
  DeliveryActionRecord,
  DeliveryStore,
  ExternalAction,
} from "../core/delivery.js";
import type {
  Publication,
  TaskPublicationStore,
} from "../core/task-publication.js";
import { publicationMarker } from "../core/task-publication-contracts.js";
import type { DeliveryCoordinator } from "./delivery.js";

/** A recorded step that has settled for good: success, or a failure no retry will change. */
function settled(record: DeliveryActionRecord): boolean {
  return (
    record.state === "confirmed-success" ||
    record.state === "denied" ||
    (record.state === "confirmed-failure" &&
      !(record.observation?.retryable && record.attempts < 3))
  );
}

/**
 * Sends a confirmed publication step by step: the issue, then the Project item, then each readiness
 * field. Every step is its own delivery action with a frozen operation id, so `advance` only
 * submits a step whose record does not exist yet and a replay returns the prior record: restart,
 * Link and the periodic refresh all resume it without minting a new operation. It stops at the
 * first step whose outcome is unknown or retryable. Once the create is confirmed and the remaining
 * steps are recorded (confirmed, failed or uncertain) the same task becomes the issue's imported
 * task in one transaction.
 */
export class TaskPublicationDriver {
  private readonly tails = new Map<string, Promise<unknown>>();
  constructor(
    private readonly publications: TaskPublicationStore,
    private readonly delivery: DeliveryStore,
    private readonly coordinator: DeliveryCoordinator,
  ) {}

  /** Advances every publication being sent; one that throws leaves the others to run. */
  async advanceAll(): Promise<void> {
    for (const publication of this.publications.sending())
      await this.advance(publication.review.publicationId).catch(() => {});
  }

  advance(publicationId: string): Promise<Publication | undefined> {
    const prior = this.tails.get(publicationId) ?? Promise.resolve();
    const run = prior.catch(() => {}).then(() => this.run(publicationId));
    this.tails.set(publicationId, run);
    void run
      .finally(() => {
        if (this.tails.get(publicationId) === run)
          this.tails.delete(publicationId);
      })
      .catch(() => {});
    return run;
  }

  private async run(publicationId: string): Promise<Publication | undefined> {
    let publication = this.publications.get(publicationId);
    if (publication?.state !== "sending") return publication;
    const { review } = publication,
      caller = review.caller,
      submit = (operationId: string, action: ExternalAction) =>
        this.coordinator.submit({ operationId, action }, caller);
    const create = await submit(publicationId, {
      kind: "issue.create",
      target: { repositoryId: caller.repositoryId },
      title: review.issue.title,
      body: review.issue.body,
      labels: review.issue.labels,
    });
    if (create.state !== "confirmed-success") {
      // Provably not on GitHub, or refused before any attempt: the task stays local.
      if (settled(create)) this.publications.end(publicationId, "failed");
      return this.publications.get(publicationId);
    }
    const issue = create.observation?.receipt;
    if (!issue?.number) return this.publications.get(publicationId);
    this.publications.recordIssue(publicationId, issue.nodeId, issue.number);
    publication = this.publications.get(publicationId);
    const target = {
      repositoryId: caller.repositoryId,
      number: issue.number,
      nodeId: issue.nodeId,
    };
    const confirmedFields: {
      projectNodeId: string;
      fieldNodeId: string;
      optionNodeId: string;
    }[] = [];
    // A step that is unsettled holds the publication; a settled failure ends the steps and converts.
    let converting = true;
    if (review.item) {
      const item = await submit(review.item.operationId, {
        kind: "project.item.add",
        target,
        projectNodeId: review.target.projectNodeId ?? "",
      });
      if (item.state === "confirmed-success" && item.observation?.receipt)
        this.publications.recordItem(
          publicationId,
          item.observation.receipt.nodeId,
        );
      else {
        converting = item.state === "uncertain" || settled(item);
        if (!converting) return this.publications.get(publicationId);
      }
    }
    const itemNodeId = this.publications.get(publicationId)?.itemNodeId;
    if (converting && itemNodeId)
      for (const field of review.fields) {
        const record = await submit(field.operationId, {
          kind: "project.field",
          target,
          projectNodeId: field.projectNodeId,
          itemNodeId,
          fieldNodeId: field.fieldNodeId,
          optionNodeId: field.optionNodeId,
        });
        if (record.state === "confirmed-success")
          confirmedFields.push({
            projectNodeId: field.projectNodeId,
            fieldNodeId: field.fieldNodeId,
            optionNodeId: field.optionNodeId,
          });
        else {
          // An unsettled retryable write waits for the next pass; anything else converts as it is.
          converting = record.state === "uncertain" || settled(record);
          break;
        }
      }
    if (!converting) return this.publications.get(publicationId);
    const path = create.beforeState?.repositoryPath;
    this.delivery.transaction(() =>
      this.publications.convertWithinTransaction({
        publicationId,
        repositoryName:
          typeof path === "string" && path.startsWith("/repos/")
            ? path.slice("/repos/".length)
            : caller.repositoryId,
        body: `${review.issue.body}\n\n${publicationMarker(publicationId)}`,
        fields: confirmedFields,
      }),
    );
    return this.publications.get(publicationId);
  }
}
