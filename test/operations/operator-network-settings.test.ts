import assert from "node:assert/strict";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test("network settings default off and persist an explicit address", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cab-network-"));
  await chmod(directory, 0o700);
  try {
    const modulePath = "../../src/operator/network-access.js";
    const { readNetworkSettings, writeNetworkSettings } = await import(
      modulePath
    );
    const dataDir = join(directory, "data");
    assert.deepEqual(await readNetworkSettings(dataDir, 8787), {
      schema: "cab.operator-network/v1",
      lan: null,
    });
    const settings = {
      schema: "cab.operator-network/v1",
      lan: { address: "192.0.2.10" },
    };
    await writeNetworkSettings(dataDir, 8787, settings);
    assert.deepEqual(await readNetworkSettings(dataDir, 8787), settings);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("network settings reject unsafe addresses and noncanonical origins", async () => {
  const { validateNetworkSettings } = await import(
    "../../src/operator/network-access.js"
  );
  for (const address of [
    "0.0.0.0",
    "127.0.0.2",
    "224.1.2.3",
    "255.255.255.255",
    "1.2.3.999",
  ]) {
    assert.throws(
      () =>
        validateNetworkSettings(
          { schema: "cab.operator-network/v1", lan: { address } },
          8787,
        ),
      address,
    );
  }
  for (const origin of [
    "http://[::1]:8787",
    "https://192.0.2.10:8787",
    "http://192.0.2.11:8787",
    "http://example.test:8788",
    "http://example.test:8787/path",
  ]) {
    assert.throws(
      () =>
        validateNetworkSettings(
          {
            schema: "cab.operator-network/v1",
            lan: { address: "192.0.2.10", origin },
          },
          8787,
        ),
      origin,
    );
  }
  assert.doesNotThrow(() =>
    validateNetworkSettings(
      {
        schema: "cab.operator-network/v1",
        lan: { address: "192.0.2.10", origin: "http://example.test:8787" },
      },
      8787,
    ),
  );
});

test("settings reject malformed, oversized and unsafe files and permit off recovery", async () => {
  const { chmod, link, symlink, unlink, writeFile } = await import(
    "node:fs/promises"
  );
  const { readNetworkSettings, writeNetworkSettings, networkSettingsPath } =
    await import("../../src/operator/network-access.js");
  const directory = await mkdtemp(join(tmpdir(), "cab-network-safety-"));
  await chmod(directory, 0o700);
  const data = join(directory, "data");
  const path = networkSettingsPath(data);
  const off = { schema: "cab.operator-network/v1", lan: null };
  try {
    await writeFile(path, "{bad", { mode: 0o600 });
    await assert.rejects(readNetworkSettings(data, 8787));
    await writeNetworkSettings(data, 8787, off);
    assert.deepEqual(await readNetworkSettings(data, 8787), off);
    await writeFile(path, "x".repeat(4097));
    await assert.rejects(readNetworkSettings(data, 8787));
    await unlink(path);
    await writeFile(path, JSON.stringify(off), { mode: 0o644 });
    await assert.rejects(readNetworkSettings(data, 8787));
    await assert.rejects(writeNetworkSettings(data, 8787, off));
    await chmod(path, 0o600);
    const linked = join(directory, "linked");
    await link(path, linked);
    await assert.rejects(readNetworkSettings(data, 8787));
    await assert.rejects(writeNetworkSettings(data, 8787, off));
    await unlink(linked);
    await unlink(path);
    await symlink(join(directory, "absent"), path);
    await assert.rejects(readNetworkSettings(data, 8787));
    await assert.rejects(writeNetworkSettings(data, 8787, off));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("write failures preserve the prior file before rename and report uncertainty after it", async (t) => {
  const { open } = await import("node:fs/promises");
  const { readNetworkSettings, writeNetworkSettings } = await import(
    "../../src/operator/network-access.js"
  );
  const directory = await mkdtemp(join(tmpdir(), "cab-network-sync-"));
  await chmod(directory, 0o700);
  const data = join(directory, "data");
  const off = { schema: "cab.operator-network/v1", lan: null };
  const enabled = {
    schema: "cab.operator-network/v1",
    lan: { address: "192.0.2.10" },
  };
  try {
    await writeNetworkSettings(data, 8787, off);
    const handle = await open(join(directory, "probe"), "w", 0o600);
    const prototype = Object.getPrototypeOf(handle) as {
      sync(): Promise<void>;
    };
    const sync = prototype.sync;
    await handle.close();
    let calls = 0;
    const mocked = t.mock.method(
      prototype,
      "sync",
      async function (this: { sync(): Promise<void> }) {
        calls++;
        if (calls === 1) throw new Error("fixture file sync failure");
        await sync.call(this);
      },
    );
    await assert.rejects(
      writeNetworkSettings(data, 8787, enabled),
      /fixture file sync failure/,
    );
    mocked.mock.restore();
    assert.deepEqual(await readNetworkSettings(data, 8787), off);
    calls = 0;
    const later = t.mock.method(
      prototype,
      "sync",
      async function (this: { sync(): Promise<void> }) {
        calls++;
        if (calls === 2) throw new Error("fixture directory sync failure");
        await sync.call(this);
      },
    );
    await assert.rejects(
      writeNetworkSettings(data, 8787, enabled),
      /persistence is uncertain/,
    );
    later.mock.restore();
    assert.deepEqual(await readNetworkSettings(data, 8787), enabled);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("settings refuse unknown fields and substituted parent paths", async () => {
  const { mkdir, symlink, writeFile } = await import("node:fs/promises");
  const { readNetworkSettings, writeNetworkSettings } = await import(
    "../../src/operator/network-access.js"
  );
  const root = await mkdtemp(join(tmpdir(), "cab-network-parent-"));
  await chmod(root, 0o700);
  const real = join(root, "real");
  const alias = join(root, "alias");
  const data = join(real, "data");
  const off = { schema: "cab.operator-network/v1", lan: null };
  try {
    await mkdir(real, { mode: 0o700 });
    await writeFile(
      `${data}.operator-network.json`,
      JSON.stringify({ ...off, extra: true }),
      { mode: 0o600 },
    );
    await assert.rejects(readNetworkSettings(data, 8787));
    await symlink(real, alias);
    await assert.rejects(readNetworkSettings(join(alias, "data"), 8787));
    await assert.rejects(writeNetworkSettings(join(alias, "data"), 8787, off));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("LAN settings reject port 80 while disabled settings retain existing behavior", async () => {
  const { validateNetworkSettings } = await import(
    "../../src/operator/network-access.js"
  );
  assert.throws(
    () =>
      validateNetworkSettings(
        { schema: "cab.operator-network/v1", lan: { address: "192.0.2.10" } },
        80,
      ),
    /LAN access does not support port 80/,
  );
  assert.doesNotThrow(() =>
    validateNetworkSettings(
      { schema: "cab.operator-network/v1", lan: null },
      80,
    ),
  );
});

test("a canonical absolute DNS hostname is accepted", async () => {
  const { validateNetworkSettings } = await import(
    "../../src/operator/network-access.js"
  );
  assert.doesNotThrow(() =>
    validateNetworkSettings(
      {
        schema: "cab.operator-network/v1",
        lan: { address: "192.0.2.10", origin: "http://example.test.:8787" },
      },
      8787,
    ),
  );
});

test("readback failure after rename reports uncertain persistence", async (t) => {
  const { open } = await import("node:fs/promises");
  const { readNetworkSettings, writeNetworkSettings } = await import(
    "../../src/operator/network-access.js"
  );
  const directory = await mkdtemp(join(tmpdir(), "cab-network-readback-"));
  await chmod(directory, 0o700);
  const data = join(directory, "data");
  const off = { schema: "cab.operator-network/v1", lan: null };
  const enabled = {
    schema: "cab.operator-network/v1",
    lan: { address: "192.0.2.10" },
  };
  try {
    await writeNetworkSettings(data, 8787, off);
    const handle = await open(join(directory, "probe"), "w", 0o600);
    const prototype = Object.getPrototypeOf(handle) as typeof handle;
    const sync = prototype.sync;
    const read = prototype.read;
    await handle.close();
    let syncs = 0;
    const syncMock = t.mock.method(
      prototype,
      "sync",
      async function (this: typeof handle) {
        await sync.call(this);
        syncs++;
      },
    );
    const readMock = t.mock.method(
      prototype,
      "read",
      async function (this: typeof handle, ...args: Parameters<typeof read>) {
        if (syncs >= 2) throw new Error("fixture readback failure");
        return read.apply(this, args);
      },
    );
    await assert.rejects(
      writeNetworkSettings(data, 8787, enabled),
      /persistence is uncertain/,
    );
    syncMock.mock.restore();
    readMock.mock.restore();
    assert.deepEqual(await readNetworkSettings(data, 8787), enabled);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("settings refuse a file whose opened descriptor belongs to another owner", async (t) => {
  const { open } = await import("node:fs/promises");
  const { readNetworkSettings, writeNetworkSettings } = await import(
    "../../src/operator/network-access.js"
  );
  const directory = await mkdtemp(join(tmpdir(), "cab-network-owner-"));
  await chmod(directory, 0o700);
  const data = join(directory, "data");
  try {
    await writeNetworkSettings(data, 8787, {
      schema: "cab.operator-network/v1",
      lan: null,
    });
    const handle = await open(join(directory, "probe"), "w", 0o600);
    const prototype = Object.getPrototypeOf(handle) as typeof handle;
    const stat = prototype.stat;
    await handle.close();
    const mock = t.mock.method(
      prototype,
      "stat",
      async function (this: typeof handle, ...args: Parameters<typeof stat>) {
        const result = await stat.apply(this, args);
        Object.defineProperty(result, "uid", {
          value: (process.getuid?.() ?? 0) + 1,
        });
        return result;
      },
    );
    await assert.rejects(
      readNetworkSettings(data, 8787),
      /Unsafe operator network settings/,
    );
    mock.mock.restore();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
