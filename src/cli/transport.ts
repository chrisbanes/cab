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

/** Failures before any byte was sent: the request never reached the service. */
const NOT_SENT = /^(?:ECONNREFUSED|ENOTFOUND|EAI_AGAIN)$/;
const TLS_FAILURE = /CERT|TLS|SSL|SELF_SIGNED|VERIFY/;

function transportFailure(
  error: unknown,
  requestId: string,
  origin: string,
): CliError {
  const code = String(
    (error as { cause?: { code?: unknown } })?.cause?.code ?? "",
  );
  // A failed TLS handshake happens before the HTTP request is written.
  return TLS_FAILURE.test(code)
    ? new CliError(
        "tls-verification-failed",
        "The service certificate could not be verified. For a private CA set NODE_EXTRA_CA_CERTS.",
        { requestId, retryable: false, notSent: true },
      )
    : new CliError("unavailable", "The service is unavailable.", {
        requestId,
        retryable: true,
        fix: `Check that the service at ${origin} is running, or check the URL with 'ensemble connection list'.`,
        ...(NOT_SENT.test(code) ? { notSent: true } : {}),
      });
}

export class ServiceClient {
  constructor(
    readonly origin: string,
    private readonly token: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  /** One GET with redirects refused; the caller reads the body of a 2xx response. */
  private async request(path: string, accept: string) {
    const requestId = randomUUID();
    let response: Response;
    try {
      response = await this.fetcher(`${this.origin}${path}`, {
        // Never follow a redirect: it would forward the bearer credential.
        redirect: "manual",
        headers: {
          accept,
          authorization: `Bearer ${this.token}`,
          "x-ensemble-request-id": requestId,
        },
      });
    } catch (error) {
      throw transportFailure(error, requestId, this.origin);
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
    if (!response.ok) {
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        body = undefined;
      }
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
    return { response, requestId };
  }

  async get<T>(path: string, schema: z.ZodType<T>): Promise<T> {
    const { response, requestId } = await this.request(
      path,
      "application/json",
    );
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = undefined;
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

  /** A successful response body as bytes, with its content type and headers. */
  async getBytes(
    path: string,
  ): Promise<{ body: Buffer; type: string; headers: Headers }> {
    const { response } = await this.request(path, "*/*");
    return {
      body: Buffer.from(await response.arrayBuffer()),
      type: response.headers.get("content-type") ?? "application/octet-stream",
      headers: response.headers,
    };
  }

  /**
   * POSTs one operator command. Definite not-applied failures (refused connection, DNS,
   * TLS verification, a redirect, any 4xx) keep their codes; anything after the request
   * may have been sent (other transport failures, timeout, 5xx, unreadable 2xx) is
   * `command-outcome-unknown`. Returns the parsed 2xx body.
   */
  async command(body: string, timeoutMs: number): Promise<unknown> {
    const requestId = randomUUID();
    const unknown = () =>
      new CliError(
        "command-outcome-unknown",
        "The service may or may not have applied the command.",
        { requestId, retryable: true },
      );
    let response: Response;
    try {
      response = await this.fetcher(`${this.origin}/api/operator/commands`, {
        method: "POST",
        redirect: "manual",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          authorization: `Bearer ${this.token}`,
          "x-ensemble-request-id": requestId,
        },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const code = String(
        (error as { cause?: { code?: unknown } })?.cause?.code ?? "",
      );
      // Only failures before any byte was sent prove the command was not applied.
      if (NOT_SENT.test(code) || TLS_FAILURE.test(code))
        throw transportFailure(error, requestId, this.origin);
      throw unknown();
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
    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      parsed = undefined;
    }
    if (response.status >= 500) throw unknown();
    if (!response.ok) {
      const error = apiErrorSchema.safeParse(parsed);
      const code = error.success ? error.data.error.code : "rejected";
      const paths = error.success ? (error.data.error.fieldPaths ?? []) : [];
      throw new CliError(
        // On the command route `forbidden` is a domain policy denial, not authentication.
        code === "forbidden" ? "policy-denied" : code,
        `${error.success ? error.data.error.message : `The service rejected the command (${response.status}).`}${paths.length ? ` Fields: ${paths.join(", ")}` : ""}`,
        {
          requestId,
          retryable: false,
          status: response.status,
          ...(error.success && error.data.error.credentialReason
            ? { credentialReason: error.data.error.credentialReason }
            : {}),
        },
      );
    }
    if (parsed === undefined) throw unknown();
    return parsed;
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
