import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import {
  managedAssignmentEnvironment,
  OperatorCredentialStore,
} from "../../src/standalone/operator-credentials.js";

const DAY = 24 * 60 * 60 * 1000;

function fixture(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), "cab-credentials-"));
  const path = join(dir, "state.db");
  const db = new DatabaseSync(path);
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { db, path, store: new OperatorCredentialStore(db) };
}

test("issued tokens are revealed once and only verifiers persist", (t) => {
  const { db, store } = fixture(t);
  const now = 1_000_000;
  const issued = store.issue({ name: "laptop", scope: "read" }, now);
  assert.match(issued.token, /^ens_[0-9a-f-]{36}_[A-Za-z0-9_-]{43}$/);
  assert.equal(issued.credential.expiresAt, now + 90 * DAY);
  assert.equal(issued.credential.state, "active");
  const secret = issued.token.split("_").slice(2).join("_");
  const rows = db.prepare("SELECT * FROM operator_cli_credentials").all();
  const dump = JSON.stringify(rows);
  assert.ok(!dump.includes(secret));
  assert.ok(!dump.includes(issued.token));
  const listed = store.list(now);
  assert.equal(listed.length, 1);
  assert.deepEqual(Object.keys(listed[0] ?? {}).sort(), [
    "createdAt",
    "expiresAt",
    "id",
    "lastUsedAt",
    "name",
    "replacesId",
    "revokedAt",
    "scope",
    "state",
  ]);
  assert.ok(!JSON.stringify(listed).includes(secret));
  assert.equal(
    store.issue({ name: "short", scope: "read-write", expiresInDays: 7 }, now)
      .credential.expiresAt,
    now + 7 * DAY,
  );
  for (const expiresInDays of [0, 91, 1.5])
    assert.throws(() =>
      store.issue({ name: "x", scope: "read", expiresInDays }, now),
    );
  assert.throws(() => store.issue({ name: "", scope: "read" }, now));
  assert.throws(() => store.issue({ name: "a\nb", scope: "read" }, now));
  assert.throws(() => store.issue({ name: "x", scope: "admin" }, now));
});

test("verify rejects every invalid token uniformly", (t) => {
  const { store } = fixture(t);
  const now = 5_000_000;
  const { token, credential } = store.issue(
    { name: "agent", scope: "read-write", expiresInDays: 1 },
    now,
  );
  assert.deepEqual(store.verify(token, now + 1), {
    id: credential.id,
    name: "agent",
    scope: "read-write",
    createdAt: now,
    expiresAt: now + DAY,
  });
  const wrongSecret = `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`;
  for (const bad of [
    "",
    "Bearer",
    "ens_bad",
    `ens_${crypto.randomUUID()}_${token.slice(-43)}`,
    wrongSecret,
  ])
    assert.equal(store.verify(bad, now), undefined);
  assert.equal(store.verify(token, now + DAY), undefined, "expired");
  store.revoke(credential.id, now + 2);
  assert.equal(store.verify(token, now + 3), undefined, "revoked");
  assert.equal(store.list(now + 3)[0]?.state, "revoked");
});

test("rotation keeps the old credential active until revoked", (t) => {
  const { store } = fixture(t);
  const now = 10_000_000;
  const old = store.issue({ name: "agent", scope: "read-write" }, now);
  const replacement = store.rotate(old.credential.id, 30, now + 1);
  assert.equal(replacement.credential.replacesId, old.credential.id);
  assert.equal(replacement.credential.name, "agent");
  assert.equal(replacement.credential.scope, "read-write");
  assert.equal(replacement.credential.expiresAt, now + 1 + 30 * DAY);
  assert.ok(store.verify(old.token, now + 2));
  assert.ok(store.verify(replacement.token, now + 2));
  store.revoke(old.credential.id, now + 3);
  assert.equal(store.verify(old.token, now + 4), undefined);
  assert.ok(store.verify(replacement.token, now + 4));
  assert.throws(() => store.rotate(old.credential.id, 90, now + 5), {
    code: "conflict",
  });
  assert.throws(() => store.rotate(crypto.randomUUID(), 90, now), {
    code: "not-found",
  });
});

test("last use is throttled to once per minute", (t) => {
  const { store } = fixture(t);
  const now = 20_000_000;
  const { token } = store.issue({ name: "a", scope: "read" }, now);
  assert.equal(store.list(now)[0]?.lastUsedAt, null);
  store.verify(token, now + 1000);
  assert.equal(store.list(now)[0]?.lastUsedAt, now + 1000);
  store.verify(token, now + 30_000);
  assert.equal(store.list(now)[0]?.lastUsedAt, now + 1000);
  store.verify(token, now + 61_000);
  assert.equal(store.list(now)[0]?.lastUsedAt, now + 61_000);
});

test("installation identity survives reopening the database", (t) => {
  const { db, path, store } = fixture(t);
  const id = store.installationId();
  assert.match(id, /^[0-9a-f-]{36}$/);
  const reopened = new DatabaseSync(path);
  try {
    assert.equal(new OperatorCredentialStore(reopened).installationId(), id);
  } finally {
    reopened.close();
  }
  assert.equal(new OperatorCredentialStore(db).installationId(), id);
});

test("managed assignment environment marks children and drops CLI selection", () => {
  assert.deepEqual(
    managedAssignmentEnvironment({
      PATH: "/bin",
      CAB_CONNECTION: "home",
      CAB_CLI_CONFIG_DIR: "/tmp/cli",
      CAB_CLI_ANYTHING: "x",
      CAB_OTHER: "kept",
    }),
    {
      PATH: "/bin",
      CAB_OTHER: "kept",
      CAB_MANAGED_ASSIGNMENT: "1",
    },
  );
});
