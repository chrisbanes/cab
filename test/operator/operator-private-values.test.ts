import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import {
  profilePrivateValuesSchema,
  projectPrivateValuesSchema,
} from "../../src/operator/contracts.js";
import { OperatorApi } from "../../src/standalone/operator-api.js";
import { operatorRouteAuthority } from "../../src/standalone/operator-credentials.js";
import { databaseDigest } from "../fixtures/database-digest.js";
import { serveCli } from "../fixtures/operator-cli.js";
import { seedSettingsWorld } from "../fixtures/operator-settings.js";
import { createOperatorFixture } from "../fixtures/operator-web.js";

type After = Parameters<typeof serveCli>[0];

const SENTINELS = [
  "PRIVATE ATLAS INSTRUCTIONS",
  "PRIVATE MIRA INSTRUCTIONS",
  "PRIVATE ROUTING GUIDANCE",
  "PRIVATE SAVED QUERY",
];

/** The settings world (sentinel private values) served with the bearer path and a signed-in session. */
async function start(
  t: After,
  auth?: { now: () => number; idleTimeoutMs: number },
) {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const ids = await seedSettingsWorld(f);
  const s = await serveCli(t, f, { ...(auth ? { auth } : {}) });
  const api = new OperatorApi(f.service, [f.directory]);
  const d = f.service.domain();
  const projectPath = (id: string) =>
    `/api/operator/projects/${id}/private-values`;
  const profilePath = (id: string) =>
    `/api/operator/profiles/${id}/private-values`;
  return { ...s, ids, api, d, projectPath, profilePath };
}

test("a signed-in session reads exact private values with their versions", async (t) => {
  const s = await start(t);
  const atlas = projectPrivateValuesSchema.parse(
    await (await s.sessionGet(s.projectPath(s.ids.atlas))).json(),
  ).data;
  assert.equal(atlas.project.instructions, "PRIVATE ATLAS INSTRUCTIONS");
  assert.equal(atlas.project.version, Number(s.d.project(s.ids.atlas).version));
  assert.equal(
    atlas.project.instructionsRevision,
    Number(s.d.project(s.ids.atlas).instructionsRevision),
  );
  assert.equal(atlas.routing.version, Number(s.d.routing(s.ids.atlas).version));
  assert.equal(
    atlas.source.version,
    s.d.githubConfiguration(s.ids.atlas).version,
  );
  assert.deepEqual(atlas.source.searches, [
    { id: "S-2", query: "PRIVATE SAVED QUERY" },
  ]);
  assert.deepEqual(atlas.source.repositories, [
    { repositoryId: "acme/atlas", path: s.ids.checkout },
  ]);
  const relay = projectPrivateValuesSchema.parse(
    await (await s.sessionGet(s.projectPath(s.ids.relay))).json(),
  ).data;
  assert.equal(relay.routing.guidance, "PRIVATE ROUTING GUIDANCE");
  assert.equal(relay.routing.version, Number(s.d.routing(s.ids.relay).version));
  const profile = profilePrivateValuesSchema.parse(
    await (
      await s.sessionGet(s.profilePath(s.ids.profiles.Mira as string))
    ).json(),
  ).data;
  assert.equal(profile.profile.instructions, "PRIVATE MIRA INSTRUCTIONS");
  assert.equal(
    profile.profile.version,
    Number(s.d.profiles().find((p) => p.id === s.ids.profiles.Mira)?.version),
  );

  // Exact text: multi-byte, at the 16,000 limit, never truncated, redacted or omitted.
  const long = "日本é".repeat(5333) + "x"; // 16,000 UTF-16 units
  assert.equal(long.length, 16000);
  const current = s.d.project(s.ids.atlas);
  await s.api.execute({
    key: randomUUID(),
    type: "project.configure",
    projectId: s.ids.atlas,
    expectedVersion: Number(current.version),
    instructions: long,
  } as Parameters<OperatorApi["execute"]>[0]);
  const bytes = await (await s.sessionGet(s.projectPath(s.ids.atlas))).text();
  const stored = String(s.d.project(s.ids.atlas).instructions);
  assert.equal(stored, long);
  assert.equal(
    projectPrivateValuesSchema.parse(JSON.parse(bytes)).data.project
      .instructions,
    long,
  );

  // An empty value is an empty string.
  const emptyId = randomUUID();
  await s.api.execute({
    key: randomUUID(),
    type: "project.create",
    projectId: emptyId,
    name: "Empty",
    leadProfileId: null,
  } as Parameters<OperatorApi["execute"]>[0]);
  const empty = projectPrivateValuesSchema.parse(
    await (await s.sessionGet(s.projectPath(emptyId))).json(),
  ).data;
  assert.equal(empty.project.instructions, "");
  assert.equal(empty.routing.guidance, "");
  assert.deepEqual(empty.source.searches, []);

  const withQuery = await s.sessionGet(`${s.projectPath(s.ids.atlas)}?x=1`);
  assert.equal(withQuery.status, 400);
  assert.equal(
    (await s.sessionGet(`${s.profilePath(s.ids.profiles.Mira as string)}?x=1`))
      .status,
    400,
  );
});

test("read and read-write bearer credentials cannot read private values", async (t) => {
  const s = await start(t);
  const paths = [
    s.projectPath(s.ids.atlas),
    s.projectPath(s.ids.relay),
    s.profilePath(s.ids.profiles.Mira as string),
  ];
  for (const scope of ["read", "read-write"] as const) {
    const { token } = await s.issue(scope, `reveal-${scope}`);
    for (const path of paths)
      for (const headers of [{}, { cookie: s.cookie }]) {
        const r = await s.bearer(token, path, { headers });
        assert.equal(r.status, 403, `${scope} ${path}`);
        assert.equal(r.headers.get("set-cookie"), null);
        const body = await r.text();
        for (const sentinel of SENTINELS) assert.ok(!body.includes(sentinel));
      }
  }
  // The route table refuses it before any dispatch, whatever the method.
  const { token } = await s.issue("read-write", "reveal-post");
  const post = await s.bearer(token, paths[0] as string, {
    method: "POST",
    body: {},
  });
  assert.equal(post.status, 403);
});

test("a missing, anonymous, signed-out or expired session cannot read private values", async (t) => {
  let clock = Date.now();
  const s = await start(t, { now: () => clock, idleTimeoutMs: 1_000 });
  const path = s.projectPath(s.ids.atlas);
  const refused = async (headers: Record<string, string>, label: string) => {
    const r = await fetch(`${s.origin}${path}`, { headers });
    assert.equal(r.status, 401, label);
    const body = await r.text();
    for (const sentinel of SENTINELS)
      assert.ok(!body.includes(sentinel), label);
    const p = await fetch(
      `${s.origin}${s.profilePath(s.ids.profiles.Mira as string)}`,
      {
        headers,
      },
    );
    assert.equal(p.status, 401, label);
    assert.ok(!(await p.text()).includes("PRIVATE MIRA"), label);
  };
  await refused({}, "no cookie");
  const anonymous = await fetch(`${s.origin}/api/operator/session`);
  await refused(
    { cookie: anonymous.headers.get("set-cookie")?.split(";")[0] ?? "" },
    "anonymous session",
  );
  assert.equal((await s.sessionGet(path)).status, 200);

  const expiring = s.cookie;
  clock += 5_000;
  await refused({ cookie: expiring }, "expired session");

  const second = await start(t);
  const signedIn = second.cookie;
  assert.equal(
    (await second.sessionGet(second.projectPath(second.ids.atlas))).status,
    200,
  );
  const out = await second.sessionPost("/api/operator/logout", {});
  assert.equal(out.status, 200);
  const r = await fetch(
    `${second.origin}${second.projectPath(second.ids.atlas)}`,
    {
      headers: { cookie: signedIn },
    },
  );
  assert.equal(r.status, 401, "signed-out session");
  assert.ok(!(await r.text()).includes("PRIVATE ATLAS"));
});

test("private-values responses are no-store and nothing records a reveal", async (t) => {
  const s = await start(t);
  const chunks: string[] = [];
  const stderr = process.stderr.write.bind(process.stderr);
  const stdout = process.stdout.write.bind(process.stdout);
  const capture = (chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  };
  const before = databaseDigest(s.f);
  process.stderr.write = capture as typeof process.stderr.write;
  process.stdout.write = capture as typeof process.stdout.write;
  try {
    for (let i = 0; i < 5; i++) {
      const r = await s.sessionGet(s.projectPath(s.ids.atlas));
      assert.equal(r.status, 200);
      assert.equal(r.headers.get("cache-control"), "no-store");
      assert.equal(r.headers.get("etag"), null);
      assert.equal(r.headers.get("last-modified"), null);
      const p = await s.sessionGet(
        s.profilePath(s.ids.profiles.Mira as string),
      );
      assert.equal(p.status, 200);
      assert.equal(p.headers.get("cache-control"), "no-store");
      assert.equal(p.headers.get("etag"), null);
      await p.arrayBuffer();
      await r.arrayBuffer();
    }
  } finally {
    process.stderr.write = stderr;
    process.stdout.write = stdout;
  }
  assert.equal(databaseDigest(s.f), before);
  const logged = chunks.join("");
  for (const sentinel of SENTINELS) assert.ok(!logged.includes(sentinel));
});

test("private values stay out of configuration reads and CLI-visible reads", async (t) => {
  const s = await start(t);
  const read = await s.issue("read", "leak-ro");
  const write = await s.issue("read-write", "leak-rw");
  const paths = [
    `/api/operator/projects/${s.ids.atlas}/configuration`,
    `/api/operator/projects/${s.ids.relay}/configuration`,
    `/api/operator/profiles/${s.ids.profiles.Mira}/configuration`,
    `/api/operator/projects/${s.ids.atlas}`,
    `/api/operator/projects/${s.ids.relay}`,
    "/api/operator/task-list",
    "/api/operator/inbox",
    "/api/operator/workspace",
    "/api/operator/source-observations",
    "/api/operator/search?q=PRIVATE",
    "/api/operator/search?q=atlas",
  ];
  const leaks = [
    "PRIVATE ROUTING GUIDANCE",
    "PRIVATE SAVED QUERY",
    s.ids.checkout,
  ];
  const fetches = [
    (path: string) => s.sessionGet(path),
    (path: string) => s.bearer(read.token, path),
    (path: string) => s.bearer(write.token, path),
  ];
  for (const get of fetches)
    for (const path of paths) {
      const body = await (await get(path)).text();
      for (const leak of leaks)
        assert.ok(!body.includes(leak), `${path} ${leak}`);
    }
});

test("an unknown project or profile id is not found and leaks nothing", async (t) => {
  const s = await start(t);
  for (const path of [
    s.projectPath(randomUUID()),
    s.profilePath(randomUUID()),
  ]) {
    const r = await s.sessionGet(path);
    assert.equal(r.status, 404, path);
    const body = await r.text();
    for (const sentinel of SENTINELS) assert.ok(!body.includes(sentinel));
  }
  for (const path of [s.projectPath("not-a-uuid"), s.profilePath("not-a-uuid")])
    assert.equal((await s.sessionGet(path)).status, 400, path);
});

test("the reads refuse without a current session even when routed past the route table", async (t) => {
  const s = await start(t);
  const mira = s.ids.profiles.Mira as string;
  const status = (call: () => unknown) => {
    try {
      call();
    } catch (error) {
      return (error as { status?: number }).status;
    }
    return undefined;
  };
  const stale = { ownerKey: "k".repeat(64), current: () => false };
  const wrongOwner = { ownerKey: "short", current: () => true };
  for (const [label, call] of [
    [
      "project without context",
      () => s.api.readProjectPrivateValues(s.ids.atlas),
    ],
    ["profile without context", () => s.api.readProfilePrivateValues(mira)],
  ] as const)
    assert.equal(status(call), 403, label);
  assert.equal(
    status(() => s.api.readProjectPrivateValues(s.ids.atlas, stale)),
    401,
  );
  assert.equal(
    status(() => s.api.readProfilePrivateValues(mira, stale)),
    401,
  );
  assert.equal(
    status(() => s.api.readProjectPrivateValues(s.ids.atlas, wrongOwner)),
    403,
  );
  for (const path of [s.projectPath(s.ids.atlas), s.profilePath(mira)])
    assert.equal(operatorRouteAuthority("GET", path), "session-only", path);
});
