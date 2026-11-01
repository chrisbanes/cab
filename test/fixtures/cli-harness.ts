import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { CredentialStore } from "../../src/cli/connections.js";
import { type CliDeps, main } from "../../src/cli/main.js";

export type After = { after(fn: () => unknown): void };

export class MemoryKeychain implements CredentialStore {
  items = new Map<string, string>();
  async set(account: string, token: string) {
    this.items.set(account, token);
  }
  async get(account: string) {
    const token = this.items.get(account);
    if (!token)
      throw Object.assign(new Error("missing"), {
        code: "credential-not-found",
      });
    return token;
  }
  async delete(account: string) {
    this.items.delete(account);
  }
}

/** A standard input that holds `text` and then ends. */
export const stdinOf = (text: string) => {
  const stream = new PassThrough();
  stream.end(text);
  return stream as unknown as NodeJS.ReadStream;
};

export function harness(t: After, overrides: Partial<CliDeps> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "cab-cli-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const configDir = join(dir, "config");
  const keychain = new MemoryKeychain();
  const outputs: string[] = [];
  const fetches: string[] = [];
  const run = async (args: string[], extra: Partial<CliDeps> = {}) => {
    const stdout = new PassThrough(),
      stderr = new PassThrough();
    let out = "",
      err = "";
    stdout.on("data", (c) => {
      out += c;
    });
    for (const stream of [stderr, extra.stderr])
      (stream as PassThrough | undefined)?.on("data", (c) => {
        err += c;
      });
    const code = await main(args, {
      // Automatic discovery must never reach the host installation from a fixture.
      env: {
        CAB_CLI_CONFIG_DIR: configDir,
        CAB_LOCAL_STATE: join(dir, "local-state"),
      },
      stdin: new PassThrough() as unknown as NodeJS.ReadStream,
      stdout,
      stderr: stderr as unknown as NodeJS.WriteStream,
      fetch: (input, init) => {
        fetches.push(String(input));
        return fetch(input, init);
      },
      platform: "darwin",
      keychain: () => keychain,
      now: Date.now,
      ...overrides,
      ...extra,
    });
    outputs.push(out, err);
    return { code, out, err, json: () => JSON.parse(out) };
  };
  const tokenFile = (token: string, name = `${randomUUID()}.token`) => {
    const path = join(dir, name);
    writeFileSync(path, `${token}\n`, { mode: 0o600 });
    return path;
  };
  return { dir, configDir, keychain, run, outputs, fetches, tokenFile };
}

export async function fakeServer(
  t: After,
  handler: Parameters<typeof createServer>[1],
): Promise<{ origin: string; hits: string[] }> {
  const hits: string[] = [];
  const server: Server = createServer((request, response) => {
    hits.push(
      `${request.method} ${request.url} ${request.headers.authorization ?? ""}`,
    );
    handler?.(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  if (!address || typeof address === "string") throw Error("address");
  return { origin: `http://127.0.0.1:${address.port}`, hits };
}
