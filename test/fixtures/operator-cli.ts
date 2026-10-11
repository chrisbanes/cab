import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { OperatorApi } from "../../src/standalone/operator-api.js";
import { OperatorAuth } from "../../src/standalone/operator-auth.js";
import { OperatorRouteRegistry } from "../../src/standalone/operator-routes.js";
import { runtimeOperatorRoutes } from "../../src/standalone/operator-runtime.js";
import type { StandaloneServiceOptions } from "../../src/standalone/service.js";
import {
  OperatorWebBoundary,
  OperatorWebBundle,
} from "../../src/standalone/operator-web.js";
import {
  LocalOperatorHttp,
  LocalOperatorUi,
} from "../../src/standalone/operator.js";
import { harness } from "./cli-harness.js";
import { createOperatorFixture } from "./operator-web.js";
import { createReleaseDeliveryFixture } from "./s07b-delivery.js";

type After = { after(fn: () => unknown): void };

type ServeOptions = {
  authOrigin?: string;
  controlPaths?: string[];
  previewReader?: ConstructorParameters<typeof OperatorApi>[3];
};
type Fixture = Awaited<ReturnType<typeof createOperatorFixture>>;

/** A real operator service with the bearer path, a signed-in browser session and one task. */
export async function startCliService(
  t: After,
  options: ServeOptions & { service?: StandaloneServiceOptions } = {},
) {
  const f = await createOperatorFixture(
    null,
    undefined,
    undefined,
    undefined,
    undefined,
    options.service,
  );
  t.after(() => f.close());
  const served = await serveCli(t, f, options);
  const projectId = randomUUID(),
    taskId = randomUUID();
  f.service.domain().execute({
    type: "project.create",
    key: randomUUID(),
    actor: "operator",
    projectId,
    name: "CLI project",
    leadProfileId: null,
  });
  const r = await served.sessionPost("/api/operator/commands", {
    type: "task.create",
    key: randomUUID(),
    projectId,
    taskId,
    title: "Inspect me",
    outcome: "Readable through the CLI",
    ready: false,
  });
  if (r.status !== 200) throw Error(`task create failed ${r.status}`);
  return Object.assign(served, { projectId, taskId });
}

/** Serves an existing operator fixture over HTTP with the bearer path and a signed-in session. */
export async function serveCli<F extends Fixture>(
  t: After,
  f: F,
  options: ServeOptions = {},
) {
  const bundlePath = join(f.directory, "bundle");
  await mkdir(join(bundlePath, "assets"), { recursive: true });
  await writeFile(
    join(bundlePath, "index.html"),
    '<html><script src="/assets/main.js"></script></html>',
  );
  await writeFile(join(bundlePath, "assets/main.js"), "");
  const authFile = join(f.directory, "auth");
  await OperatorAuth.initialize(authFile, "fixture-password");
  const authOrigin = options.authOrigin ?? "http://127.0.0.1:8787";
  const auth = await OperatorAuth.open({ authFile, origin: authOrigin });
  t.after(() => auth.close());
  const bundle = await OperatorWebBundle.open(bundlePath);
  const build = () => {
    // The retained keyless Stop and Resume forms, for entry-point parity.
    const routes = new OperatorRouteRegistry();
    routes.registerSlot("runtime", runtimeOperatorRoutes(f.service));
    return new LocalOperatorHttp(
      new LocalOperatorUi(f.service.domain()),
      auth,
      {
        routes,
        credentials: f.service.operatorCredentials(),
        web: new OperatorWebBoundary(
          bundle,
          new OperatorApi(
            f.service,
            options.controlPaths ?? [f.directory],
            undefined,
            options.previewReader,
          ),
        ),
      },
    );
  };
  let http = build();
  const port = await http.start();
  t.after(() => http.stop());
  /** Restarts the service on the same database and port with fresh wiring. */
  const restart = async () => {
    await http.stop();
    await f.reopen();
    http = build();
    await http.start(port);
  };
  const origin = `http://127.0.0.1:${port}`;
  let r = await fetch(`${origin}/api/operator/session`);
  let cookie = r.headers.get("set-cookie")?.split(";")[0] ?? "";
  let csrf = ((await r.json()) as { csrfToken: string }).csrfToken;
  const sessionPost = (
    path: string,
    body: unknown,
    headers: Record<string, string> = {},
  ) =>
    fetch(`${origin}${path}`, {
      method: "POST",
      headers: {
        cookie,
        origin: authOrigin,
        "x-csrf-token": csrf,
        "content-type": "application/json",
        ...headers,
      },
      body: JSON.stringify(body),
    });
  r = await sessionPost("/api/operator/login", {
    password: "fixture-password",
  });
  if (r.status !== 200) throw Error(`login failed ${r.status}`);
  cookie = r.headers.get("set-cookie")?.split(";")[0] ?? "";
  csrf = ((await r.json()) as { csrfToken: string }).csrfToken;
  /** A retained HTML form post (urlencoded, session and CSRF). */
  const sessionForm = (path: string, fields: Record<string, string>) =>
    fetch(`${origin}${path}`, {
      method: "POST",
      redirect: "manual",
      headers: {
        cookie,
        origin: authOrigin,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ ...fields, csrfToken: csrf }).toString(),
    });
  const sessionGet = (path: string) =>
    fetch(`${origin}${path}`, { headers: { cookie } });
  const issue = async (
    scope: "read" | "read-write",
    name = `cli-${scope}`,
    expiresInDays?: number,
  ) => {
    const response = await sessionPost("/api/operator/credentials", {
      name,
      scope,
      ...(expiresInDays ? { expiresInDays } : {}),
    });
    if (response.status !== 200) throw Error(`issue ${response.status}`);
    return (await response.json()) as {
      token: string;
      credential: { id: string };
    };
  };
  const bearer = (
    token: string,
    path: string,
    init: {
      method?: string;
      body?: unknown;
      headers?: Record<string, string>;
    } = {},
  ) =>
    fetch(`${origin}${path}`, {
      method: init.method ?? "GET",
      headers: {
        authorization: `Bearer ${token}`,
        ...(init.body === undefined
          ? {}
          : { "content-type": "application/json" }),
        ...init.headers,
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
  return {
    f,
    get http() {
      return http;
    },
    restart,
    port,
    origin,
    authOrigin,
    get cookie() {
      return cookie;
    },
    sessionPost,
    sessionForm,
    sessionGet,
    issue,
    bearer,
  };
}

/** A real service plus a CLI harness logged in as `ro` (read) and `rw` (read-write). */
export async function startCliOperator(
  t: After,
  options: Parameters<typeof startCliService>[1] = {},
) {
  const s = await startCliService(t, {
    service: { supervisor: { observationMs: 50 } },
    ...options,
  });
  return { ...(await loginCli(t, s)), d: s.f.service.domain() };
}

/** A CLI harness logged in to a served fixture as `ro` (read) and `rw` (read-write). */
export async function loginCli<S extends Awaited<ReturnType<typeof serveCli>>>(
  t: After,
  s: S,
) {
  const h = harness(t);
  for (const [name, scope] of [
    ["ro", "read"],
    ["rw", "read-write"],
  ] as const) {
    const issued = await s.issue(scope, `operate-${name}`);
    const login = await h.run([
      "auth",
      "login",
      "--connection",
      name,
      "--url",
      s.origin,
      "--token-file",
      h.tokenFile(issued.token),
    ]);
    if (login.code !== 0) throw Error(`login ${name}: ${login.err}`);
  }
  /** Runs one command as JSON with the given connection. */
  const cli = (
    connection: "ro" | "rw",
    args: string[],
    extra: Parameters<typeof h.run>[1] = {},
  ) => h.run([...args, "--connection", connection, "--output", "json"], extra);
  /** A fetch that performs the command POST, then loses its reply. */
  const lostReply: typeof fetch = async (input, init) => {
    const response = await fetch(input, init);
    if (String(input).endsWith("/api/operator/commands"))
      throw new TypeError("fetch failed", { cause: { code: "ECONNRESET" } });
    return response;
  };
  const file = (name: string, text: string) => {
    const path = join(h.dir, name);
    writeFileSync(path, text);
    return path;
  };
  return { s, h, cli, lostReply, file };
}

/** The release fixture served to the CLI, with an issue.comment grant in `mode`. */
export async function deliveryWorld(
  t: After,
  mode: "allow" | "approval" | null = "allow",
  localTask = false,
) {
  const f = await createReleaseDeliveryFixture("reviewable-pr", {}, localTask);
  t.after(() => f.close());
  const grant = (next: "allow" | "approval" | null) =>
    f.service.domain().execute({
      type: "delivery.configure",
      actor: "operator",
      key: randomUUID(),
      projectId: f.projectId,
      expectedVersion: f.service.delivery().configuration(f.projectId).version,
      mode: "reviewable-pr",
      credentialRef: null,
      grants: [
        { action: "pr.merge", repositoryId: "R1", mode: "allow" },
        ...(next
          ? [
              {
                action: "issue.comment" as const,
                repositoryId: "R1",
                mode: next,
              },
            ]
          : []),
      ],
      requiredChecks: [{ name: "build", appId: 17 }],
    });
  grant(mode);
  const s = await serveCli(t, f);
  const o = await loginCli(t, s);
  const ok = async (connection: "ro" | "rw", args: string[], extra = {}) => {
    const r = await o.cli(connection, args, extra);
    if (r.code !== 0)
      throw Error(`${args.join(" ")}: ${r.code} ${r.err}${r.out}`);
    // biome-ignore lint/suspicious/noExplicitAny: parsed CLI envelopes are asserted structurally
    return r.json() as Record<string, any>;
  };
  const task = async () =>
    (
      (await (
        await s.sessionGet(`/api/operator/tasks/${f.taskId}`)
      )
        // biome-ignore lint/suspicious/noExplicitAny: task reads are asserted structurally
        .json()) as { data: Record<string, any> }
    ).data;
  return { ...o, f, scripted: f.scripted.state, grant, ok, task };
}
