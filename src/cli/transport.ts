import { randomUUID } from "node:crypto";
import type { z } from "zod";
import {
  apiErrorSchema,
  type CliIdentity,
  cliIdentitySchema,
} from "../operator/contracts.js";
import { CliError } from "./connections.js";

export const API_VERSION = 1;

/** Accepts only `https://host[:port]` or the service's loopback `http://127.0.0.1:port`. */
export function connectionOrigin(value: string): string {
  let url: URL | undefined;
  try {
    url = new URL(value);
  } catch {
    url = undefined;
  }
  if (
    !url ||
    url.origin !== value ||
    url.username ||
    url.password ||
    !(
      url.protocol === "https:" ||
      (url.protocol === "http:" && url.hostname === "127.0.0.1" && url.port)
    )
  )
    throw new CliError(
      "invalid-url",
      "Use an https:// origin or http://127.0.0.1:PORT, without a path.",
    );
  return url.origin;
}

function transportFailure(error: unknown, requestId: string): CliError {
  const code = String(
    (error as { cause?: { code?: unknown } })?.cause?.code ?? "",
  );
  return /CERT|TLS|SSL|SELF_SIGNED|VERIFY/.test(code)
    ? new CliError(
        "tls-verification-failed",
        "The service certificate could not be verified. For a private CA set NODE_EXTRA_CA_CERTS.",
        { requestId, retryable: false },
      )
    : new CliError("unavailable", "The service is unavailable.", {
        requestId,
        retryable: true,
      });
}

export class ServiceClient {
  constructor(
    readonly origin: string,
    private readonly token: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async get<T>(path: string, schema: z.ZodType<T>): Promise<T> {
    const requestId = randomUUID();
    let response: Response;
    try {
      response = await this.fetcher(`${this.origin}${path}`, {
        // Never follow a redirect: it would forward the bearer credential.
        redirect: "manual",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${this.token}`,
          "x-ensemble-request-id": requestId,
        },
      });
    } catch (error) {
      throw transportFailure(error, requestId);
    }
    if (
      response.type === "opaqueredirect" ||
      (response.status >= 300 && response.status < 400)
    )
      throw new CliError(
        "redirect-rejected",
        "The service redirected the request; credentials are never forwarded.",
        { requestId, retryable: false },
      );
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = undefined;
    }
    if (!response.ok) {
      const parsed = apiErrorSchema.safeParse(body);
      const code = parsed.success ? parsed.data.error.code : undefined;
      if (response.status >= 500 || !code)
        throw new CliError("unavailable", "The service is unavailable.", {
          requestId,
          retryable: response.status >= 500,
        });
      throw new CliError(code, parsed.data?.error.message ?? code, {
        requestId,
        retryable: false,
        status: response.status,
      });
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success)
      throw new CliError(
        "unsupported-service",
        "The service response is not supported by this CLI.",
        { requestId },
      );
    return parsed.data;
  }

  /** Negotiates API version and capabilities before any other read. */
  async identity(required: readonly string[]): Promise<CliIdentity> {
    const identity = await this.get("/api/operator/cli", cliIdentitySchema);
    if (
      identity.apiVersion !== API_VERSION ||
      required.some((c) => !identity.capabilities.includes(c))
    )
      throw new CliError(
        "unsupported-service",
        `The service API (version ${identity.apiVersion}) is not supported by this CLI.`,
      );
    return identity;
  }
}
