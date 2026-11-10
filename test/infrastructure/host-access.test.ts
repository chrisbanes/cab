import assert from "node:assert/strict";
import { test } from "node:test";
import {
  once,
  processIdentityProbe,
  slashTmpProbe,
} from "../fixtures/host-access.js";

const denied = (code: string) =>
  Object.assign(new Error(`spawnSync ps ${code}`), { code });

test("a denied or failing ps gives a process-identity skip reason; a start time allows the tests", () => {
  assert.match(
    processIdentityProbe(() => ({ error: denied("EPERM"), status: null })) ||
      "",
    /^process identity is unavailable here: ps failed to run \(EPERM\)$/,
  );
  assert.match(
    processIdentityProbe(() => ({ status: 1, stdout: "" })) || "",
    /ps exited 1 without a start time/,
  );
  assert.match(
    processIdentityProbe(() => ({ status: 0, stdout: "  \n" })) || "",
    /ps exited 0 without a start time/,
  );
  assert.equal(
    processIdentityProbe(() => ({
      status: 0,
      stdout: "Tue Nov 10 09:46:53 2026\n",
    })),
    false,
  );
});

test("a denied /tmp directory gives a skip reason; an allowed one is removed and allows the tests", () => {
  for (const code of ["EPERM", "EACCES", "EROFS"])
    assert.equal(
      slashTmpProbe(
        () => {
          throw Object.assign(new Error(code), { code });
        },
        () => assert.fail("nothing to remove"),
      ),
      `writing directly under /tmp is denied here (${code})`,
    );
  const created: string[] = [],
    removed: string[] = [];
  assert.equal(
    slashTmpProbe(
      (path) => created.push(path),
      (path) => removed.push(path),
    ),
    false,
  );
  assert.equal(created.length, 1);
  assert.match(created[0]!, /^\/tmp\/cab-probe-[0-9a-f-]{36}$/);
  assert.deepEqual(removed, created);
  // An unrelated failure is a broken host, not a sandbox denial.
  assert.throws(
    () =>
      slashTmpProbe(() => {
        throw Object.assign(new Error("ENOSPC"), { code: "ENOSPC" });
      }),
    /ENOSPC/,
  );
});

test("a probe runs once and every later call returns its first answer", () => {
  let calls = 0;
  const probe = once(() => (++calls === 1 ? "denied" : false), false);
  assert.equal(probe(), "denied");
  assert.equal(probe(), "denied");
  assert.equal(calls, 1);
});

test("in CI a denial fails instead of skipping, and allowed access still runs the tests", () => {
  const denied = once(() => "ps failed to run (EPERM)", true);
  assert.throws(
    denied,
    /^Error: CI must allow this access: ps failed to run \(EPERM\)$/,
  );
  assert.throws(denied, /CI must allow this access/);
  assert.equal(once(() => false, true)(), false);
});
