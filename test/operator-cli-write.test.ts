import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { type AddressInfo, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CliError } from "../src/cli/connections.js";
import { EXIT } from "../src/cli/main.js";
import { RequestJournal } from "../src/cli/request-journal.js";
import { ServiceClient } from "../src/cli/transport.js";
import type { CliDeps } from "../src/cli/types.js";
import {
  type Session,
  sendCommand,
  type WriteContext,
} from "../src/cli/write.js";
import { fakeServer, harness } from "./fixtures/cli-harness.js";
import { startCliService } from "./fixtures/operator-cli.js";

// biome-ignore lint/suspicious/noExplicitAny: parsed CLI envelopes are asserted structurally
type Json = Record<string, any>;
type After = { after(fn: () => unknown): void };

const token = `ens_${randomUUID()}_${"a".repeat(43)}`;
const secret = "write-secret-instruction-896";
const service = randomUUID();
const key = randomUUID();
const command = {
  type: "capacity.configure",
  key,
  globalLimit: 3,
  projectOverrides: {},
  note: secret,
};
const receipt = {
  kind: "configuration",
  key,
  recorded: true,
  result: {
    commandType: "capacity.configure",
    resourceId: "system:capacity",
    globalLimit: 3,
    defaultProjectLimit: 2,
    projectOverrides: {},
  },
};

function drive(t: After, origin: string, fetcher: typeof fetch) {
  const dir = mkdtempSync(join(tmpdir(), "ensemble-write-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const journal = new RequestJournal(join(dir, "config"));
  const session = {
    name: "home",
    client: new ServiceClient(origin, token, fetcher),
    identity: { service: { installationId: service } },
  } as unknown as Session;
  const ctx = {
    journal,
    deps: { commandTimeoutMs: 200 } as CliDeps,
  } as unknown as WriteContext;
  const lines = () => {
    try {
      return readFileSync(join(dir, "config", "requests.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as Json);
    } catch {
      return [];
    }
  };
  const send = () =>
    sendCommand(ctx, session, {
      scope: "system:capacity",
      type: "capacity.configure",
      key,
      digest: "d".repeat(64),
      resource: "system:capacity",
      command,
    });
  return { dir, journal, lines, send };
}

const respond =
  (status: number, body: unknown, headers: Record<string, string> = {}) =>
  async () =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", ...headers },
    });
const apiError = (code: string, fieldPaths?: string[]) => ({
  error: { code, message: code, ...(fieldPaths ? { fieldPaths } : {}) },
});
const thrown = (code: string) => async () => {
  throw new TypeError("fetch failed", { cause: { code } });
};

test("write transport classifies every outcome and journals before sending", async (t) => {
  const origin = "http://127.0.0.1:9";
  const cases: [string, typeof fetch, string, string][] = [
    ["receipt", respond(200, receipt), "ok", "recorded"],
    [
      "unparseable 2xx",
      respond(200, "not json"),
      "command-outcome-unknown",
      "unknown",
    ],
    [
      "other key",
      respond(200, { ...receipt, key: randomUUID() }),
      "command-outcome-unknown",
      "unknown",
    ],
    [
      "other resource",
      respond(200, {
        ...receipt,
        result: { ...receipt.result, commandType: "discovery.configure" },
      }),
      "command-outcome-unknown",
      "unknown",
    ],
    [
      "reset after send",
      thrown("ECONNRESET"),
      "command-outcome-unknown",
      "unknown",
    ],
    ["502", respond(502, "bad gateway"), "command-outcome-unknown", "unknown"],
    [
      "503 unknown",
      respond(503, apiError("command-outcome-unknown")),
      "command-outcome-unknown",
      "unknown",
    ],
    ["refused", thrown("ECONNREFUSED"), "unavailable", "rejected"],
    ["dns", thrown("ENOTFOUND"), "unavailable", "rejected"],
    [
      "tls",
      thrown("DEPTH_ZERO_SELF_SIGNED_CERT"),
      "tls-verification-failed",
      "rejected",
    ],
    [
      "401",
      respond(401, apiError("credential-invalid")),
      "credential-invalid",
      "rejected",
    ],
    [
      "403 scope",
      respond(403, apiError("insufficient-scope")),
      "insufficient-scope",
      "rejected",
    ],
    [
      "403 policy",
      respond(403, apiError("forbidden")),
      "policy-denied",
      "rejected",
    ],
    ["409", respond(409, apiError("conflict")), "conflict", "rejected"],
    [
      "400",
      respond(400, apiError("invalid-input", ["globalLimit"])),
      "invalid-input",
      "rejected",
    ],
  ];
  const exits: Record<string, number> = {
    "command-outcome-unknown": 6,
    unavailable: 5,
    "tls-verification-failed": 5,
    "credential-invalid": 3,
    "insufficient-scope": 3,
    "policy-denied": 4,
    conflict: 4,
    "invalid-input": 2,
  };
  for (const [name, fetcher, code, settled] of cases) {
    let sawSending = false;
    const d = drive(t, origin, async (input, init) => {
      // The identity is durable, owner-only and body-free before any byte is sent.
      const [line] = d.lines();
      assert.deepEqual(
        { ...line, at: 0 },
        {
          at: 0,
          state: "sending",
          service,
          scope: "system:capacity",
          type: "capacity.configure",
          key,
          digest: "d".repeat(64),
        },
      );
      assert.equal(
        statSync(join(d.dir, "config", "requests.jsonl")).mode & 0o777,
        0o600,
      );
      assert.equal(statSync(join(d.dir, "config")).mode & 0o777, 0o700);
      sawSending = true;
      return fetcher(input, init);
    });
    try {
      const result = await d.send();
      assert.equal(code, "ok", name);
      assert.deepEqual(result.receipt, receipt);
    } catch (error) {
      assert.ok(error instanceof CliError, name);
      assert.equal(error.code, code, name);
      assert.equal(EXIT[error.code]?.[0], exits[code], name);
      assert.deepEqual(
        error.extra.request,
        { service, scope: "system:capacity", type: "capacity.configure", key },
        name,
      );
      if (code === "command-outcome-unknown") {
        assert.equal(error.extra.retryable, true, name);
        assert.match(error.message, /ensemble operation get/);
      }
      if (code === "invalid-input") assert.match(error.message, /globalLimit/);
    }
    assert.ok(sawSending, name);
    assert.deepEqual(
      d.lines().map((l) => l.state),
      ["sending", settled],
      name,
    );
    const text = readFileSync(join(d.dir, "config", "requests.jsonl"), "utf8");
    assert.ok(!text.includes(secret) && !text.includes(token), name);
  }
});

test("timeouts are unknown and redirects never forward the credential", async (t) => {
  const silent = await fakeServer(t, () => undefined);
  const timeout = drive(t, silent.origin, fetch);
  await assert.rejects(timeout.send(), { code: "command-outcome-unknown" });

  const other = await fakeServer(t, (_q, response) => response.end("{}"));
  const redirect = await fakeServer(t, (_q, response) =>
    response
      .writeHead(307, { location: `${other.origin}/api/operator/commands` })
      .end(),
  );
  const d = drive(t, redirect.origin, fetch);
  await assert.rejects(d.send(), (error: CliError) => {
    assert.equal(error.code, "redirect-rejected");
    assert.equal(EXIT[error.code]?.[0], 5);
    return true;
  });
  assert.deepEqual(other.hits, []);
  assert.match(
    redirect.hits[0] ?? "",
    /^POST \/api\/operator\/commands Bearer ens_/,
  );

  const closed = createServer();
  await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
  const { port } = closed.address() as AddressInfo;
  await new Promise((resolve) => closed.close(resolve));
  const refused = drive(t, `http://127.0.0.1:${port}`, fetch);
  await assert.rejects(refused.send(), { code: "unavailable" });
});

test("the journal finds earlier keys, keeps concurrent lines and fails closed", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ensemble-journal-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const a = new RequestJournal(dir),
    b = new RequestJournal(dir);
  const identity = (k: string) => ({
    service,
    scope: "system:capacity",
    type: "capacity.configure",
    key: k,
  });
  const keys = Array.from({ length: 40 }, () => randomUUID());
  await Promise.all(
    keys.map((k, i) =>
      (i % 2 ? a : b).append(identity(k), `digest-${i}`, "sending"),
    ),
  );
  const text = readFileSync(join(dir, "requests.jsonl"), "utf8");
  assert.equal(text.trim().split("\n").length, 40);
  assert.equal(await a.find(service, "digest-7"), keys[7]);
  assert.equal(await a.find(randomUUID(), "digest-7"), undefined);
  // A key whose latest state is rejected is not offered for reuse.
  await a.append(identity(keys[3] ?? ""), "digest-3", "rejected");
  assert.equal(await a.find(service, "digest-3"), undefined);
  const retry = randomUUID();
  await a.append(identity(retry), "digest-3", "sending");
  assert.equal(await a.find(service, "digest-3"), retry);
  // A rejected retry of a key that may have been applied keeps the key.
  await a.append(identity(retry), "digest-3", "unknown");
  await a.append(identity(retry), "digest-3", "rejected");
  assert.equal(await a.find(service, "digest-3"), retry);
  assert.equal((await a.state(identity(retry)))?.reached, true);
  await b.append(identity(keys[7] ?? ""), "digest-7", "unknown");
  assert.deepEqual(await a.state(identity(keys[7] ?? "")), {
    state: "unknown",
    digest: "digest-7",
    reached: true,
  });

  const blocked = join(dir, "blocked");
  writeFileSync(blocked, "not a directory");
  let fetched = false;
  const ctx = {
    journal: new RequestJournal(join(blocked, "config")),
    deps: {} as CliDeps,
  } as unknown as WriteContext;
  await assert.rejects(
    sendCommand(
      ctx,
      {
        name: "home",
        client: new ServiceClient("http://127.0.0.1:9", token, async () => {
          fetched = true;
          return new Response("{}");
        }),
        identity: { service: { installationId: service } },
      } as unknown as Session,
      {
        scope: "system:capacity",
        type: "capacity.configure",
        key,
        digest: "d",
        resource: "system:capacity",
        command,
      },
    ),
    (error: CliError) => {
      assert.equal(error.code, "journal-unavailable");
      assert.equal(EXIT[error.code]?.[0], 5);
      return true;
    },
  );
  assert.equal(fetched, false);
});

test("operation get reads receipts by scope and type only", async (t) => {
  const s = await startCliService(t);
  const h = harness(t);
  const read = await s.issue("read", "op-ro");
  const login = await h.run([
    "auth",
    "login",
    "--connection",
    "home",
    "--url",
    s.origin,
    "--token-file",
    h.tokenFile(read.token),
  ]);
  assert.equal(login.code, 0, login.err);
  const installationId = (
    (await (await s.bearer(read.token, "/api/operator/cli")).json()) as Json
  ).service.installationId;
  const capacityKey = randomUUID();
  const posted = await s.sessionPost("/api/operator/commands", {
    type: "capacity.configure",
    key: capacityKey,
    globalLimit: 5,
    projectOverrides: {},
  });
  assert.equal(posted.status, 200);
  const postedReceipt = await posted.json();

  const before = h.fetches.length;
  for (const args of [
    ["operation", "get", capacityKey, "--type", "capacity.configure"],
    ["operation", "get", capacityKey, "--scope", "system:capacity"],
    [
      "operation",
      "get",
      "nope",
      "--scope",
      "system:capacity",
      "--type",
      "capacity.configure",
    ],
    [
      "operation",
      "get",
      capacityKey,
      "--scope",
      "system:other",
      "--type",
      "capacity.configure",
    ],
    [
      "operation",
      "get",
      capacityKey,
      "--scope",
      "system:capacity",
      "--type",
      "task.create",
    ],
    [
      "operation",
      "get",
      capacityKey,
      "--scope",
      "system:capacity",
      "--type",
      "capacity.configure",
      "--limit",
      "5",
    ],
    [
      "operation",
      "get",
      "--scope",
      "system:capacity",
      "--type",
      "capacity.configure",
    ],
  ]) {
    const r = await h.run(args);
    assert.equal(r.code, 2, args.join(" "));
  }
  assert.equal(h.fetches.length, before, "no request before argument checks");

  const request = {
    service: installationId,
    scope: "system:capacity",
    type: "capacity.configure",
    key: capacityKey,
  };
  const journal = new RequestJournal(h.configDir);
  await journal.append(request, "e".repeat(64), "unknown");
  const args = [
    "operation",
    "get",
    capacityKey,
    "--scope",
    "system:capacity",
    "--type",
    "capacity.configure",
  ];
  let r = await h.run([...args, "--output", "json"]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(r.json().data, {
    state: "recorded",
    receipt: postedReceipt,
  });
  assert.deepEqual(r.json().request, request);
  assert.deepEqual(await journal.state(request), {
    state: "recorded",
    digest: "e".repeat(64),
    reached: true,
  });
  r = await h.run(args);
  assert.equal(r.code, 0);
  assert.match(r.out, /^Recorded: capacity.configure system:capacity/);
  assert.match(r.out, /globalLimit: +5/);

  const other = await h.run([
    "operation",
    "get",
    capacityKey,
    "--scope",
    `project:${s.projectId}`,
    "--type",
    "project.configure",
    "--output",
    "json",
  ]);
  assert.equal(other.code, 0, other.err);
  assert.deepEqual(other.json().data, { state: "not-recorded" });
  const human = await h.run([
    "operation",
    "get",
    capacityKey,
    "--scope",
    `project:${s.projectId}`,
    "--type",
    "project.configure",
  ]);
  assert.match(human.out, /^Not recorded/);

  // A task receipt in the project scope is not a project configuration receipt.
  const taskKey = randomUUID();
  const task = await s.sessionPost("/api/operator/commands", {
    type: "task.create",
    key: taskKey,
    projectId: s.projectId,
    taskId: randomUUID(),
    title: "Other",
    outcome: "Other",
    ready: false,
  });
  assert.equal(task.status, 200);
  r = await h.run([
    "operation",
    "get",
    taskKey,
    "--scope",
    `project:${s.projectId}`,
    "--type",
    "project.configure",
    "--output",
    "json",
  ]);
  assert.equal(r.code, 4, r.out);
  assert.equal(r.json().error.code, "conflict");

  r = await h.run(args, {
    env: {
      ENSEMBLE_CLI_CONFIG_DIR: h.configDir,
      ENSEMBLE_MANAGED_ASSIGNMENT: "1",
    },
  });
  assert.equal(r.code, 3);
  assert.match(r.err, /managed-assignment/);
});

test("operation get requires the operation.read capability before any read", async (t) => {
  const h = harness(t);
  const installationId = randomUUID();
  const fake = await fakeServer(t, (_q, response) =>
    response.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify({
        apiVersion: 1,
        capabilities: ["cli.identity", "task.read"],
        service: { installationId, origin: "https://ensemble.example" },
        credential: {
          id: randomUUID(),
          name: "fake",
          scope: "read",
          createdAt: 1,
          expiresAt: Date.now() + 86_400_000,
        },
      }),
    ),
  );
  const login = await h.run([
    "auth",
    "login",
    "--connection",
    "fake",
    "--url",
    fake.origin,
    "--token-file",
    h.tokenFile(token),
  ]);
  assert.equal(login.code, 0, login.err);
  const r = await h.run([
    "operation",
    "get",
    key,
    "--scope",
    "system:capacity",
    "--type",
    "capacity.configure",
  ]);
  assert.equal(r.code, 7);
  assert.deepEqual(
    fake.hits.map((hit) => hit.split(" ")[1]),
    ["/api/operator/cli", "/api/operator/cli"],
  );
});
