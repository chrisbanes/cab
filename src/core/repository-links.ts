import { z } from "zod";
import {
  isGitLabProjectPath,
  linkedRepositorySchema,
} from "./github-source.js";
import {
  repositoryLinkInputSchema,
  setupRepositorySchema,
} from "./github-source-contracts.js";

/** A DNS hostname without port or userinfo. `github.com` belongs to GitHub links only. */
export const gitLabHostSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(253)
  .regex(
    /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/,
  )
  .refine((host) => host !== "github.com");
export const gitLabProjectPathSchema = z.string().refine(isGitLabProjectPath);
/** A GitLab numeric project ID, operator-supplied until discovery verifies it. */
export const gitLabRepositoryId = z.string().regex(/^[1-9][0-9]{0,18}$/);

/**
 * A project's linked repository as stored: the verified checkout plus the code host
 * and host name that identify the repository. GitHub is `github.com`; GitLab is a
 * configured host with the project's full path.
 */
export const storedRepositoryLinkSchema = z.discriminatedUnion("codeHost", [
  linkedRepositorySchema
    .extend({ codeHost: z.literal("github"), host: z.literal("github.com") })
    .strict(),
  linkedRepositorySchema
    .extend({
      codeHost: z.literal("gitlab"),
      host: gitLabHostSchema,
      projectPath: gitLabProjectPathSchema,
      repositoryId: gitLabRepositoryId,
    })
    .strict(),
]);
export type StoredRepositoryLink = z.output<typeof storedRepositoryLinkSchema>;

/**
 * Command-only: a link without `path` keeps the saved path for that repository, and a
 * GitLab link without `projectPath` keeps the saved project path.
 */
const repositoryLinkCommandInputSchema = z.discriminatedUnion("codeHost", [
  repositoryLinkInputSchema
    .extend({ codeHost: z.literal("github"), host: z.literal("github.com") })
    .strict(),
  repositoryLinkInputSchema
    .extend({
      codeHost: z.literal("gitlab"),
      host: gitLabHostSchema,
      projectPath: gitLabProjectPathSchema.optional(),
      repositoryId: gitLabRepositoryId,
    })
    .strict(),
]);

/**
 * Repository IDs are unique across all links, and GitLab links are unique by host and
 * project path, ignoring case.
 * shortcut: two GitLab hosts whose projects share a numeric ID cannot both be linked to
 * one project, because the ID keys workspaces and delivery; revisit if that is needed.
 */
const uniqueLinks = <
  T extends {
    repositoryId: string;
    host: string;
    projectPath?: string | undefined;
  },
>(
  schema: z.ZodType<T[]>,
) =>
  schema
    .refine(
      (values) =>
        new Set(values.map((value) => value.repositoryId)).size ===
        values.length,
      "Repository IDs must be unique",
    )
    .refine((values) => {
      const gitlab = values.flatMap((value) =>
        value.projectPath === undefined
          ? []
          : [`${value.host}/${value.projectPath.toLowerCase()}`],
      );
      return new Set(gitlab).size === gitlab.length;
    }, "GitLab repositories must be unique");

export const repositoryLinkListSchema = uniqueLinks(
  z.array(storedRepositoryLinkSchema).max(20),
);

export const repositoriesConfigurationCommandSchema = z
  .object({
    repositories: uniqueLinks(
      z.array(repositoryLinkCommandInputSchema).max(20),
    ),
  })
  .strict();

export const repositoriesConfigurationCommandResultSchema = z
  .object({
    version: z.number().int().positive(),
    repositories: repositoryLinkListSchema,
  })
  .strict();

/**
 * Setup-only GitLab row: the project identity its checkout's `origin` must match. A GitHub
 * row (`setupRepositorySchema`) carries no `codeHost`, so existing payloads are unchanged.
 */
const setupGitLabRepositorySchema = setupRepositorySchema
  .extend({
    codeHost: z.literal("gitlab"),
    host: gitLabHostSchema,
    projectPath: gitLabProjectPathSchema,
    repositoryId: gitLabRepositoryId,
  })
  .omit({ owner: true, name: true })
  .strict();

/** One project-setup repository list: unique ids and unique repository identities. */
export const setupRepositoriesSchema = z
  .array(
    z.discriminatedUnion("codeHost", [
      setupRepositorySchema.extend({ codeHost: z.undefined().optional() }),
      setupGitLabRepositorySchema,
    ]),
  )
  .max(20)
  .refine(
    (values) =>
      new Set(values.map((value) => value.repositoryId)).size === values.length,
    "Repository IDs must be unique",
  )
  .refine(
    (values) =>
      new Set(
        values.map((value) =>
          value.codeHost === "gitlab"
            ? `gitlab:${value.host}/${value.projectPath}`.toLowerCase()
            : `${value.owner}/${value.name}`.toLowerCase(),
        ),
      ).size === values.length,
    "Repositories must be unique",
  );
