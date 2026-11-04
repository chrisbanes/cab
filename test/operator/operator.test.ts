import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { tmpdir } from "../fixtures/temp.js";
import { OperatorAuth } from "../../src/standalone/operator-auth.js";

async function openAuth(
  options: Partial<Parameters<typeof OperatorAuth.open>[0]> = {},
) {
  const directory = mkdtempSync(join(tmpdir(), "cab-auth-limits-"));
  chmodSync(directory, 0o700);
  const authFile = join(directory, "operator-auth.json");
  await OperatorAuth.initialize(authFile, "session limit operator password");
  const auth = await OperatorAuth.open({
    authFile,
    origin: "http://127.0.0.1:1",
    ...options,
  });
  return { auth, directory };
}
const sessionCount = (auth: OperatorAuth) =>
  (auth as unknown as { sessions: Map<string, unknown> }).sessions.size;

test("a full session table evicts the oldest anonymous session and keeps authenticated ones", async () => {
  let clock = 1;
  const { auth, directory } = await openAuth({ now: () => clock++ });
  try {
    const first = auth.createAnonymousSession();
    const signedIn = await auth.authenticate(
      first.id,
      "session limit operator password",
    );
    assert.equal(signedIn?.authenticated, true);
    const anonymous = Array.from({ length: 255 }, () =>
      auth.createAnonymousSession(),
    );
    assert.equal(sessionCount(auth), 256);
    const newest = auth.createAnonymousSession();
    assert.equal(sessionCount(auth), 256);
    assert.equal(auth.getSession(signedIn?.id ?? "")?.authenticated, true);
    assert.equal(auth.getSession(anonymous[0]?.id ?? ""), undefined);
    assert.ok(auth.getSession(anonymous[1]?.id ?? ""));
    assert.ok(auth.getSession(newest.id));
  } finally {
    auth.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("at most four password derivations run at once", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started = 0;
  const { auth, directory } = await openAuth({
    derivePassword: async () => {
      started += 1;
      await gate;
      return Buffer.alloc(32);
    },
  });
  try {
    const ids = Array.from(
      { length: 5 },
      () => auth.createAnonymousSession().id,
    );
    const running = ids
      .slice(0, 4)
      .map((id) => auth.authenticate(id, "wrong password"));
    assert.equal(
      await auth.authenticate(ids[4] ?? "", "wrong password"),
      undefined,
    );
    assert.equal(started, 4);
    release();
    assert.deepEqual(await Promise.all(running), [
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
  } finally {
    auth.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
