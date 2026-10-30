import { z } from "zod";
import { sourceCredentialReference } from "./credential-reference.js";
export const nonempty = z.string().trim().min(1).max(512);

/** The provider and instance every GitHub task-source row is stored under (ADR-1020). */
export const githubIssueTracker = {
  provider: "github",
  instance: "github.com",
} as const;
export const projectFieldsSchema = z.array(
  z
    .object({
      projectNodeId: nonempty,
      fieldNodeId: nonempty,
      optionNodeId: nonempty,
    })
    .strict(),
);

export const selectionSchema = z.discriminatedUnion("kind", [
  z
    .object({
      id: nonempty,
      kind: z.literal("repository"),
      repositoryId: nonempty,
      owner: nonempty,
      name: nonempty,
    })
    .strict(),
  z
    .object({ id: nonempty, kind: z.literal("search"), query: nonempty })
    .strict(),
  z
    .object({
      id: nonempty,
      kind: z.literal("project"),
      projectNodeId: nonempty,
      filter: z.string().max(4096),
    })
    .strict(),
]);

/** A Jira Cloud site: a DNS hostname without port or userinfo, stored as the source `instance`. */
export const jiraInstanceSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(253)
  .regex(
    /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/,
  );

/** A Jira Cloud selection: the issues a JQL query matches. */
export const jiraSelectionSchema = z
  .object({
    id: nonempty,
    kind: z.literal("jql"),
    jql: z.string().trim().min(1).max(4096),
  })
  .strict();

const labelCondition = z
  .object({
    kind: z.literal("label"),
    operator: z.enum(["has", "lacks"]),
    name: nonempty,
  })
  .strict();
const uniqueIds = (ids: string[]) => new Set(ids).size === ids.length;
const projectFieldCondition = z
  .object({
    kind: z.literal("project-field"),
    projectNodeId: nonempty,
    fieldNodeId: nonempty,
    operator: z.enum(["in", "not-in"]),
    optionNodeIds: z.array(nonempty).min(1).max(256).refine(uniqueIds, {
      message: "optionNodeIds must be unique",
    }),
  })
  .strict();
const statusCondition = z
  .object({
    kind: z.literal("status"),
    operator: z.enum(["in", "not-in"]),
    statusIds: z.array(nonempty).min(1).max(256).refine(uniqueIds, {
      message: "statusIds must be unique",
    }),
  })
  .strict();
const selectFieldCondition = z
  .object({
    kind: z.literal("select-field"),
    fieldId: z.string().regex(/^customfield_\d{1,20}$/),
    operator: z.enum(["in", "not-in"]),
    optionIds: z.array(nonempty).min(1).max(256).refine(uniqueIds, {
      message: "optionIds must be unique",
    }),
  })
  .strict();

/** Every stored condition kind; a tracker's own schema below limits what it may save. */
export const readinessConditionSchema = z.discriminatedUnion("kind", [
  labelCondition,
  projectFieldCondition,
  statusCondition,
  selectFieldCondition,
]);

const ruleOf = <C extends z.ZodType>(condition: C) =>
  z
    .object({
      mode: z.enum(["all", "any"]),
      conditions: z.array(condition).min(1).max(20),
    })
    .strict();

/** The stored rule, whichever tracker saved it. */
export const readinessSchema = ruleOf(readinessConditionSchema);
/** What a GitHub source may save. */
export const githubReadinessSchema = ruleOf(
  z.discriminatedUnion("kind", [labelCondition, projectFieldCondition]),
);
/** What a Jira source may save. */
export const jiraReadinessSchema = ruleOf(
  z.discriminatedUnion("kind", [
    labelCondition,
    statusCondition,
    selectFieldCondition,
  ]),
);
export type Readiness = z.output<typeof readinessSchema>;
export type GitHubReadiness = z.output<typeof githubReadinessSchema>;
export type ReadinessCondition = z.output<typeof readinessConditionSchema>;
type ProjectField = z.output<typeof projectFieldsSchema>[number];

/** GitHub matches label names case-insensitively. */
export const hasLabelName = (
  labels: readonly string[],
  name: string,
): boolean => labels.some((l) => l.toLowerCase() === name.toLowerCase());

/**
 * The readiness predicate over one issue's labels, Project fields, and (Jira) status and
 * select fields. An unobserved status or field never satisfies a condition. A `null` rule
 * filters nothing. `unmet` lists the unsatisfied conditions (all) or, when none is
 * satisfied, every condition (any).
 */
export function evaluateReadiness(
  rule: Readiness | null,
  facts: {
    labels: readonly string[];
    fields: readonly ProjectField[];
    status?: string | null;
    selectFields?: readonly { fieldId: string; optionId: string }[];
  },
): { satisfied: boolean; unmet: ReadinessCondition[] } {
  if (!rule) return { satisfied: true, unmet: [] };
  const unmet = rule.conditions.filter((c) => {
    if (c.kind === "label")
      return hasLabelName(facts.labels, c.name) !== (c.operator === "has");
    if (c.kind === "status") {
      const status = facts.status ?? null;
      return c.operator === "in"
        ? status === null || !c.statusIds.includes(status)
        : status === null || c.statusIds.includes(status);
    }
    const [ids, held] =
      c.kind === "select-field"
        ? [
            c.optionIds,
            (facts.selectFields ?? [])
              .filter((f) => f.fieldId === c.fieldId)
              .map((f) => f.optionId),
          ]
        : [
            c.optionNodeIds,
            facts.fields
              .filter(
                (f) =>
                  f.projectNodeId === c.projectNodeId &&
                  f.fieldNodeId === c.fieldNodeId,
              )
              .map((f) => f.optionNodeId),
          ];
    // `not-in` needs a value: an item with none, or outside the Project, is unmet.
    return c.operator === "in"
      ? !held.some((id) => ids.includes(id))
      : !held.length || held.some((id) => ids.includes(id));
  });
  const satisfied =
    rule.mode === "all"
      ? unmet.length === 0
      : unmet.length < rule.conditions.length;
  return { satisfied, unmet: satisfied ? [] : unmet };
}

/** How a GitHub source treats issues closed on GitHub. */
export const closedIssuesSchema = z.enum(["skip", "done"]);

export const repositoryLinkSchema = z
  .object({
    repositoryId: nonempty,
    path: z.string().trim().min(1),
    ref: nonempty,
  })
  .strict();

/** Setup-only: a repository link with the GitHub identity its checkout's origin must match. */
export const setupRepositorySchema = repositoryLinkSchema.extend({
  owner: z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/),
  name: z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/),
  path: z.string().trim().min(1).max(4096),
  // Never an option to git, and no whitespace or control characters.
  ref: z
    .string()
    .min(1)
    .max(255)
    .regex(/^[^-\s\p{Cc}][^\s\p{Cc}]*$/u),
});

/** Command-only: keep a saved selection by id without re-sending its private definition. */
export const selectionKeepSchema = z
  .object({ id: nonempty, keep: z.literal(true) })
  .strict();

/** Command-only: a link without `path` keeps the saved path for that repository. */
export const repositoryLinkInputSchema = repositoryLinkSchema.extend({
  path: repositoryLinkSchema.shape.path.optional(),
});

export const githubConfigurationSchema = z
  .object({
    credentialRef: sourceCredentialReference.nullable(),
    selections: z
      .array(selectionSchema)
      .max(30)
      .refine(
        (values) =>
          new Set(values.map((value) => value.id)).size === values.length,
        "Selection IDs must be unique",
      ),
    /** `null` is no readiness rule: open issues in active selections are not filtered. */
    readiness: githubReadinessSchema.nullable(),
    closedIssues: closedIssuesSchema,
  })
  .strict();

export const githubConfigurationCommandSchema =
  githubConfigurationSchema.extend({
    /** Omitted keeps the saved mode, so older clients and replays cannot reset it. */
    closedIssues: closedIssuesSchema.optional(),
    selections: z
      .array(z.union([selectionSchema, selectionKeepSchema]))
      .max(30)
      .refine(
        (values) =>
          new Set(values.map((value) => value.id)).size === values.length,
        "Selection IDs must be unique",
      ),
    /**
     * Repository links are project configuration (`repositories.configure`). Only commands
     * recorded before the move carry this field, so they still parse and replay; a new one
     * is refused.
     */
    repositories: z.array(repositoryLinkInputSchema).max(20).optional(),
  });

export type GitHubConfigurationInput = z.input<
  typeof githubConfigurationSchema
>;
export type GitHubSelection = z.output<typeof selectionSchema>;

/** A Jira project's whole source configuration: its site and JQL selections, all active when saved. */
export const jiraConfigurationSchema = z
  .object({
    instance: jiraInstanceSchema,
    selections: z
      .array(jiraSelectionSchema)
      .max(30)
      .refine(
        (values) =>
          new Set(values.map((value) => value.id)).size === values.length,
        "Selection IDs must be unique",
      ),
    /** `null` is no readiness rule: every issue the selections match is Ready. */
    readiness: jiraReadinessSchema.nullable(),
  })
  .strict();
export type JiraSelection = z.output<typeof jiraSelectionSchema>;
