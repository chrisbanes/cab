import { validateNetworkSettings } from "../operator/network-access.js";
import type { LocalAccess } from "../operator/local-access.js";
import { cabFaviconSvg } from "../operator/brand.js";
import {
  genericInvalidInputMessage,
  questionCommandRawLimit,
} from "../operator/contracts.js";
import type { OperatorWebBoundary } from "./operator-web.js";
import {
  OperatorApiError,
  type OperatorReviewSessionContext,
} from "./operator-api.js";
import {
  apiErrorSchema,
  cliCapabilities,
  cliIdentitySchema,
  operatorCredentialIssueRequestSchema,
  operatorCredentialIssuedSchema,
  operatorCredentialListSchema,
  pushNotificationsReadSchema,
  pushSubscriptionResultSchema,
  pushTestResultSchema,
  sessionSchema,
} from "../operator/contracts.js";
import {
  OperatorCredentialError,
  operatorRouteAuthority,
  type OperatorCredentialStore,
  type VerifiedOperatorCredential,
} from "./operator-credentials.js";
import type { OperatorPush } from "./operator-push.js";
import { PushError } from "./web-push.js";
import { z } from "zod";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { OperatorAuth, OperatorSession } from "./operator-auth.js";
import { sourceCredentialExplanation } from "./github-source-credential.js";
import { containsControlCharacters, decodeSegment } from "./operator-routes.js";

type OperatorHttpOptions = {
  web: OperatorWebBoundary;
  lan?: { address: string; origin?: string | undefined };
  credentials?: OperatorCredentialStore;
  localAccess?: LocalAccess | undefined;
  /** Opt-in browser push; absent, notification routes answer 404. */
  push?: OperatorPush;
};
const SESSION_COOKIE = "cab_operator_session";
const CREDENTIAL_ACTION =
  /^\/api\/operator\/credentials\/([^/]+)\/(rotate|revoke)$/;
const PUSH_ACTION =
  /^\/api\/operator\/notifications\/subscriptions\/([^/]+)\/(revoke|test)$/;
const MAX_JSON_BYTES = 64 * 1024;
const RESPONSE_HEADERS = {
  "cache-control": "no-store",
  "content-security-policy":
    "default-src 'none'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self'; form-action 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'",
  "referrer-policy": "same-origin",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
};
class OperatorHttpError extends Error {
  constructor(readonly status: number) {
    super();
  }
}

function cookieId(request: IncomingMessage, name: string): string | undefined {
  const header = request.headers.cookie;
  if (typeof header !== "string") return undefined;
  const values = header
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${name}=`));
  if (values.length !== 1) return undefined;
  const value = values[0]?.slice(name.length + 1);
  return value && /^[A-Za-z0-9_-]{43}$/.test(value) ? value : undefined;
}

function cookieHeader(id: string, secure: boolean, name: string): string {
  return `${name}=${id}; Path=/; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}`;
}

function clearedCookie(secure: boolean, name: string): string {
  return `${name}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? "; Secure" : ""}`;
}

function publicMessage(code: string): string {
  const messages: Record<string, string> = {
    unauthenticated: "Sign in required.",
    forbidden: "Request denied.",
    "not-found": "Not found.",
    "method-not-allowed": "Method not allowed.",
    "invalid-input": genericInvalidInputMessage,
    "unsupported-media": "JSON input required.",
    "body-too-large": "Request is too large.",
    conflict:
      "Saved state conflicts with this request. Review before retrying.",
    unavailable: "Service unavailable. Try again.",
    "redaction-limit":
      "Too much private material to redact safely. Contact the operator.",
    "command-outcome-unknown":
      "Command outcome is unknown. Reconcile the same key and input.",
    "local-review-batch-too-large":
      "The review is too large to send. Shorten or remove comments.",
    "local-review-recipient-unavailable":
      "The project lead cannot receive reviews now.",
    "local-review-comment-anchor-required":
      "Every review comment needs exact line context. Remove unanchored comments.",
    "credential-invalid": "Operator credential is invalid.",
    "insufficient-scope":
      "Operator credential scope does not allow this request.",
  };
  return messages[code] ?? "Request unavailable.";
}
const API_HEADERS = {
  ...RESPONSE_HEADERS,
  "content-security-policy":
    "default-src 'none'; script-src 'self'; worker-src 'self'; connect-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; form-action 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'",
};

function writeJson(
  response: ServerResponse,
  status: number,
  value: unknown,
  extra: Record<string, string> = {},
): void {
  response.writeHead(status, {
    ...API_HEADERS,
    "content-type": "application/json; charset=utf-8",
    ...extra,
  });
  response.end(JSON.stringify(value));
}

function apiError(code: string) {
  return apiErrorSchema.parse({
    error: { code, message: publicMessage(code) },
  });
}

/** Maps an API handler failure to its public JSON error response. */
function apiFailure(
  error: unknown,
  method: string | undefined,
): { status: number; body: unknown } {
  if (error instanceof OperatorCredentialError)
    error = new OperatorApiError(
      error.code === "not-found" ? 404 : 409,
      error.code,
    );
  if (error instanceof PushError)
    error = new OperatorApiError(
      {
        "invalid-input": 400,
        "not-found": 404,
        conflict: 409,
        unavailable: 503,
      }[error.code],
      error.code,
    );
  const status =
    error instanceof OperatorApiError
      ? error.status
      : error instanceof OperatorHttpError
        ? error.status
        : error instanceof z.ZodError
          ? 400
          : 503;
  const code =
    error instanceof OperatorApiError
      ? error.code
      : error instanceof OperatorHttpError
        ? ({
            400: "invalid-input",
            413: "body-too-large",
            415: "unsupported-media",
          }[error.status] ?? "invalid-input")
        : error instanceof z.ZodError
          ? "invalid-input"
          : method === "POST"
            ? "command-outcome-unknown"
            : "unavailable";
  return {
    status,
    body: apiErrorSchema.parse({
      error: {
        code,
        ...(error instanceof OperatorApiError && error.fieldPaths
          ? { fieldPaths: error.fieldPaths }
          : {}),
        ...(error instanceof OperatorApiError && error.credentialReason
          ? { credentialReason: error.credentialReason }
          : {}),
        message:
          error instanceof OperatorApiError && error.credentialReason
            ? sourceCredentialExplanation(error.credentialReason)
            : error instanceof OperatorApiError && error.publicMessage
              ? error.publicMessage
              : publicMessage(code),
        ...(error instanceof z.ZodError
          ? {
              fieldPaths: [
                ...new Set(
                  error.issues
                    .map((i) =>
                      i.path
                        .filter(
                          (p) =>
                            typeof p === "string" &&
                            /^[A-Za-z][A-Za-z0-9]*$/.test(p),
                        )
                        .join("."),
                    )
                    .filter(Boolean),
                ),
              ],
            }
          : {}),
      },
    }),
  };
}

async function readJson(
  request: IncomingMessage,
  commands = false,
): Promise<unknown> {
  if (
    !/^application\/json(?:;\s*charset=utf-8)?$/i.test(
      String(request.headers["content-type"] ?? ""),
    )
  ) {
    request.resume();
    throw new OperatorHttpError(415);
  }
  const chunks: Buffer[] = [];
  let size = 0;
  let oversized = false;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > (commands ? questionCommandRawLimit : MAX_JSON_BYTES)) {
      oversized = true;
      break;
    }
    chunks.push(buffer);
  }
  if (oversized) {
    // The iterator removes its readable listener asynchronously. Resume after
    // that cleanup, otherwise the rejected upload can strand a keepalive socket.
    await new Promise<void>((resolve) => setImmediate(resolve));
    request.resume();
    throw new OperatorHttpError(413);
  }
  try {
    const value: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
    );
    const type =
      value !== null && typeof value === "object" && "type" in value
        ? value.type
        : null;
    if (
      commands &&
      size > MAX_JSON_BYTES &&
      type !== "question.form.answer" &&
      type !== "question.native.answer" &&
      // An issue body may be up to 64,000 characters, which a 64 KiB command cannot carry.
      type !== "issue.edit.review"
    )
      throw new OperatorHttpError(413);
    return value;
  } catch (error) {
    if (error instanceof OperatorHttpError) throw error;
    throw new OperatorHttpError(400);
  }
}

function writeText(
  response: ServerResponse,
  status: number,
  body: string,
  headers: Record<string, string> = {},
): void {
  response.writeHead(status, {
    ...RESPONSE_HEADERS,
    "content-type": "text/plain; charset=utf-8",
    ...headers,
  });
  response.end(body);
}

/** Authenticated loopback HTTP server for the standalone operator surface. */
export class LocalOperatorHttp {
  private server: Server | undefined;
  private lanServer: Server | undefined;
  private readonly lan:
    | { address: string; origin?: string | undefined }
    | undefined;
  private readonly browserContext: Readonly<{
    origin: string;
    secureCookie: boolean;
    cookieName: string;
  }>;
  private readonly web: OperatorWebBoundary;
  private readonly credentials: OperatorCredentialStore | undefined;
  private readonly localAccess: LocalAccess | undefined;
  private readonly push: OperatorPush | undefined;

  constructor(
    private readonly auth: OperatorAuth,
    options: OperatorHttpOptions,
  ) {
    if (!options?.web)
      throw new Error("operator web UI not built; run npm run build:web");
    this.web = options.web;
    this.lan = options.lan ? Object.freeze({ ...options.lan }) : undefined;
    this.localAccess = options.localAccess;
    this.credentials = options.credentials;
    this.push = options.push;
    this.browserContext = Object.freeze({
      origin: auth.origin,
      secureCookie: new URL(auth.origin).protocol === "https:",
      cookieName: SESSION_COOKIE,
    });
  }

  async start(port = 0): Promise<number> {
    if (this.server) throw new Error("Operator UI already started");
    if (this.lan)
      validateNetworkSettings(
        { schema: "cab.operator-network/v1", lan: this.lan },
        port,
      );
    const makeServer = (lan: boolean) => {
      const server = createServer(async (request, response) => {
        let session: OperatorSession | undefined;
        try {
          const address = server.address();
          const localOrigin =
            address && typeof address !== "string"
              ? `http://127.0.0.1:${address.port}`
              : "";
          const loopbackHost = localOrigin.slice("http://".length);
          const expectedHost = new URL(this.auth.origin).host;
          const lanOrigin =
            this.lan &&
            (this.lan.origin ??
              `http://${this.lan.address}:${address && typeof address !== "string" ? address.port : port}`);
          const allowed = lan
            ? !!lanOrigin && request.headers.host === new URL(lanOrigin).host
            : request.headers.host === loopbackHost ||
              ((!this.lan || this.browserContext.secureCookie) &&
                request.headers.host === expectedHost);
          if (!allowed) {
            request.resume();
            writeText(response, 403, "Request denied");
            return;
          }
          const origin = lan
            ? lanOrigin!
            : this.lan && request.headers.host === loopbackHost
              ? localOrigin
              : this.browserContext.origin;
          const context = Object.freeze({
            origin,
            secureCookie: new URL(origin).protocol === "https:",
            cookieName: this.lan
              ? `${SESSION_COOKIE}_${lan ? "lan" : origin === localOrigin ? "loopback" : "proxy"}`
              : SESSION_COOKIE,
            loopback: !lan && request.socket.remoteAddress === "127.0.0.1",
          });
          const requestTarget = request.url ?? "/";
          if (
            !requestTarget.startsWith("/") ||
            requestTarget.startsWith("//") ||
            requestTarget.includes("\\") ||
            containsControlCharacters(requestTarget) ||
            requestTarget.includes("#")
          ) {
            request.resume();
            writeText(response, 400, "Request rejected");
            return;
          }
          const url = new URL(requestTarget, localOrigin || "http://127.0.0.1");
          if (
            url.pathname
              .split("/")
              .slice(1)
              .some((part) => part && decodeSegment(part) === undefined)
          ) {
            writeText(response, 404, "Not found");
            return;
          }
          if (url.pathname === "/") {
            request.resume();
            response.writeHead(302, { ...RESPONSE_HEADERS, location: "/app" });
            response.end();
            return;
          }
          // Retired and unknown paths are rejected before looking up or creating a session.
          if (
            (!this.web.owns(url.pathname) && url.pathname !== "/favicon.svg") ||
            (url.pathname === "/login" &&
              request.method !== "GET" &&
              request.method !== "HEAD")
          ) {
            request.resume();
            writeText(response, 404, "Not found");
            return;
          }
          // Bearer requests never read or upgrade a cookie session.
          if (request.headers.authorization !== undefined) {
            await this.handleBearer(request, response, url, context);
            return;
          }
          if (url.pathname === "/favicon.svg") {
            request.resume();
            const allowed =
              request.method === "GET" || request.method === "HEAD";
            response.writeHead(allowed ? 200 : 405, {
              ...RESPONSE_HEADERS,
              "content-type": "image/svg+xml",
              ...(!allowed ? { allow: "GET, HEAD" } : {}),
            });
            response.end(
              allowed && request.method === "GET" ? cabFaviconSvg : undefined,
            );
            return;
          }
          const id = cookieId(request, context.cookieName);
          session = id ? this.auth.getSession(id, context.origin) : undefined;
          this.purgeExpiredReviewOwners();

          if (await this.handleWeb(request, response, url, session, context))
            return;
          request.resume();
          writeText(response, 404, "Not found");
        } catch (error) {
          if (!response.headersSent) {
            writeText(
              response,
              error instanceof OperatorHttpError ? error.status : 400,
              "Request rejected",
            );
          } else if (!response.writableEnded) response.end();
        }
      });
      return server;
    };
    const server = makeServer(false);
    this.server = server;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", resolve);
      });
    } catch (error) {
      this.server = undefined;
      throw error;
    }
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Unexpected operator UI address");
    try {
      if (this.lan) {
        validateNetworkSettings(
          { schema: "cab.operator-network/v1", lan: this.lan },
          address.port,
        );
        if (
          this.browserContext.secureCookie &&
          new URL(this.auth.origin).host ===
            new URL(`http://127.0.0.1:${address.port}`).host
        )
          throw new Error(
            "Use a distinct HTTPS proxy Host or disable LAN access",
          );
        const lanServer = makeServer(true);
        this.lanServer = lanServer;
        try {
          await new Promise<void>((resolve, reject) => {
            lanServer.once("error", reject);
            lanServer.listen(address.port, this.lan!.address, resolve);
          });
        } catch (error) {
          throw new Error("Could not bind configured operator LAN address", {
            cause: error,
          });
        }
      }
      await this.localAccess?.publish(`http://127.0.0.1:${address.port}`);
      this.push?.start();
    } catch (error) {
      await this.stop();
      throw error;
    }
    return address.port;
  }

  async stop(): Promise<void> {
    const servers = [this.server, this.lanServer];
    this.server = undefined;
    this.lanServer = undefined;
    const results = await Promise.allSettled([
      Promise.resolve().then(() => this.push?.stop()),
      ...servers
        .filter((server): server is Server => !!server?.listening)
        .map(
          (server) =>
            new Promise<void>((resolve, reject) =>
              server.close((error) => (error ? reject(error) : resolve())),
            ),
        ),
    ]);
    const failure = results.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  }

  private currentSession(
    session: OperatorSession | undefined,
    context: typeof this.browserContext,
  ): boolean {
    const current = session && this.auth.getSession(session.id, context.origin);
    this.purgeExpiredReviewOwners();
    return !!current?.authenticated && current.csrfToken === session?.csrfToken;
  }
  private reviewSession(
    session: OperatorSession | undefined,
    context: typeof this.browserContext,
  ): OperatorReviewSessionContext | undefined {
    if (!session?.authenticated) return undefined;
    const ownerKey = this.auth.reviewOwnerKey(session.id, context.origin);
    if (!ownerKey) {
      this.purgeExpiredReviewOwners();
      return undefined;
    }
    return {
      ownerKey,
      current: () =>
        this.auth.reviewOwnerKey(session.id, context.origin) === ownerKey,
    };
  }
  private purgeExpiredReviewOwners(): void {
    const owners = this.auth.takeInvalidatedReviewOwnerKeys();
    for (const ownerKey of owners)
      this.web.api.purgeLocalReviewDrafts(ownerKey);
  }
  private async handleWeb(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    session: OperatorSession | undefined,
    context: typeof this.browserContext,
  ): Promise<boolean> {
    const web = this.web;
    if (!web.owns(url.pathname)) return false;
    const path = url.pathname,
      method = request.method;
    const headers = API_HEADERS;
    const json = (
      status: number,
      value: unknown,
      extra: Record<string, string> = {},
    ) => writeJson(response, status, value, extra);
    const deny = (status: number, code: string) => {
      request.resume();
      json(status, apiError(code));
    };
    if (!path.startsWith("/api")) {
      if (path === "/login" && method !== "GET") return false;
      if (method !== "GET" && method !== "HEAD") {
        deny(405, "method-not-allowed");
        return true;
      }
      // An unknown address under /app gets the public shell with 404, so the client can render "Page not found".
      const unknownApp =
        !web.shell(path) && path.startsWith("/app/") && !web.bundle.asset(path);
      const asset = web.bundle.asset(
        web.shell(path) || unknownApp ? "/app" : path,
      );
      if (!asset) {
        deny(404, "not-found");
        return true;
      }
      response.writeHead(unknownApp ? 404 : 200, {
        ...headers,
        "content-type": asset.type,
      });
      response.end(method === "HEAD" ? undefined : asset.body);
      return true;
    }
    try {
      if (!web.knownApi(path)) {
        deny(404, "not-found");
        return true;
      }
      const expected =
        path === "/api/operator/credentials"
          ? ["GET", "POST"]
          : [
                "/api/operator/login",
                "/api/operator/logout",
                "/api/operator/commands",
                "/api/operator/source-refresh",
                "/api/operator/setup/folders",
                "/api/operator/setup/verify-checkout",
              ].includes(path) ||
              CREDENTIAL_ACTION.test(path) ||
              path === "/api/operator/notifications/subscriptions" ||
              PUSH_ACTION.test(path)
            ? ["POST"]
            : ["GET"];
      if (!expected.includes(method ?? "")) {
        deny(405, "method-not-allowed");
        return true;
      }
      if (path === "/api/operator/session") {
        const current =
          session ?? this.auth.createAnonymousSession(context.origin);
        json(
          200,
          sessionSchema.parse({
            authenticated: current.authenticated,
            csrfToken: current.csrfToken,
          }),
          {
            "set-cookie": cookieHeader(
              current.id,
              context.secureCookie,
              context.cookieName,
            ),
          },
        );
        return true;
      }
      if (path !== "/api/operator/login" && !session?.authenticated) {
        deny(401, "unauthenticated");
        return true;
      }
      if (method === "POST") {
        if (
          !session ||
          request.headers.origin !== context.origin ||
          !this.auth.validateCsrf(
            session.id,
            String(request.headers["x-csrf-token"] ?? ""),
            context.origin,
          )
        ) {
          deny(403, "forbidden");
          return true;
        }
        const body = await readJson(request, path === "/api/operator/commands");
        if (
          path !== "/api/operator/login" &&
          !this.currentSession(session, context)
        ) {
          deny(401, "unauthenticated");
          return true;
        }
        if (path === "/api/operator/login") {
          const input = z
            .object({ password: z.string().max(8192) })
            .strict()
            .parse(body);
          if (session.authenticated) {
            deny(403, "forbidden");
            return true;
          }
          const current = await this.auth.authenticate(
            session.id,
            input.password,
            context.origin,
          );
          if (!current) {
            deny(401, "unauthenticated");
            return true;
          }
          json(
            200,
            sessionSchema.parse({
              authenticated: true,
              csrfToken: current.csrfToken,
            }),
            {
              "set-cookie": cookieHeader(
                current.id,
                context.secureCookie,
                context.cookieName,
              ),
            },
          );
          return true;
        }
        if (path === "/api/operator/logout") {
          z.object({}).strict().parse(body);
          const ownerKey = this.auth.logout(session.id, context.origin);
          if (ownerKey) web.api.purgeLocalReviewDrafts(ownerKey);
          json(
            200,
            { authenticated: false },
            {
              "set-cookie": clearedCookie(
                context.secureCookie,
                context.cookieName,
              ),
            },
          );
          return true;
        }
        if (path.startsWith("/api/operator/credentials")) {
          const credentials = this.credentials;
          if (!credentials) {
            deny(404, "not-found");
            return true;
          }
          const action = CREDENTIAL_ACTION.exec(path);
          const id = decodeSegment(action?.[1] ?? "") ?? "";
          let data: unknown;
          if (!action)
            data = operatorCredentialIssuedSchema.parse(
              credentials.issue(body),
            );
          else if (action[2] === "rotate")
            data = operatorCredentialIssuedSchema.parse(
              credentials.rotate(
                id,
                z
                  .object({
                    expiresInDays:
                      operatorCredentialIssueRequestSchema.shape.expiresInDays,
                  })
                  .strict()
                  .parse(body).expiresInDays,
              ),
            );
          else {
            z.object({}).strict().parse(body);
            data = { credential: credentials.revoke(id) };
          }
          json(200, data);
          return true;
        }
        if (path.startsWith("/api/operator/notifications")) {
          const push = this.push;
          if (!push) {
            deny(404, "not-found");
            return true;
          }
          const action = PUSH_ACTION.exec(path);
          const id = decodeSegment(action?.[1] ?? "") ?? "";
          let data: unknown;
          if (!action)
            data = pushSubscriptionResultSchema.parse({
              subscription: push.subscribe(body),
            });
          else if (action[2] === "revoke") {
            z.object({}).strict().parse(body);
            data = pushSubscriptionResultSchema.parse({
              subscription: push.revoke(id),
            });
          } else {
            z.object({}).strict().parse(body);
            const outcome = await push.test(id);
            if (!this.currentSession(session, context)) {
              deny(401, "unauthenticated");
              return true;
            }
            data = pushTestResultSchema.parse({ outcome });
          }
          json(200, data);
          return true;
        }
        if (path === "/api/operator/source-refresh") {
          z.object({}).strict().parse(body);
          const data = await web.api.refreshSources();
          if (!this.currentSession(session, context)) {
            deny(401, "unauthenticated");
            return true;
          }
          json(200, data);
          return true;
        }
        const data =
          path === "/api/operator/setup/folders"
            ? await web.api.listFolders(body)
            : path === "/api/operator/setup/verify-checkout"
              ? await web.api.verifyCheckout(body)
              : await web.api.execute(
                  body,
                  this.reviewSession(session, context),
                );
        if (!this.currentSession(session, context)) {
          deny(401, "unauthenticated");
          return true;
        }
        json(200, data);
        return true;
      }
      if (path === "/api/operator/credentials") {
        if ([...url.searchParams].length || !this.credentials)
          throw new OperatorApiError(
            this.credentials ? 400 : 404,
            this.credentials ? "invalid-input" : "not-found",
          );
        json(
          200,
          operatorCredentialListSchema.parse({
            data: { credentials: this.credentials.list() },
            observedAt: Date.now(),
          }),
        );
        return true;
      }
      if (path === "/api/operator/notifications") {
        if ([...url.searchParams].length || !this.push)
          throw new OperatorApiError(
            this.push ? 400 : 404,
            this.push ? "invalid-input" : "not-found",
          );
        json(
          200,
          pushNotificationsReadSchema.parse({
            data: this.push.read(),
            observedAt: Date.now(),
          }),
        );
        return true;
      }
      const artifact = path.match(
        /^\/api\/operator\/tasks\/([^/]+)\/artifacts\/([^/]+)$/,
      );
      if (artifact) {
        if ([...url.searchParams].length)
          throw new OperatorApiError(400, "invalid-input");
        const data = await web.api.readArtifact(
          artifact[1] ?? "",
          artifact[2] ?? "",
        );
        if (!this.currentSession(session, context)) {
          deny(401, "unauthenticated");
          return true;
        }
        response.writeHead(200, {
          ...headers,
          "content-type": data.type,
          "x-content-type-options": "nosniff",
          "x-cab-evidence-source": data.source,
          "x-cab-sha256": data.sha256,
        });
        response.end(data.body);
        return true;
      }
      const data = await web.read(
        path,
        url.searchParams,
        url.search,
        this.reviewSession(session, context),
      );
      if (!this.currentSession(session, context)) {
        deny(401, "unauthenticated");
        return true;
      }
      if (data === undefined) deny(404, "not-found");
      else json(200, data);
    } catch (error) {
      if (session?.authenticated && !this.currentSession(session, context)) {
        deny(401, "unauthenticated");
        return true;
      }
      const failure = apiFailure(error, method);
      json(failure.status, failure.body);
    }
    return true;
  }

  /** CLI bearer path: route authority decides; no cookie, Origin or CSRF state applies. */
  private async handleBearer(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    context: { readonly loopback: boolean },
  ): Promise<void> {
    const path = url.pathname,
      method = request.method;
    const deny = (status: number, code: string) => {
      request.resume();
      writeJson(response, status, apiError(code));
    };
    const web = this.web,
      credentials = this.credentials;
    if (!web || !credentials || !path.startsWith("/api/")) {
      deny(403, "forbidden");
      return;
    }
    const token = /^Bearer ([^\s]+)$/.exec(
      String(request.headers.authorization),
    )?.[1];
    const verify = ():
      | (Omit<VerifiedOperatorCredential, "expiresAt"> & {
          expiresAt: number | null;
        })
      | undefined =>
      token === undefined
        ? undefined
        : token.startsWith("cab_local_")
          ? context.loopback && this.localAccess?.verify(token)
            ? this.localAccess.credential()
            : undefined
          : credentials.verify(token);
    const credential = verify();
    if (!credential) {
      deny(401, "credential-invalid");
      return;
    }
    const authority = operatorRouteAuthority(method, path);
    if (authority === undefined) {
      if (web.knownApi(path)) deny(405, "method-not-allowed");
      else deny(404, "not-found");
      return;
    }
    if (authority === "session-only") {
      deny(403, "forbidden");
      return;
    }
    if (authority === "write" && credential.scope !== "read-write") {
      deny(403, "insufficient-scope");
      return;
    }
    try {
      let data: unknown;
      if (path === "/api/operator/cli") {
        if ([...url.searchParams].length)
          throw new OperatorApiError(400, "invalid-input");
        data = cliIdentitySchema.parse({
          apiVersion: 1,
          capabilities: cliCapabilities,
          service: {
            installationId: credentials.installationId(),
            origin: this.auth.origin,
          },
          credential,
          // Token identities must retain the strict API-v1 shape used by installed clients.
          ...(token?.startsWith("cab_local_") ? { accessMode: "local" } : {}),
        });
      } else if (method === "POST") {
        const body = await readJson(request, path === "/api/operator/commands");
        if (path === "/api/operator/source-refresh") {
          z.object({}).strict().parse(body);
          data = await web.api.refreshSources();
        } else data = await web.api.execute(body);
      } else {
        const artifact = path.match(
          /^\/api\/operator\/tasks\/([^/]+)\/artifacts\/([^/]+)$/,
        );
        if (artifact) {
          if ([...url.searchParams].length)
            throw new OperatorApiError(400, "invalid-input");
          const file = await web.api.readArtifact(
            artifact[1] ?? "",
            artifact[2] ?? "",
          );
          if (!verify()) {
            deny(401, "credential-invalid");
            return;
          }
          response.writeHead(200, {
            ...API_HEADERS,
            "content-type": file.type,
            "x-content-type-options": "nosniff",
            "x-cab-evidence-source": file.source,
            "x-cab-sha256": file.sha256,
          });
          response.end(file.body);
          return;
        }
        data = await web.read(path, url.searchParams, url.search);
      }
      // A credential revoked or expired during the call returns no data.
      if (!verify()) {
        deny(401, "credential-invalid");
        return;
      }
      if (data === undefined) deny(404, "not-found");
      else writeJson(response, 200, data);
    } catch (error) {
      if (!verify()) {
        deny(401, "credential-invalid");
        return;
      }
      const failure = apiFailure(error, method);
      writeJson(response, failure.status, failure.body);
    }
  }
}
