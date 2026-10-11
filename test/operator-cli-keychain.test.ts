import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { test } from "node:test";
import {
  KeychainCredentialStore,
  runSecurity,
  type SecurityRunner,
} from "../src/cli/connections.js";

const live =
  process.platform === "darwin" && process.env.ENSEMBLE_KEYCHAIN_LIVE === "1";

test("the macOS Keychain stores, reads and deletes a token without exposing it in argv", {
  skip: live ? false : "set ENSEMBLE_KEYCHAIN_LIVE=1 on macOS",
}, async () => {
  const service = `ensemble-cli-test-${randomUUID()}`;
  const token = `ens_${randomUUID()}_${randomBytes(32).toString("base64url")}`;
  const argvSamples: string[] = [];
  // Samples every spawned `security` process's argv while it runs.
  const sampling: SecurityRunner = async (args, input) => {
    const pending = runSecurity(args, input);
    let pids = "";
    try {
      pids = execFileSync("/usr/bin/pgrep", ["-x", "security"], {
        encoding: "utf8",
      });
    } catch {
      // No running security process at this instant.
    }
    for (const pid of pids.split("\n"))
      if (pid)
        try {
          argvSamples.push(
            execFileSync("/bin/ps", ["-o", "args=", "-p", pid], {
              encoding: "utf8",
            }),
          );
        } catch {
          // The process already exited.
        }
    return pending;
  };
  const store = new KeychainCredentialStore(service, sampling);
  try {
    await store.set("probe", token);
    assert.equal(await store.get("probe"), token);
  } finally {
    await store.delete("probe");
  }
  await assert.rejects(store.get("probe"), { code: "credential-not-found" });
  assert.ok(argvSamples.length > 0, "sampled a running security process");
  for (const args of argvSamples) assert.ok(!args.includes(token));
  assert.throws(() =>
    execFileSync(
      "/usr/bin/security",
      ["find-generic-password", "-s", service],
      {
        stdio: "ignore",
      },
    ),
  );
});
