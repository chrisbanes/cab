import { z } from "zod";
import { adfToMarkdown } from "../core/adf-markdown.js";
import {
  actionObservationSchema,
  type DeliveryActionRecord,
  type ExternalAction,
  type ProviderActionObservation,
} from "../core/delivery.js";
import { markdownToAdf } from "../core/markdown-adf.js";
import type {
  ClosedIssueInspection,
  PublishedIssueInspection,
} from "./github-delivery.js";
import { jiraStatusSkipReasons } from "../operator/status-mapping-copy.js";
import { type IssueTrackerWriter, StatusSkipRefusal } from "./issue-tracker.js";
import type { resolveJiraAccess } from "./jira-credential.js";
import { type JiraAccess, JiraFailure, jiraRequest } from "./jira-http.js";

const pageSize = 100;
const maxPages = 100;
/** The comment property that marks the comment an operation posted. */
const markerKey = "cab-operation";
const supported: readonly ExternalAction["kind"][] = [
  "issue.comment",
  "issue.labels",
  "issue.close",
  "issue.status",
];

const numeric = z.string().regex(/^\d{1,20}$/);
const issueSchema = z
  .object({
    id: numeric,
    key: z.string().regex(/^[A-Z][A-Z0-9_]{0,254}-[1-9]\d{0,18}$/),
    fields: z
      .object({
        summary: z.string(),
        status: z
          .object({
            id: z.string().min(1),
            name: z.string(),
            statusCategory: z.object({ key: z.string().min(1) }).passthrough(),
          })
          .passthrough(),
        labels: z.array(z.string()).default([]),
        description: z.unknown().optional(),
        project: z.object({ id: z.string().min(1) }).passthrough(),
      })
      .passthrough(),
  })
  .passthrough();
const accountSchema = z.object({ accountId: z.string().min(1) }).passthrough();
const author = z
  .object({ accountId: z.string().optional() })
  .passthrough()
  .optional();
const commentsPage = z
  .object({
    comments: z.array(z.object({ id: numeric, author }).passthrough()),
    total: z.number().int().nonnegative(),
  })
  .passthrough();
const commentList = z
  .object({
    values: z.array(
      z
        .object({
          id: numeric,
          author,
          body: z.unknown(),
          properties: z
            .array(
              z.object({ key: z.string(), value: z.unknown() }).passthrough(),
            )
            .default([]),
        })
        .passthrough(),
    ),
  })
  .passthrough();
const changelogPage = z
  .object({
    values: z.array(
      z
        .object({
          id: numeric,
          author,
          items: z
            .array(
              z
                .object({
                  field: z.string(),
                  to: z.string().nullish(),
                })
                .passthrough(),
            )
            .default([]),
        })
        .passthrough(),
    ),
    total: z.number().int().nonnegative(),
  })
  .passthrough();
type History = z.output<typeof changelogPage>["values"][number];
const transitionsSchema = z
  .object({
    transitions: z.array(
      z
        .object({
          id: z.string().min(1),
          to: z
            .object({
              id: z.string().min(1),
              statusCategory: z.object({ key: z.string() }).passthrough(),
            })
            .passthrough(),
        })
        .passthrough(),
    ),
  })
  .passthrough();
/** What preflight recorded; the write and its readback trust nothing else. */
const beforeSchema = z
  .object({
    issueId: numeric,
    // Absent on a status write, whose readback names no author.
    accountId: z.string().min(1).optional(),
    state: z.enum(["open", "closed"]),
    transitionId: z.string().optional(),
    targetStatusId: z.string().optional(),
    changelogHighWater: z.string().optional(),
  })
  .passthrough();
type Before = z.output<typeof beforeSchema>;

const isDone = (issue: z.output<typeof issueSchema>) =>
  issue.fields.status.statusCategory.key === "done";
/** Whether a history moved the issue's status to `statusId`. */
const movedTo = (history: History, statusId: string) =>
  history.items.some((i) => i.field === "status" && i.to === statusId);
const unproved = (
  reason = "provider-effect-unproved",
): ProviderActionObservation => ({ state: "uncertain", reason, receipt: null });

/**
 * Jira Cloud comments, labels and closure for the delivery lifecycle. A write response proves
 * nothing: the effect is read back from Jira, and a closure counts only as a status history
 * entry by the credential user. The credential is resolved on every call.
 */
export class JiraIssueTrackerWriter implements IssueTrackerWriter {
  constructor(
    private readonly access: () => ReturnType<typeof resolveJiraAccess>,
    private readonly fetcher: typeof fetch = fetch,
    /** The status the project's mapping moves a finished task to: `issue.close` prefers the transition to it. */
    private readonly mappedDoneStatus: string | null = null,
  ) {}

  supportsAction(kind: ExternalAction["kind"]): boolean {
    return supported.includes(kind);
  }

  inspectPublishedIssue(): Promise<PublishedIssueInspection> {
    return Promise.reject(new Error("Jira issue publication is unavailable"));
  }

  private resolved(): JiraAccess {
    const access = this.access();
    if ("reason" in access) throw new JiraFailure(access.reason);
    return access;
  }

  private request(
    access: JiraAccess,
    path: string,
    init?: Parameters<typeof jiraRequest>[3],
  ) {
    return jiraRequest(this.fetcher, access, path, init);
  }

  /** The issue, which must be the one the action names. */
  private async issue(
    access: JiraAccess,
    target: { repositoryId: string; number: number; nodeId: string },
    id = target.nodeId,
  ) {
    const issue = issueSchema.parse(
      await this.request(
        access,
        `/issue/${id}?fields=summary,status,labels,description,project`,
      ),
    );
    if (
      issue.id !== target.nodeId ||
      Number(issue.key.slice(issue.key.lastIndexOf("-") + 1)) !==
        target.number ||
      issue.fields.project.id !== target.repositoryId
    )
      throw new Error("provider-target-mismatch");
    return issue;
  }

  private async accountId(access: JiraAccess) {
    return accountSchema.parse(await this.request(access, "/myself")).accountId;
  }

  private async changelog(access: JiraAccess, issueId: string) {
    const histories: History[] = [];
    for (let page = 0; ; page++) {
      if (page >= maxPages) throw new JiraFailure("page-limit");
      const data = changelogPage.parse(
        await this.request(
          access,
          `/issue/${issueId}/changelog?startAt=${histories.length}&maxResults=${pageSize}`,
        ),
      );
      histories.push(...data.values);
      if (histories.length >= data.total) return histories;
      // A short page that is not the last one would hide history.
      if (!data.values.length) throw new JiraFailure("malformed");
    }
  }

  async preflight(action: ExternalAction) {
    if (!this.supportsAction(action.kind) || !("number" in action.target))
      throw new Error("provider-action-unsupported");
    const access = this.resolved();
    const issue = await this.issue(access, action.target);
    if (action.kind === "issue.status")
      return this.statusPreflight(access, issue, action);
    const before: Record<string, string> = {
      issueId: issue.id,
      accountId: await this.accountId(access),
      state: isDone(issue) ? "closed" : "open",
    };
    if (action.kind === "issue.comment") markdownToAdf(action.body);
    if (
      action.kind === "issue.labels" &&
      [...action.add, ...action.remove].some((l) => /\s/.test(l))
    )
      throw new Error("provider-label-invalid");
    if (action.kind !== "issue.close") return before;
    if (before.state !== "open") throw new Error("provider-issue-not-open");
    const done = (await this.transitions(access, issue.id)).filter(
      (t) => t.to.statusCategory.key === "done",
    );
    // The mapping's done status, when a Done-category transition reaches it, is the one to take.
    const mapped = done.filter((t) => t.to.id === this.mappedDoneStatus);
    const [transition] = mapped.length ? mapped : done;
    if ((mapped.length || done.length) !== 1 || !transition)
      throw new Error("provider-transition-ambiguous");
    const newest = Math.max(
      0,
      ...(await this.changelog(access, issue.id)).map((h) => Number(h.id)),
    );
    return {
      ...before,
      transitionId: transition.id,
      targetStatusId: transition.to.id,
      changelogHighWater: String(newest),
    };
  }

  private async transitions(access: JiraAccess, issueId: string) {
    return transitionsSchema.parse(
      await this.request(access, `/issue/${issueId}/transitions`),
    ).transitions;
  }

  /**
   * A mapped status write: skipped, with nothing sent, unless the issue is not yet at the target,
   * still at the status cab last saw, and exactly one transition reaches the target. The skips are
   * ordered so cab's own closure followed by the Done write reads as already there, not as changed.
   */
  private async statusPreflight(
    access: JiraAccess,
    issue: z.output<typeof issueSchema>,
    action: Extract<ExternalAction, { kind: "issue.status" }>,
  ) {
    const current = issue.fields.status.id;
    if (current === action.statusId)
      throw new StatusSkipRefusal(jiraStatusSkipReasons.current);
    if (current !== action.expected.statusId)
      throw new StatusSkipRefusal(jiraStatusSkipReasons.changed);
    const reaching = (await this.transitions(access, issue.id)).filter(
      (t) => t.to.id === action.statusId,
    );
    const [transition] = reaching;
    if (!transition)
      throw new StatusSkipRefusal(jiraStatusSkipReasons.unavailable);
    if (reaching.length > 1)
      throw new StatusSkipRefusal(jiraStatusSkipReasons.ambiguous);
    return {
      issueId: issue.id,
      state: isDone(issue) ? "closed" : "open",
      transitionId: transition.id,
      targetStatusId: action.statusId,
    };
  }

  async performAction(
    record: DeliveryActionRecord,
  ): Promise<ProviderActionObservation> {
    const a = record.request.action;
    const before = beforeSchema.parse(record.beforeState);
    const write = (() => {
      switch (a.kind) {
        case "issue.comment":
          return {
            path: `/issue/${before.issueId}/comment`,
            init: {
              method: "POST" as const,
              body: {
                body: markdownToAdf(a.body),
                properties: [
                  {
                    key: markerKey,
                    value: { operationId: record.operationId },
                  },
                ],
              },
            },
          };
        case "issue.labels":
          return {
            path: `/issue/${before.issueId}`,
            init: {
              method: "PUT" as const,
              body: {
                update: {
                  labels: [
                    ...a.add.map((add) => ({ add })),
                    ...a.remove.map((remove) => ({ remove })),
                  ],
                },
              },
            },
          };
        case "issue.close":
        case "issue.status":
          return {
            path: `/issue/${before.issueId}/transitions`,
            init: {
              method: "POST" as const,
              body: { transition: { id: before.transitionId } },
            },
          };
        default:
          throw new Error("provider-action-unsupported");
      }
    })();
    let access: JiraAccess;
    try {
      access = this.resolved();
    } catch {
      // Nothing was sent.
      return {
        state: "confirmed-failure",
        reason: "provider-credential-unavailable",
        receipt: null,
      };
    }
    try {
      await this.request(access, write.path, write.init);
    } catch (error) {
      // Only a rejection of the one request is definitive; anything else may have been applied.
      if (error instanceof JiraFailure && error.status !== undefined)
        return {
          state: "confirmed-failure",
          reason: `provider-http-${error.status}`,
          receipt: null,
          ...(error.resumeAt === undefined
            ? {}
            : { retryable: true, resumeAt: error.resumeAt }),
        };
      return unproved();
    }
    // The write response never establishes success.
    return this.inspectAction(record);
  }

  async inspectAction(
    record: DeliveryActionRecord,
  ): Promise<ProviderActionObservation> {
    try {
      const a = record.request.action;
      const before = beforeSchema.parse(record.beforeState);
      if (!("number" in a.target) || before.issueId !== a.target.nodeId)
        throw new Error("provider-target-mismatch");
      const access = this.resolved();
      const receipt =
        a.kind === "issue.comment"
          ? await this.commentReceipt(access, record, a.body, before)
          : a.kind === "issue.labels"
            ? await this.labelsReceipt(access, a, before)
            : a.kind === "issue.close"
              ? await this.closeReceipt(access, a, before)
              : a.kind === "issue.status"
                ? await this.statusReceipt(access, a, before)
                : null;
      return actionObservationSchema.parse({
        state: receipt ? "confirmed-success" : "uncertain",
        reason: receipt ? null : "provider-effect-unproved",
        receipt,
      });
    } catch {
      return unproved("provider-readback-unavailable");
    }
  }

  /** Exactly one comment by the credential user carries this operation's marker and text. */
  private async commentReceipt(
    access: JiraAccess,
    record: DeliveryActionRecord,
    body: string,
    before: Before,
  ) {
    if (!before.accountId) throw new Error("provider-before-state-invalid");
    const mine: number[] = [];
    for (let seen = 0, page = 0; ; page++) {
      if (page >= maxPages) throw new JiraFailure("page-limit");
      const data = commentsPage.parse(
        await this.request(
          access,
          `/issue/${before.issueId}/comment?startAt=${seen}&maxResults=${pageSize}`,
        ),
      );
      seen += data.comments.length;
      for (const c of data.comments)
        if (c.author?.accountId === before.accountId) mine.push(Number(c.id));
      if (seen >= data.total) break;
      if (!data.comments.length) throw new JiraFailure("malformed");
    }
    const expected = adfToMarkdown(markdownToAdf(body));
    const marked = [];
    for (let i = 0; i < mine.length; i += pageSize) {
      const listed = commentList.parse(
        await this.request(access, "/comment/list?expand=properties", {
          method: "POST",
          body: { ids: mine.slice(i, i + pageSize) },
        }),
      );
      marked.push(
        ...listed.values.filter((c) =>
          c.properties.some(
            (p) =>
              p.key === markerKey &&
              z
                .object({ operationId: z.literal(record.operationId) })
                .safeParse(p.value).success,
          ),
        ),
      );
    }
    const [comment] = marked;
    return marked.length === 1 &&
      comment &&
      comment.author?.accountId === before.accountId &&
      adfToMarkdown(comment.body) === expected
      ? { nodeId: comment.id }
      : null;
  }

  private async labelsReceipt(
    access: JiraAccess,
    a: Extract<ExternalAction, { kind: "issue.labels" }>,
    before: Before,
  ) {
    const issue = await this.issue(access, a.target, before.issueId);
    // Jira labels are case-sensitive.
    return a.add.every((l) => issue.fields.labels.includes(l)) &&
      a.remove.every((l) => !issue.fields.labels.includes(l))
      ? { nodeId: issue.id, number: a.target.number }
      : null;
  }

  /** The issue shows the status the preflight recorded as the target: the one an independent read proves. */
  private async statusReceipt(
    access: JiraAccess,
    a: Extract<ExternalAction, { kind: "issue.status" }>,
    before: Before,
  ) {
    if (before.targetStatusId !== a.statusId)
      throw new Error("provider-before-state-invalid");
    const issue = await this.issue(access, a.target, before.issueId);
    return issue.fields.status.id === a.statusId
      ? { nodeId: issue.id, number: a.target.number }
      : null;
  }

  /**
   * The issue is Done and exactly one status history since preflight moved it to the recorded
   * target, made by the credential user.
   */
  private async closeReceipt(
    access: JiraAccess,
    a: Extract<ExternalAction, { kind: "issue.close" }>,
    before: Before,
  ) {
    if (
      !before.accountId ||
      !before.targetStatusId ||
      before.changelogHighWater === undefined
    )
      throw new Error("provider-before-state-invalid");
    const issue = await this.issue(access, a.target, before.issueId);
    const since = (await this.changelog(access, issue.id)).filter(
      (h) =>
        Number(h.id) > Number(before.changelogHighWater) &&
        h.items.some((i) => i.field === "status"),
    );
    const [history] = since;
    return isDone(issue) &&
      since.length === 1 &&
      history &&
      history.author?.accountId === before.accountId &&
      movedTo(history, before.targetStatusId)
      ? { nodeId: issue.id, number: a.target.number, issueClosed: true }
      : null;
  }

  async inspectClosedIssue(target: {
    repositoryId: string;
    nodeId: string;
    number: number;
  }): Promise<ClosedIssueInspection> {
    const access = this.resolved();
    const issue = await this.issue(access, target);
    if (!isDone(issue)) return { state: "open" };
    const accountId = await this.accountId(access);
    // The latest move to the status the issue is in now; an earlier closure was reopened.
    const history = (await this.changelog(access, issue.id))
      .filter((h) => movedTo(h, issue.fields.status.id))
      .sort((x, y) => Number(y.id) - Number(x.id))[0];
    const separator = issue.key.lastIndexOf("-");
    return {
      state: "closed",
      snapshot: {
        providerInstance: access.instance,
        nodeId: issue.id,
        repositoryId: issue.fields.project.id,
        repositoryName: issue.key.slice(0, separator),
        number: target.number,
        title: issue.fields.summary,
        body:
          issue.fields.description == null
            ? ""
            : adfToMarkdown(issue.fields.description),
        state: "closed",
        labels: issue.fields.labels,
        status: {
          id: issue.fields.status.id,
          name: issue.fields.status.name,
          categoryKey: issue.fields.status.statusCategory.key,
        },
        projectFields: [],
      },
      closedEvent: history
        ? {
            id: history.id,
            closerKind:
              history.author?.accountId === accountId ? "none" : "other",
            closerPrNodeId: null,
          }
        : null,
    };
  }
}
