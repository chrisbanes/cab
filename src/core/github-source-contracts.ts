import { z } from "zod";
import { sourceCredentialReference } from "./credential-reference.js";
export const nonempty = z.string().trim().min(1).max(512);
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

const conditionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("label"), name: nonempty }).strict(),
  z
    .object({
      kind: z.literal("project-field"),
      projectNodeId: nonempty,
      fieldNodeId: nonempty,
      optionNodeId: nonempty,
    })
    .strict(),
]);

export const readinessSchema = z
  .object({
    mode: z.enum(["all", "any"]),
    conditions: z.array(conditionSchema).min(1).max(20),
  })
  .strict();

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

/** One project-setup repository list: unique ids and unique GitHub identities. */
export const setupRepositoriesSchema = z
  .array(setupRepositorySchema)
  .max(20)
  .refine(
    (values) =>
      new Set(values.map((value) => value.repositoryId)).size === values.length,
    "Repository IDs must be unique",
  )
  .refine(
    (values) =>
      new Set(
        values.map((value) => `${value.owner}/${value.name}`.toLowerCase()),
      ).size === values.length,
    "Repositories must be unique",
  );

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
    readiness: readinessSchema,
    repositories: z
      .array(repositoryLinkSchema)
      .max(20)
      .refine(
        (values) =>
          new Set(values.map((value) => value.repositoryId)).size ===
          values.length,
        "Repository IDs must be unique",
      ),
  })
  .strict();

export const githubConfigurationCommandSchema =
  githubConfigurationSchema.extend({
    selections: z
      .array(z.union([selectionSchema, selectionKeepSchema]))
      .max(30)
      .refine(
        (values) =>
          new Set(values.map((value) => value.id)).size === values.length,
        "Selection IDs must be unique",
      ),
    repositories: z
      .array(repositoryLinkInputSchema)
      .max(20)
      .refine(
        (values) =>
          new Set(values.map((value) => value.repositoryId)).size ===
          values.length,
        "Repository IDs must be unique",
      ),
  });

export type GitHubConfigurationInput = z.input<
  typeof githubConfigurationSchema
>;
export type GitHubSelection = z.output<typeof selectionSchema>;
