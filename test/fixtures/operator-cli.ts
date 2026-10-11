import { randomUUID } from "node:crypto";
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
import { createOperatorFixture } from "./operator-web.js";

type After = { after(fn: () => unknown): void };

/** A real operator service with the bearer path, a signed-in browser session and one task. */
export async function startCliService(
  t: After,
  options: {
    authOrigin?: string;
    controlPaths?: string[];
    service?: StandaloneServiceOptions;
  } = {},
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
          new OperatorApi(f.service, options.controlPaths ?? [f.directory]),
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
  r = await sessionPost("/api/operator/commands", {
    type: "task.create",
    key: randomUUID(),
    projectId,
    taskId,
    title: "Inspect me",
    outcome: "Readable through the CLI",
    ready: false,
  });
  if (r.status !== 200) throw Error(`task create failed ${r.status}`);
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
    projectId,
    taskId,
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
