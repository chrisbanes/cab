import { z } from "zod";
import { adfToMarkdown } from "../core/adf-markdown.js";
import type {
  IssueSnapshot,
  SelectionSnapshot,
} from "../core/github-source.js";
import type { JiraSelection } from "../core/github-source-contracts.js";
import type { resolveJiraAccess } from "./jira-credential.js";
import {
  type JiraAccess,
  JiraFailure,
  jiraMessages,
  jiraRequest,
} from "./jira-http.js";

const pageSize = 100;
const maxPages = 100;
const previewSize = 20;
const searchFields = ["summary", "status", "labels", "description", "project"];
// The link type whose inward side reads "is blocked by": the linked issue blocks this one.
const blockedByLink = "is blocked by";

const issueSchema = z
  .object({
    id: z.string().regex(/^\d{1,20}$/),
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
        // Absent from a preview, which does not request it; a selection read requires it.
        issuelinks: z
          .array(
            z
              .object({
                type: z.object({ inward: z.string() }).passthrough(),
                // Only a blocker link's linked issue is read, and strictly.
                inwardIssue: z.unknown().optional(),
              })
              .passthrough(),
          )
          .optional(),
      })
      .passthrough(),
  })
  .passthrough();
const blockerSchema = z
  .object({
    id: z.string().regex(/^\d{1,20}$/),
    key: issueSchema.shape.key,
    fields: z
      .object({
        status: z
          .object({
            statusCategory: z.object({ key: z.string().min(1) }).passthrough(),
          })
          .passthrough(),
      })
      .passthrough(),
  })
  .passthrough();
const selectValueSchema = z
  .object({ id: z.string().min(1), value: z.string() })
  .passthrough();
const searchSchema = z
  .object({
    issues: z.array(issueSchema),
    nextPageToken: z.string().min(1).optional(),
  })
  .passthrough();
const parseSchema = z
  .object({
    queries: z
      .array(
        z.object({ errors: z.array(z.unknown()).optional() }).passthrough(),
      )
      .length(1),
  })
  .passthrough();

/** A Jira Cloud site's JQL reads; the credential is resolved on every call. */
export class JiraSourceReader {
  constructor(
    private readonly access: () => ReturnType<typeof resolveJiraAccess>,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  private resolved(): JiraAccess {
    const access = this.access();
    if ("reason" in access) throw new JiraFailure(access.reason);
    return access;
  }

  private async search(
    access: JiraAccess,
    jql: string,
    maxResults: number,
    fields: string[],
    nextPageToken?: string,
  ) {
    const page = searchSchema.safeParse(
      await jiraRequest(this.fetcher, access, "/search/jql", {
        method: "POST",
        body: {
          jql,
          fields,
          maxResults,
          ...(nextPageToken ? { nextPageToken } : {}),
        },
      }),
    );
    if (!page.success) throw new JiraFailure("malformed");
    return page.data;
  }

  /**
   * Every issue the selection's JQL matches, or an incomplete read with a stable reason.
   * `fieldIds` are the custom fields a readiness rule needs; links arrive in the same read.
   */
  async readSelection(
    selection: JiraSelection,
    fieldIds: readonly string[] = [],
  ): Promise<SelectionSnapshot> {
    const issues: IssueSnapshot[] = [];
    // Stamped on each issue: a read that overlaps a status write must not look newer than it.
    const startedAt = Date.now();
    try {
      const access = this.resolved();
      const fields = [...searchFields, "issuelinks", ...fieldIds];
      const tokens = new Set<string>();
      let token: string | undefined;
      for (let page = 0; ; page++) {
        if (page >= maxPages) throw new JiraFailure("page-limit");
        const result = await this.search(
          access,
          selection.jql,
          pageSize,
          fields,
          token,
        );
        for (const issue of result.issues)
          issues.push({
            ...snapshot(access.instance, issue, fieldIds),
            projectReadAt: startedAt,
          });
        token = result.nextPageToken;
        if (!token) return { complete: true, issues, reason: null };
        if (tokens.has(token)) throw new JiraFailure("malformed");
        tokens.add(token);
      }
    } catch (error) {
      return {
        complete: false,
        issues,
        reason: error instanceof JiraFailure ? error.reason : "reader-error",
        ...(error instanceof JiraFailure && error.resumeAt !== undefined
          ? { resumeAt: error.resumeAt }
          : {}),
      };
    }
  }

  /** Jira's strict JQL validation: no messages when the query is valid. */
  async parseJql(jql: string): Promise<string[]> {
    const access = this.resolved();
    try {
      const parsed = parseSchema.safeParse(
        await jiraRequest(
          this.fetcher,
          access,
          "/jql/parse?validation=strict",
          { method: "POST", body: { queries: [jql] } },
        ),
      );
      if (!parsed.success) throw new JiraFailure("malformed");
      return jiraMessages(parsed.data.queries[0]?.errors ?? []);
    } catch (error) {
      // A rejected query is an answer about the JQL, not a failed read.
      if (error instanceof JiraFailure && error.reason === "jql-invalid")
        return error.messages.length ? [...error.messages] : ["Invalid JQL"];
      throw error;
    }
  }

  /** Up to 20 matches of a valid query, without saving anything. */
  async preview(jql: string) {
    const access = this.resolved();
    const result = await this.search(access, jql, previewSize, searchFields);
    return {
      matches: result.issues.slice(0, previewSize).map((issue) => ({
        key: issue.key,
        title: issue.fields.summary.slice(0, 512),
        status: issue.fields.status.name.slice(0, 255),
      })),
      more: result.nextPageToken !== undefined,
    };
  }
}

const keyParts = (key: string) => {
  const separator = key.lastIndexOf("-");
  return {
    project: key.slice(0, separator),
    number: Number(key.slice(separator + 1)),
  };
};

/** The issues an issue "is blocked by"; any other link type or direction is ignored. */
function blockedBy(
  instance: string,
  links: NonNullable<z.output<typeof issueSchema>["fields"]["issuelinks"]>,
): IssueSnapshot[] {
  return links.flatMap((link) => {
    if (
      link.type.inward.trim().toLowerCase() !== blockedByLink ||
      link.inwardIssue === undefined
    )
      return [];
    const parsed = blockerSchema.safeParse(link.inwardIssue);
    // A blocker that cannot be read must not be skipped: the whole read is malformed.
    if (!parsed.success) throw new JiraFailure("malformed");
    const { project, number } = keyParts(parsed.data.key);
    return [
      {
        providerInstance: instance,
        nodeId: parsed.data.id,
        // The link carries no project ID, so the key stands in; identity is the issue ID.
        repositoryId: project,
        repositoryName: project,
        number,
        title: "",
        body: "",
        state:
          parsed.data.fields.status.statusCategory.key === "done"
            ? ("closed" as const)
            : ("open" as const),
        labels: [],
        projectFields: [],
      },
    ];
  });
}

function snapshot(
  instance: string,
  issue: z.output<typeof issueSchema>,
  fieldIds: readonly string[],
): IssueSnapshot {
  const { project, number } = keyParts(issue.key);
  if (issue.fields.issuelinks === undefined) throw new JiraFailure("malformed");
  return {
    providerInstance: instance,
    nodeId: issue.id,
    repositoryId: issue.fields.project.id,
    repositoryName: project,
    number,
    title: issue.fields.summary,
    body:
      issue.fields.description == null
        ? ""
        : adfToMarkdown(issue.fields.description),
    state:
      issue.fields.status.statusCategory.key === "done" ? "closed" : "open",
    labels: issue.fields.labels,
    status: {
      id: issue.fields.status.id,
      name: issue.fields.status.name,
      categoryKey: issue.fields.status.statusCategory.key,
    },
    // A single-select value is `{id, value}`; null, a list or any other shape is no value.
    selectFields: fieldIds.flatMap((fieldId) => {
      const value = selectValueSchema.safeParse(issue.fields[fieldId]);
      return value.success
        ? [{ fieldId, optionId: value.data.id, name: value.data.value }]
        : [];
    }),
    blockedBy: blockedBy(instance, issue.fields.issuelinks),
    projectFields: [],
  };
}
