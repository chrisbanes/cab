import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { type AddressInfo, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { CommandResultValidationError } from "../../src/core/command-results.js";
import { browserSuite } from "../fixtures/browser-diagnostics.js";

const browserTest = browserSuite("github-source");

const link = (repositoryId: string, path: string, ref = "main") => ({
  codeHost: "github" as const,
  host: "github.com" as const,
  repositoryId,
  path,
  ref,
});

import { type Browser, chromium } from "playwright";
import { DomainCommands, DomainStore } from "../../src/core/domain.js";
import { GitHubSourceStore } from "../../src/core/github-source.js";
import { Store } from "../../src/core/store.js";
import { restorePreviousSourceSchema } from "../fixtures/previous-source-schema.js";
import type { GitHubSourceReader } from "../../src/standalone/github-source.js";
import {
  LocalOperatorHttp,
  LocalOperatorUi,
} from "../../src/standalone/operator.js";
import { OperatorAuth } from "../../src/standalone/operator-auth.js";
import { StandaloneService } from "../../src/standalone/service.js";

test("operator-owned GitHub configuration survives restart and rejects stale or agent changes", () => {
  const root = mkdtempSync(join(tmpdir(), "cab-github-config-"));
  const file = join(root, "service.sqlite");
  const projectId = randomUUID();
  let db = new DatabaseSync(file);
  let domain = new DomainStore(db);
  try {
    new Store(db).ensureHost("test");
    domain.migrate();
    domain.execute({
      type: "project.create",
      actor: "operator",
      key: randomUUID(),
      projectId,
      name: "Alpha",
      leadProfileId: null,
    });
    const command = {
      type: "github.configure" as const,
      actor: "operator" as const,
      key: randomUUID(),
      projectId,
      expectedVersion: 1,
      credentialRef: "env:CAB_TEST_GITHUB",
      selections: [
        {
          id: "repo",
          kind: "repository" as const,
          repositoryId: "R_1",
          owner: "org",
          name: "repo",
        },
        {
          id: "search",
          kind: "search" as const,
          query: "repo:org/repo label:ready",
        },
        {
          id: "project",
          kind: "project" as const,
          projectNodeId: "P_1",
          filter: "status:ready",
        },
      ],
      readiness: {
        mode: "all" as const,
        conditions: [
          { kind: "label" as const, operator: "has" as const, name: "ready" },
          {
            kind: "project-field" as const,
            projectNodeId: "P_1",
            fieldNodeId: "F_1",
            operator: "in" as const,
            optionNodeIds: ["O_1"],
          },
        ],
      },
    };
    const receipt = domain.execute(command);
    assert.deepEqual(domain.execute(command), receipt);
    assert.throws(
      () => domain.execute({ ...command, key: randomUUID() }),
      /Version conflict/,
    );
    assert.throws(
      () =>
        domain.execute({
          ...command,
          key: randomUUID(),
          actor: "agent",
          expectedVersion: 2,
        }),
      /operator/i,
    );
    db.close();
    db = new DatabaseSync(file);
    domain = new DomainStore(db);
    new Store(db).ensureHost("test");
    domain.migrate();
    const config = domain.githubConfiguration(projectId);
    assert.equal(config.version, 2);
    assert.deepEqual(config.selections, command.selections);
    assert.deepEqual(config.readiness, command.readiness);
    assert.equal(config.credentialRef, "env:CAB_TEST_GITHUB");
    assert.doesNotMatch(JSON.stringify(config), /secret-value/);
    const html = new LocalOperatorUi(domain).project(projectId);
    assert.match(html, /data-command="github\.configure"/);
    assert.match(html, /status:ready/);
    assert.doesNotMatch(html, /env:CAB_TEST_GITHUB|secret-value/);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a version-matched successful source preview activates only that selection", async () => {
  const root = mkdtempSync(join(tmpdir(), "cab-github-preview-"));
  const db = new DatabaseSync(join(root, "db.sqlite"));
  const projectId = randomUUID();
  try {
    new Store(db).ensureHost("test");
    const domain = new DomainStore(db);
    domain.migrate();
    domain.execute({
      type: "project.create",
      actor: "operator",
      key: randomUUID(),
      projectId,
      name: "Alpha",
      leadProfileId: null,
    });
    domain.execute({
      type: "github.configure",
      actor: "operator",
      key: randomUUID(),
      projectId,
      expectedVersion: 1,
      credentialRef: "env:CAB_TEST_GITHUB",
      selections: [
        {
          id: "repo",
          kind: "repository",
          repositoryId: "R_1",
          owner: "org",
          name: "repo",
        },
      ],
      readiness: {
        mode: "any",
        conditions: [{ kind: "label", operator: "has", name: "ready" }],
      },
    });
    let previewComplete = true;
    const reader = {
      async readSelection() {
        return previewComplete
          ? ({ complete: true, issues: [], reason: null } as const)
          : ({ complete: false, issues: [], reason: "http-403" } as const);
      },
    } as Pick<GitHubSourceReader, "readSelection">;
    const ui = new LocalOperatorUi(domain, () => reader);
    const fields = {
      type: "github.preview",
      key: randomUUID(),
      projectId,
      selectionId: "repo",
      expectedVersion: "2",
    };
    await ui.submit(fields);
    assert.deepEqual(domain.githubActiveSelectionIds(projectId), ["repo"]);
    assert.deepEqual(await ui.submit(fields), await ui.submit(fields));
    await assert.rejects(
      ui.submit({ ...fields, key: randomUUID(), expectedVersion: "1" }),
      /Version conflict/,
    );
    domain.execute({
      type: "github.configure",
      actor: "operator",
      key: randomUUID(),
      projectId,
      expectedVersion: 2,
      credentialRef: "env:CAB_TEST_GITHUB",
      selections: [
        {
          id: "repo",
          kind: "repository",
          repositoryId: "R_1",
          owner: "org",
          name: "repo",
        },
      ],
      readiness: {
        mode: "any",
        conditions: [{ kind: "label", operator: "has", name: "ready" }],
      },
    });
    assert.deepEqual(domain.githubActiveSelectionIds(projectId), []);
    previewComplete = false;
    await assert.rejects(
      ui.submit({ ...fields, key: randomUUID(), expectedVersion: "3" }),
      /preview incomplete/,
    );
    assert.deepEqual(domain.githubActiveSelectionIds(projectId), []);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("github.activate reports whether the selection was already active at the source version", () => {
  const root = mkdtempSync(join(tmpdir(), "cab-github-activation-"));
  const db = new DatabaseSync(join(root, "db.sqlite"));
  const projectId = randomUUID();
  try {
    new Store(db).ensureHost("test");
    const domain = new DomainStore(db);
    domain.migrate();
    domain.execute({
      type: "project.create",
      actor: "operator",
      key: randomUUID(),
      projectId,
      name: "Alpha",
      leadProfileId: null,
    });
    const configure = (expectedVersion: number) =>
      domain.execute({
        type: "github.configure",
        actor: "operator",
        key: randomUUID(),
        projectId,
        expectedVersion,
        credentialRef: "env:CAB_TEST_GITHUB",
        selections: ["repo", "other"].map((name) => ({
          id: name,
          kind: "repository" as const,
          repositoryId: `R_${name}`,
          owner: "org",
          name,
        })),
        readiness: {
          mode: "any",
          conditions: [{ kind: "label", operator: "has", name: "ready" }],
        },
      });
    const activate = (
      selectionId: string,
      expectedVersion: number,
      key = randomUUID(),
    ) =>
      (
        domain.execute({
          type: "github.activate",
          actor: "operator",
          key,
          projectId,
          selectionId,
          expectedVersion,
        }) as { alreadyActive?: boolean }
      ).alreadyActive;
    configure(1);
    const keyA = randomUUID();
    assert.equal(activate("repo", 2, keyA), false);
    assert.equal(activate("repo", 2), true);
    assert.equal(
      activate("repo", 2, keyA),
      false,
      "a replay keeps the recorded value",
    );
    assert.equal(activate("other", 2), false, "prior state is per selection");
    configure(2);
    assert.equal(
      activate("repo", 3),
      false,
      "a row at an older version is not active",
    );
    assert.equal(activate("repo", 3), true);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("operator pages distinguish GitHub sync, provenance and source holds while escaping provider text", () => {
  const root = mkdtempSync(join(tmpdir(), "cab-github-ui-"));
  const db = new DatabaseSync(join(root, "db.sqlite"));
  try {
    new Store(db).ensureHost("test");
    const domain = new DomainStore(db);
    domain.migrate();
    const sources = new GitHubSourceStore(db);
    sources.migrate();
    const projectId = randomUUID();
    domain.execute({
      type: "project.create",
      actor: "operator",
      key: randomUUID(),
      projectId,
      name: "Alpha",
      leadProfileId: null,
    });
    domain.execute({
      type: "github.configure",
      actor: "operator",
      key: randomUUID(),
      projectId,
      expectedVersion: 1,
      credentialRef: "env:CAB_TEST_GITHUB",
      selections: [
        {
          id: "repo",
          kind: "repository",
          repositoryId: "R_1",
          owner: "org",
          name: "repo",
        },
      ],
      readiness: {
        mode: "any",
        conditions: [{ kind: "label", operator: "has", name: "ready" }],
      },
    });
    domain.execute({
      type: "github.activate",
      actor: "operator",
      key: randomUUID(),
      projectId,
      selectionId: "repo",
      expectedVersion: 2,
    });
    sources.reconcileSelection(projectId, "repo", {
      complete: true,
      issues: [
        {
          providerInstance: "github.com",
          nodeId: "I_1",
          repositoryId: "R_1",
          repositoryName: "org/repo",
          number: 1,
          title: "<img src=x onerror=alert(1)>",
          body: "<script>alert(2)</script>",
          state: "open",
          labels: ["ready"],
          projectFields: [],
        },
      ],
      reason: null,
    });
    const taskId = String(sources.issue("I_1")?.taskId);
    const localId = randomUUID();
    domain.execute({
      type: "task.create",
      actor: "operator",
      key: randomUUID(),
      projectId,
      taskId: localId,
      title: "Independent local task",
      outcome: "Local",
      ready: false,
    });
    sources.reconcileBlockers("I_1", {
      complete: false,
      blockers: [],
      reason: "http-403",
    });
    const ui = new LocalOperatorUi(domain, undefined, sources);
    const project = ui.project(projectId);
    const task = ui.task(taskId);
    assert.match(project, /repo.*complete/i);
    assert.match(project, /Independent local task/);
    assert.match(task, /github\.com|org\/repo/);
    assert.match(task, /imported-blockers-unknown/);
    assert.match(task, /&lt;script&gt;alert\(2\)&lt;\/script&gt;/);
    assert.doesNotMatch(project + task, /<script>|<img src=x/);
    assert.doesNotMatch(project + task, /CAB_TEST_GITHUB|fixture-token/);
    assert.match(project, /1 observed · 1 open · 1 match any of label `ready`/);
    assert.doesNotMatch(project, /No open item matches/);
    // The label is removed on GitHub: nothing matches and the task names why.
    sources.reconcileSelection(projectId, "repo", {
      complete: true,
      issues: [
        {
          providerInstance: "github.com",
          nodeId: "I_1",
          repositoryId: "R_1",
          repositoryName: "org/repo",
          number: 1,
          title: "<img src=x onerror=alert(1)>",
          body: "<script>alert(2)</script>",
          state: "open",
          labels: [],
          projectFields: [],
        },
      ],
      reason: null,
    });
    const unmatched = ui.project(projectId);
    assert.match(
      unmatched,
      /1 observed · 1 open · 0 match any of label `ready`\. No open item matches the readiness rule \(any of label `ready`\); imported tasks stay Draft until one does\. <a href="#github-readiness">Check readiness conditions<\/a>/,
    );
    assert.match(unmatched, /<div id="github-readiness">/);
    assert.match(ui.task(taskId), /Not ready \(needs any of label `ready`\)/);
    assert.doesNotMatch(ui.task(localId), /needs any of/);
    sources.reconcileSelection(projectId, "repo", {
      complete: false,
      issues: [],
      reason: "http-403",
    });
    assert.match(ui.project(projectId), /repo.*partial: http-403/i);
    assert.match(
      ui.project(projectId),
      /partial read; counts may be incomplete/,
    );
    assert.doesNotMatch(ui.project(projectId), /No open item matches/);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

browserTest(
  "GitHub source pages and refresh inherit authenticated origin and CSRF guards",
  async (_t, journey) => {
    const previousSource = process.env.CAB_TEST_GITHUB;
    process.env.CAB_TEST_GITHUB = "fixture-source-page-token";
    _t.after(() => {
      if (previousSource === undefined) delete process.env.CAB_TEST_GITHUB;
      else process.env.CAB_TEST_GITHUB = previousSource;
    });
    const root = mkdtempSync(join(tmpdir(), "cab-github-http-"));
    const db = new DatabaseSync(join(root, "db.sqlite"));
    let http: LocalOperatorHttp | undefined;
    let auth: OperatorAuth | undefined;
    let browser: Browser | undefined;
    let portServer: ReturnType<typeof createServer> | undefined;
    journey.ownLocal({
      browser: async () => {
        await browser?.close();
      },
      listeners: [
        {
          name: "http.stop",
          close: async () => {
            await http?.stop();
          },
        },
        {
          name: "probe.close",
          close: async () => {
            const held = portServer;
            if (held?.listening)
              await new Promise<void>((resolve, reject) =>
                held.close((error) => (error ? reject(error) : resolve())),
              );
          },
        },
      ],
      auth: () => auth?.close(),
      state: async () => db.close(),
      directory: () => rmSync(root, { recursive: true, force: true }),
    });
    new Store(db).ensureHost("test");
    const domain = new DomainStore(db);
    domain.migrate();
    const sources = new GitHubSourceStore(db);
    sources.migrate();
    const projectId = randomUUID();
    domain.execute({
      type: "project.create",
      actor: "operator",
      key: randomUUID(),
      projectId,
      name: "Alpha",
      leadProfileId: null,
    });
    domain.execute({
      type: "github.configure",
      actor: "operator",
      key: randomUUID(),
      projectId,
      expectedVersion: 1,
      credentialRef: "env:CAB_TEST_GITHUB",
      selections: [
        {
          id: "repo",
          kind: "repository",
          repositoryId: "R_1",
          owner: "org",
          name: "repo",
        },
      ],
      readiness: {
        mode: "any",
        conditions: [{ kind: "label", operator: "has", name: "ready" }],
      },
    });
    domain.execute({
      type: "github.activate",
      actor: "operator",
      key: randomUUID(),
      projectId,
      selectionId: "repo",
      expectedVersion: 2,
    });
    sources.reconcileSelection(projectId, "repo", {
      complete: true,
      issues: [
        {
          providerInstance: "github.com",
          nodeId: "I_1",
          repositoryId: "R_1",
          repositoryName: "org/repo",
          number: 1,
          title: "<img src=x>",
          body: "Observed body",
          state: "open",
          labels: ["ready"],
          projectFields: [],
        },
      ],
      reason: null,
    });
    const taskId = String(sources.issue("I_1")?.taskId);
    const otherProjectId = randomUUID();
    domain.execute({
      type: "project.create",
      actor: "operator",
      key: randomUUID(),
      projectId: otherProjectId,
      name: "Beta",
      leadProfileId: null,
    });
    domain.execute({
      type: "github.configure",
      actor: "operator",
      key: randomUUID(),
      projectId: otherProjectId,
      expectedVersion: 1,
      credentialRef: "env:CAB_TEST_GITHUB",
      selections: [
        {
          id: "repo",
          kind: "repository",
          repositoryId: "R_1",
          owner: "org",
          name: "repo",
        },
      ],
      readiness: {
        mode: "any",
        conditions: [{ kind: "label", operator: "has", name: "ready" }],
      },
    });
    domain.execute({
      type: "github.activate",
      actor: "operator",
      key: randomUUID(),
      projectId: otherProjectId,
      selectionId: "repo",
      expectedVersion: 2,
    });
    sources.reconcileSelection(otherProjectId, "repo", {
      complete: true,
      issues: [
        {
          providerInstance: "github.com",
          nodeId: "I_1",
          repositoryId: "R_1",
          repositoryName: "org/repo",
          number: 1,
          title: "<img src=x>",
          body: "Observed body",
          state: "open",
          labels: ["ready"],
          projectFields: [],
        },
      ],
      reason: null,
    });
    let refreshes = 0;
    const ui = new LocalOperatorUi(domain, undefined, sources, async () => {
      refreshes++;
    });
    const probe = createServer();
    portServer = probe;
    await journey.start(
      "probe.listen",
      () =>
        new Promise<void>((resolve, reject) => {
          probe.once("error", reject);
          probe.listen(0, "127.0.0.1", resolve);
        }),
    );
    const port = (portServer.address() as AddressInfo).port;
    await journey.closeStep(
      "probe.close",
      () =>
        new Promise<void>((resolve, reject) =>
          probe.close((error) => (error ? reject(error) : resolve())),
        ),
    );
    const origin = `http://127.0.0.1:${port}`;
    const password = "test operator password";
    await journey.start("auth.initialize", () =>
      OperatorAuth.initialize(join(root, "auth.json"), password),
    );
    auth = await journey.start("auth.open", () =>
      OperatorAuth.open({
        authFile: join(root, "auth.json"),
        origin,
      }),
    );
    http = new LocalOperatorHttp(ui, auth);
    await journey.start("http.start", http.start.bind(http, port));
    const privatePage = await fetch(`${origin}/project/${projectId}`, {
      redirect: "manual",
    });
    assert.doesNotMatch(
      await privatePage.text(),
      /Alpha|GitHub discovery|github\.refresh/,
    );
    const loginPage = await fetch(`${origin}/login`);
    const anonymousCookie =
      (loginPage.headers.get("set-cookie") ?? "").split(";", 1)[0] ?? "";
    const loginCsrf = (await loginPage.text()).match(
      /name="csrfToken"[^>]*value="([^"]+)"/,
    )?.[1];
    assert.ok(loginCsrf);
    const login = await fetch(`${origin}/login`, {
      method: "POST",
      headers: {
        origin,
        cookie: anonymousCookie,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ password, csrfToken: loginCsrf }),
      redirect: "manual",
    });
    assert.equal(login.status, 303);
    const cookie =
      (login.headers.get("set-cookie") ?? "").split(";", 1)[0] ?? "";
    const projectResponse = await fetch(`${origin}/project/${projectId}`, {
      headers: { cookie },
    });
    assert.equal(projectResponse.status, 200);
    const html = await projectResponse.text();
    const csrfToken = html.match(/name="csrfToken"[^>]*value="([^"]+)"/)?.[1];
    assert.ok(csrfToken);
    assert.match(html, /data-command="github\.refresh"/);
    assert.match(html, /data-command="github\.place"/);
    assert.match(html, /name="chosenProjectId"/);
    const fields = new URLSearchParams({
      type: "github.refresh",
      key: randomUUID(),
      projectId,
      csrfToken,
    });
    const post = (headers: Record<string, string>, body: URLSearchParams) =>
      fetch(`${origin}/command`, {
        method: "POST",
        headers: {
          cookie,
          "content-type": "application/x-www-form-urlencoded",
          ...headers,
        },
        body,
        redirect: "manual",
      });
    assert.equal(
      (await post({ origin: "https://elsewhere.example" }, fields)).status,
      403,
    );
    assert.equal(
      (
        await post(
          { origin },
          new URLSearchParams({
            ...Object.fromEntries(fields),
            csrfToken: "wrong",
          }),
        )
      ).status,
      403,
    );
    assert.equal(refreshes, 0);
    assert.equal((await post({ origin }, fields)).status, 303);
    assert.equal(refreshes, 1);
    const placeFields = new URLSearchParams({
      type: "github.place",
      key: randomUUID(),
      projectId,
      taskId,
      chosenProjectId: otherProjectId,
      expectedVersion: String(domain.task(taskId).version),
      csrfToken,
    });
    assert.equal(
      (await post({ origin: "https://elsewhere.example" }, placeFields)).status,
      403,
    );
    assert.equal(
      (
        await post(
          { origin },
          new URLSearchParams({
            ...Object.fromEntries(placeFields),
            csrfToken: "wrong",
          }),
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await post(
          { origin },
          new URLSearchParams({
            ...Object.fromEntries(placeFields),
            expectedVersion: "1",
          }),
        )
      ).status,
      409,
    );
    assert.equal((await post({ origin }, placeFields)).status, 303);
    assert.equal(String(domain.task(taskId).projectId), otherProjectId);
    browser = await journey.start("browser.launch", () =>
      chromium.launch({ headless: true }),
    );
    const context = await browser.newContext();
    const [cookieName, cookieValue] = cookie.split("=", 2);
    assert.ok(cookieName && cookieValue);
    await context.addCookies([
      { name: cookieName, value: cookieValue, url: origin },
    ]);
    const page = await context.newPage();
    journey.observe(page);
    await page.goto(`${origin}/project/${projectId}`);
    assert.match(await page.locator("main").innerText(), /repo.*complete/s);
    await page.goto(`${origin}/task/${taskId}`);
    assert.match(
      await page.locator("main").innerText(),
      /GitHub source|org\/repo/,
    );
    assert.equal(await page.locator("img").count(), 0);
  },
);

test("linked repository verification is asynchronous and stale configuration cannot commit", async () => {
  const root = mkdtempSync(join(tmpdir(), "cab-github-async-config-"));
  const db = new DatabaseSync(join(root, "db.sqlite"));
  const projectId = randomUUID();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered = false;
  let verifications = 0;
  try {
    new Store(db).ensureHost("test");
    const domain = new DomainStore(db, undefined, async (link) => {
      entered = true;
      verifications++;
      await gate;
      return { ...link, gitCommonDirectory: root };
    });
    domain.migrate();
    domain.execute({
      type: "project.create",
      actor: "operator",
      key: randomUUID(),
      projectId,
      name: "Alpha",
      leadProfileId: null,
    });
    const command = {
      type: "repositories.configure" as const,
      actor: "operator" as const,
      key: randomUUID(),
      projectId,
      expectedVersion: 1,
      repositories: [link("R_1", root)],
    };
    const pending = new DomainCommands(domain).execute(command);
    for (let i = 0; i < 100 && !entered; i++)
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    assert.equal(entered, true);
    assert.equal(domain.repositoryLinks(projectId).version, 1);
    // An empty list needs no verification, so it commits while the other waits.
    domain.execute({ ...command, key: randomUUID(), repositories: [] });
    release();
    await assert.rejects(pending, /version conflict/i);
    assert.equal(domain.repositoryLinks(projectId).version, 2);
    assert.deepEqual(domain.repositoryLinks(projectId).links, []);
    await assert.rejects(
      domain.configureRepositories({
        ...command,
        key: randomUUID(),
        actor: "agent",
        expectedVersion: 2,
      }),
      /operator/i,
    );
    await assert.rejects(
      domain.configureRepositories({ ...command, key: randomUUID() }),
      /version conflict/i,
    );
    assert.equal(verifications, 1);
    const accepted = { ...command, key: randomUUID(), expectedVersion: 2 };
    const first = await domain.configureRepositories(accepted);
    assert.equal(verifications, 2);
    assert.deepEqual(await domain.configureRepositories(accepted), first);
    assert.deepEqual(domain.execute(accepted), first);
    assert.equal(verifications, 2);
    await assert.rejects(
      domain.configureRepositories({
        ...accepted,
        repositories: [link("R_1", root, "dev")],
      }),
      /different payload/i,
    );
    assert.equal(verifications, 2);
  } finally {
    release?.();
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("malformed repository verification output fails as an internal result error", async () => {
  const root = mkdtempSync(join(tmpdir(), "cab-github-invalid-result-"));
  const db = new DatabaseSync(join(root, "db.sqlite"));
  const projectId = randomUUID();
  let malformed = true;
  let verificationCount = 0;
  try {
    new Store(db).ensureHost("test");
    const domain = new DomainStore(db, undefined, async (link) => {
      verificationCount++;
      return {
        ...link,
        gitCommonDirectory: malformed ? "relative/.git" : root,
      };
    });
    domain.migrate();
    domain.execute({
      type: "project.create",
      actor: "operator",
      key: randomUUID(),
      projectId,
      name: "Alpha",
      leadProfileId: null,
    });
    const command = {
      type: "repositories.configure" as const,
      actor: "operator" as const,
      key: randomUUID(),
      projectId,
      expectedVersion: 1,
      repositories: [link("R_1", root)],
    };

    const commands = new DomainCommands(domain);
    await assert.rejects(
      commands.execute(command),
      CommandResultValidationError,
    );
    assert.equal(domain.repositoryLinks(projectId).version, 1);
    assert.deepEqual(domain.repositoryLinks(projectId).links, []);
    assert.equal(domain.recordedResult(projectId, command.key), undefined);

    malformed = false;
    const result = await commands.execute(command);
    assert.equal(verificationCount, 2);
    assert.equal(domain.repositoryLinks(projectId).version, 2);
    assert.deepEqual(domain.recordedResult(projectId, command.key), result);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("duplicate verified repository identities roll back and corrupt receipts fail closed", async () => {
  const root = mkdtempSync(join(tmpdir(), "cab-github-duplicate-result-"));
  const db = new DatabaseSync(join(root, "db.sqlite"));
  const projectId = randomUUID();
  let duplicate = true;
  let verificationCount = 0;
  try {
    new Store(db).ensureHost("test");
    const domain = new DomainStore(db, undefined, async (link) => {
      verificationCount++;
      return {
        ...link,
        repositoryId: duplicate ? "R_DUP" : link.repositoryId,
        gitCommonDirectory: root,
      };
    });
    domain.migrate();
    domain.execute({
      type: "project.create",
      actor: "operator",
      key: randomUUID(),
      projectId,
      name: "Alpha",
      leadProfileId: null,
    });
    const command = {
      type: "repositories.configure" as const,
      actor: "operator" as const,
      key: randomUUID(),
      projectId,
      expectedVersion: 1,
      repositories: [link("R_1", root), link("R_2", root)],
    };
    const commands = new DomainCommands(domain);

    await assert.rejects(
      commands.execute(command),
      CommandResultValidationError,
    );
    assert.equal(verificationCount, 2);
    assert.equal(domain.repositoryLinks(projectId).version, 1);
    assert.deepEqual(domain.repositoryLinks(projectId).links, []);
    assert.equal(domain.recordedResult(projectId, command.key), undefined);

    duplicate = false;
    const result = await commands.execute(command);
    assert.equal(verificationCount, 4);
    assert.equal(domain.repositoryLinks(projectId).version, 2);
    assert.deepEqual(
      result.repositories.map((repository) => repository.repositoryId),
      ["R_1", "R_2"],
    );

    const corrupted = {
      ...result,
      repositories: result.repositories.map((repository) => ({
        ...repository,
        repositoryId: "R_DUP",
      })),
    };
    db.prepare(
      "UPDATE command_receipts SET result = ? WHERE scope = ? AND key = ?",
    ).run(JSON.stringify(corrupted), projectId, command.key);
    await assert.rejects(
      domain.configureRepositories(command),
      CommandResultValidationError,
    );
    assert.throws(
      () =>
        domain.recordedResult(projectId, command.key, "repositories.configure"),
      CommandResultValidationError,
    );
    assert.equal(verificationCount, 4);
    assert.equal(domain.repositoryLinks(projectId).version, 2);
    assert.deepEqual(
      domain.repositoryLinks(projectId).links.map((r) => r.repositoryId),
      ["R_1", "R_2"],
    );
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("verified GitHub command duplicates share correlation and replay without rechecking", async () => {
  const root = mkdtempSync(join(tmpdir(), "cab-github-correlated-replay-"));
  const filename = join(root, "db.sqlite");
  const projectId = randomUUID();
  let db = new DatabaseSync(filename);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered = false;
  let verifications = 0;
  try {
    new Store(db).ensureHost("test");
    let domain = new DomainStore(db, undefined, async (link) => {
      entered = true;
      verifications++;
      await gate;
      return { ...link, gitCommonDirectory: root };
    });
    domain.migrate();
    domain.execute({
      type: "project.create",
      actor: "operator",
      key: randomUUID(),
      projectId,
      name: "Alpha",
      leadProfileId: null,
    });
    const command = {
      type: "repositories.configure" as const,
      actor: "operator" as const,
      key: randomUUID(),
      projectId,
      expectedVersion: 1,
      repositories: [link("R_1", root)],
    };
    const commands = new DomainCommands(domain);
    const first = commands.execute(command);
    const matching = commands.execute(command);
    assert.equal(first, matching);
    for (let i = 0; i < 100 && !entered; i++)
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    assert.equal(entered, true);
    await assert.rejects(
      commands.execute({
        ...command,
        repositories: [link("R_1", root, "dev")],
      }),
      /different payload/i,
    );
    release();
    const result = await first;
    assert.equal(verifications, 1);
    assert.deepEqual(domain.recordedResult(projectId, command.key), result);
    assert.deepEqual(result, {
      version: 2,
      repositories: [
        {
          codeHost: "github",
          host: "github.com",
          repositoryId: "R_1",
          path: root,
          ref: "main",
          gitCommonDirectory: root,
        },
      ],
    });

    db.close();
    db = new DatabaseSync(filename);
    new Store(db).ensureHost("test");
    domain = new DomainStore(db);
    domain.migrate();
    assert.deepEqual(await new DomainCommands(domain).execute(command), result);
    assert.equal(verifications, 1);
  } finally {
    release();
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("existing standalone projects acquire inactive source configuration on migration", () => {
  const root = mkdtempSync(join(tmpdir(), "cab-github-migration-"));
  const db = new DatabaseSync(join(root, "db.sqlite"));
  const projectId = randomUUID();
  try {
    new Store(db).ensureHost("test");
    const domain = new DomainStore(db);
    domain.migrate();
    domain.execute({
      type: "project.create",
      actor: "operator",
      key: randomUUID(),
      projectId,
      name: "Existing",
      leadProfileId: null,
    });
    const rawReadiness = (id: string) =>
      String(
        (
          db
            .prepare(
              "SELECT readiness FROM project_task_sources WHERE projectId = ?",
            )
            .get(id) as { readiness: string }
        ).readiness,
      );
    // A new project stores no readiness rule, not a hardcoded label.
    assert.equal(rawReadiness(projectId), "null");
    assert.equal(domain.githubConfiguration(projectId).readiness, null);
    db.prepare("DELETE FROM project_task_sources WHERE projectId = ?").run(
      projectId,
    );
    domain.migrate();
    assert.equal(domain.githubConfiguration(projectId).version, 1);
    assert.equal(domain.githubConfiguration(projectId).readiness, null);
    assert.equal(rawReadiness(projectId), "null");
    assert.deepEqual(domain.githubActiveSelectionIds(projectId), []);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("saved readiness rules, including label ready, are untouched by migration and restart", () => {
  const root = mkdtempSync(join(tmpdir(), "cab-github-saved-rules-"));
  const file = join(root, "db.sqlite");
  let db = new DatabaseSync(file);
  const rules = {
    [randomUUID()]:
      '{"mode":"all","conditions":[{"kind":"label","operator":"has","name":"ready"}]}',
    [randomUUID()]:
      '{"mode":"any","conditions":[{"kind":"label","operator":"has","name":"ready-for-agent"}]}',
  };
  const raw = () =>
    Object.keys(rules).map((id) =>
      String(
        (
          db
            .prepare(
              "SELECT readiness FROM project_task_sources WHERE projectId = ?",
            )
            .get(id) as { readiness: string }
        ).readiness,
      ),
    );
  try {
    new Store(db).ensureHost("test");
    let domain = new DomainStore(db);
    domain.migrate();
    for (const [projectId, rule] of Object.entries(rules)) {
      domain.execute({
        type: "project.create",
        actor: "operator",
        key: randomUUID(),
        projectId,
        name: projectId,
        leadProfileId: null,
      });
      // Rows written before no-rule defaults, stored exactly as they were.
      db.prepare(
        "UPDATE project_task_sources SET readiness = ? WHERE projectId = ?",
      ).run(rule, projectId);
    }
    domain.migrate();
    assert.deepEqual(raw(), Object.values(rules));
    db.close();
    db = new DatabaseSync(file);
    domain = new DomainStore(db);
    new Store(db).ensureHost("test");
    domain.migrate();
    assert.deepEqual(raw(), Object.values(rules));
    assert.deepEqual(
      Object.keys(rules).map((id) => domain.githubConfiguration(id).readiness),
      Object.values(rules).map((rule) => JSON.parse(rule) as unknown),
    );
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("readiness rule is added, removed and re-added through keyed, versioned configuration", () => {
  const root = mkdtempSync(join(tmpdir(), "cab-github-readiness-cycle-"));
  const db = new DatabaseSync(join(root, "db.sqlite"));
  const projectId = randomUUID();
  try {
    new Store(db).ensureHost("test");
    const domain = new DomainStore(db);
    domain.migrate();
    domain.execute({
      type: "project.create",
      actor: "operator",
      key: randomUUID(),
      projectId,
      name: "Cycle",
      leadProfileId: null,
    });
    const rule = {
      mode: "all" as const,
      conditions: [
        { kind: "label" as const, operator: "has" as const, name: "ready" },
      ],
    };
    const configure = (
      expectedVersion: number,
      readiness: typeof rule | null,
      key: string = randomUUID(),
    ) =>
      domain.execute({
        type: "github.configure",
        actor: "operator",
        key,
        projectId,
        expectedVersion,
        credentialRef: null,
        selections: [],
        readiness,
      });
    configure(1, rule);
    assert.deepEqual(domain.githubConfiguration(projectId).readiness, rule);
    const key = randomUUID();
    const removed = configure(2, null, key);
    assert.equal(domain.githubConfiguration(projectId).readiness, null);
    assert.equal(domain.githubConfiguration(projectId).version, 3);
    // An exact keyed replay of the removal returns its receipt without another bump.
    assert.deepEqual(configure(2, null, key), removed);
    assert.equal(domain.githubConfiguration(projectId).version, 3);
    assert.throws(() => configure(2, rule), /Version conflict/);
    configure(3, rule);
    assert.deepEqual(domain.githubConfiguration(projectId).readiness, rule);
    assert.equal(domain.githubConfiguration(projectId).version, 4);
    // No-rule is only ever null, never an empty condition list.
    assert.throws(() => configure(4, { mode: "all", conditions: [] as never }));
    assert.equal(domain.githubConfiguration(projectId).version, 4);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("the HTML project page names the readiness state and its form removes or sets a rule", async () => {
  const root = mkdtempSync(join(tmpdir(), "cab-github-readiness-html-"));
  const db = new DatabaseSync(join(root, "db.sqlite"));
  const projectId = randomUUID();
  try {
    new Store(db).ensureHost("test");
    const domain = new DomainStore(db);
    domain.migrate();
    domain.execute({
      type: "project.create",
      actor: "operator",
      key: randomUUID(),
      projectId,
      name: "Html",
      leadProfileId: null,
    });
    const ui = new LocalOperatorUi(domain);
    const noRule =
      /No readiness rule: open issues in active selections are not filtered/;
    assert.match(ui.project(projectId), noRule);
    assert.match(
      ui.project(projectId),
      /<textarea name="readiness">null<\/textarea>/,
    );
    const submit = (readiness: string) =>
      ui.submit({
        type: "github.configure",
        key: randomUUID(),
        projectId,
        expectedVersion: String(domain.githubConfiguration(projectId).version),
        selections: "[]",
        readiness,
      });
    await submit(
      JSON.stringify({
        mode: "all",
        conditions: [
          { kind: "label", operator: "has", name: "ready-for-agent" },
        ],
      }),
    );
    assert.match(
      ui.project(projectId),
      /Readiness rule: label `ready-for-agent`\./,
    );
    await submit("null");
    assert.equal(domain.githubConfiguration(projectId).readiness, null);
    assert.equal(domain.githubConfiguration(projectId).version, 3);
    assert.match(ui.project(projectId), noRule);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("the HTML project page saves repository links through their own form", async () => {
  const root = mkdtempSync(join(tmpdir(), "cab-github-links-html-"));
  const db = new DatabaseSync(join(root, "db.sqlite"));
  const projectId = randomUUID();
  try {
    new Store(db).ensureHost("test");
    const domain = new DomainStore(db, undefined, async (input) => ({
      ...input,
      gitCommonDirectory: `${root}/.git`,
    }));
    domain.migrate();
    domain.execute({
      type: "project.create",
      actor: "operator",
      key: randomUUID(),
      projectId,
      name: "Links",
      leadProfileId: null,
    });
    const ui = new LocalOperatorUi(domain);
    const html = () => ui.project(projectId);
    assert.match(html(), /data-command="repositories\.configure"/);
    // The source form no longer carries the links.
    assert.equal(html().match(/name="repositories"/g)?.length, 1);
    await ui.submit({
      type: "repositories.configure",
      key: randomUUID(),
      projectId,
      expectedVersion: "1",
      repositories: JSON.stringify([link("R_1", root)]),
    });
    assert.equal(domain.repositoryLinks(projectId).version, 2);
    assert.equal(domain.githubConfiguration(projectId).version, 1);
    assert.match(html(), /&quot;repositoryId&quot;: &quot;R_1&quot;/);
    assert.doesNotMatch(html(), /gitCommonDirectory/);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("closed-issue mode defaults to skip and changes only through keyed, versioned configuration", async () => {
  const root = mkdtempSync(join(tmpdir(), "cab-github-closed-mode-"));
  const db = new DatabaseSync(join(root, "db.sqlite"));
  const projectId = randomUUID();
  try {
    new Store(db).ensureHost("test");
    const domain = new DomainStore(db);
    domain.migrate();
    domain.execute({
      type: "project.create",
      actor: "operator",
      key: randomUUID(),
      projectId,
      name: "Modes",
      leadProfileId: null,
    });
    assert.equal(domain.githubConfiguration(projectId).closedIssues, "skip");
    // A source saved before the mode existed reads as skip without a rewrite.
    restorePreviousSourceSchema(db);
    db.exec("ALTER TABLE project_github_sources DROP COLUMN closedIssues");
    db.prepare(
      "INSERT INTO project_github_sources (projectId, version, credentialRef, selections, readiness) VALUES (?, 1, NULL, '[]', 'null')",
    ).run(projectId);
    domain.migrate();
    const legacy = domain.githubConfiguration(projectId);
    assert.equal(legacy.closedIssues, "skip");
    assert.equal(legacy.version, 1);

    const configure = (
      key: string,
      expectedVersion: number,
      closedIssues?: "skip" | "done",
    ) =>
      domain.execute({
        type: "github.configure",
        actor: "operator",
        key,
        projectId,
        expectedVersion,
        credentialRef: null,
        selections: [],
        readiness: {
          mode: "all",
          conditions: [{ kind: "label", operator: "has", name: "ready" }],
        },
        ...(closedIssues ? { closedIssues } : {}),
      });
    const key = randomUUID();
    configure(key, 1, "done");
    assert.deepEqual(
      [
        domain.githubConfiguration(projectId).version,
        domain.githubConfiguration(projectId).closedIssues,
      ],
      [2, "done"],
    );
    configure(key, 1, "done");
    assert.equal(domain.githubConfiguration(projectId).version, 2);
    assert.throws(() => configure(randomUUID(), 1, "skip"));
    configure(randomUUID(), 2);
    assert.deepEqual(
      [
        domain.githubConfiguration(projectId).version,
        domain.githubConfiguration(projectId).closedIssues,
      ],
      [3, "done"],
    );
    assert.throws(() =>
      db
        .prepare(
          "UPDATE project_task_sources SET closedIssues = 'closed' WHERE projectId = ?",
        )
        .run(projectId),
    );
    // The HTML fallback shows and saves the mode through the same command.
    const ui = new LocalOperatorUi(domain);
    assert.match(
      ui.project(projectId),
      /<select name="closedIssues">.*<option value="done" selected>Treat closure as Done<\/option>/,
    );
    const form = {
      type: "github.configure",
      projectId,
      sourceCredentialMode: "keep",
      selections: "[]",
      readiness: JSON.stringify({
        mode: "all",
        conditions: [{ kind: "label", operator: "has", name: "ready" }],
      }),
    };
    await assert.rejects(
      ui.submit({
        ...form,
        key: randomUUID(),
        expectedVersion: "3",
        closedIssues: "closed",
      }),
    );
    await ui.submit({
      ...form,
      key: randomUUID(),
      expectedVersion: "3",
      closedIssues: "skip",
    });
    assert.deepEqual(
      [
        domain.githubConfiguration(projectId).version,
        domain.githubConfiguration(projectId).closedIssues,
      ],
      [4, "skip"],
    );
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("imported task provisioning requires the project's exact linked Git repository", async () => {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "cab-github-provision-")),
  );
  const repository = join(root, "source");
  mkdirSync(repository);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", repository, ...args], {
      encoding: "utf8",
    }).trim();
  git("init", "--initial-branch=main");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.invalid");
  writeFileSync(join(repository, "README.md"), "fixture\n");
  git("add", "README.md");
  git("commit", "-m", "fixture");
  const service = new StandaloneService(join(root, "data"), () => ({
    async start() {},
    async stop() {},
    onUnexpectedRequest() {},
    async startThread() {
      return "thread";
    },
    async resumeThread() {},
    async startTurn() {
      return "turn";
    },
    async interruptTurn() {},
    async waitForTurn() {
      return "completed" as const;
    },
  }));
  const projectId = randomUUID();
  const importedId = randomUUID();
  const localId = randomUUID();
  try {
    await service.start();
    const domain = service.domain();
    domain.execute({
      type: "project.create",
      actor: "operator",
      key: randomUUID(),
      projectId,
      name: "Alpha",
      leadProfileId: null,
    });
    for (const { taskId, title } of [
      { taskId: importedId, title: "Imported" },
      { taskId: localId, title: "Local" },
    ])
      domain.execute({
        type: "task.create",
        actor: "operator",
        key: randomUUID(),
        projectId,
        taskId,
        title,
        outcome: title,
        ready: false,
      });
    domain.markImportedTask(importedId, "I_1", "R_1");
    await assert.rejects(
      service.provisionTask(importedId, [
        { repositoryId: "R_1", path: repository, ref: "main" },
      ]),
      /linked repository/i,
    );
    await assert.rejects(
      service.provisionTask(importedId, [
        { repositoryId: "R_1", path: root, ref: "main" },
      ]),
      /linked repository/i,
    );
    await domain.execute({
      type: "github.configure",
      actor: "operator",
      key: randomUUID(),
      projectId,
      expectedVersion: 1,
      credentialRef: "env:CAB_TEST_GITHUB",
      selections: [
        {
          id: "repo",
          kind: "repository",
          repositoryId: "R_1",
          owner: "org",
          name: "repo",
        },
      ],
      readiness: {
        mode: "any",
        conditions: [{ kind: "label", operator: "has", name: "ready" }],
      },
    });
    await domain.configureRepositories({
      type: "repositories.configure",
      actor: "operator",
      key: randomUUID(),
      projectId,
      expectedVersion: 1,
      repositories: [link("R_1", repository)],
    });
    await assert.rejects(
      service.provisionTask(importedId, [
        { repositoryId: "R_1", path: repository, ref: "HEAD" },
      ]),
      /linked repository/i,
    );
    const binding = await service.provisionTask(importedId, [
      { repositoryId: "R_1", path: repository, ref: "main" },
    ]);
    assert.equal(binding.state, "ready");
    const delayedImportedId = randomUUID();
    domain.execute({
      type: "task.create",
      actor: "operator",
      key: randomUUID(),
      projectId,
      taskId: delayedImportedId,
      title: "Delayed import",
      outcome: "Verify stale grant",
      ready: false,
    });
    domain.markImportedTask(delayedImportedId, "I_2", "R_1");
    const delayedProvision = service.provisionTask(delayedImportedId, [
      { repositoryId: "R_1", path: repository, ref: "main" },
    ]);
    domain.execute({
      type: "repositories.configure",
      actor: "operator",
      key: randomUUID(),
      projectId,
      expectedVersion: 2,
      repositories: [],
    });
    await assert.rejects(
      delayedProvision,
      /grant changed during verification/i,
    );
    assert.equal(await service.taskWorkspace(delayedImportedId), undefined);
    const local = await service.provisionTask(localId);
    assert.equal(local.state, "ready");
  } finally {
    await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});
