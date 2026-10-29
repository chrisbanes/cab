import { z } from "zod";
import { linkedRepositorySchema } from "./github-source.js";
import { repositoryLinkInputSchema } from "./github-source-contracts.js";

/**
 * A project's linked repository as stored: the verified checkout plus the code host
 * and host name that identify the repository. Only GitHub on `github.com` is supported.
 */
export const storedRepositoryLinkSchema = linkedRepositorySchema
  .extend({ codeHost: z.literal("github"), host: z.literal("github.com") })
  .strict();
export type StoredRepositoryLink = z.output<typeof storedRepositoryLinkSchema>;

/** Command-only: a link without `path` keeps the saved path for that repository. */
const repositoryLinkCommandInputSchema = repositoryLinkInputSchema
  .extend({ codeHost: z.literal("github"), host: z.literal("github.com") })
  .strict();

export const repositoryLinkListSchema = z
  .array(storedRepositoryLinkSchema)
  .max(20)
  .refine(
    (values) =>
      new Set(values.map((value) => value.repositoryId)).size === values.length,
    "Repository IDs must be unique",
  );

export const repositoriesConfigurationCommandSchema = z
  .object({
    repositories: z
      .array(repositoryLinkCommandInputSchema)
      .max(20)
      .refine(
        (values) =>
          new Set(values.map((value) => value.repositoryId)).size ===
          values.length,
        "Repository IDs must be unique",
      ),
  })
  .strict();

export const repositoriesConfigurationCommandResultSchema = z
  .object({
    version: z.number().int().positive(),
    repositories: repositoryLinkListSchema,
  })
  .strict();
