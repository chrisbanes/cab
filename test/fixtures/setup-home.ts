import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { DiscoveryReader } from "../../src/standalone/github-discovery.js";

const run = promisify(execFile);
export const git = (dir: string, ...args: string[]) =>
  run("git", ["-C", dir, ...args], { encoding: "utf8" });

/** A Git checkout on `main` with one commit and, when given, an origin remote. */
export async function checkout(dir: string, origin?: string) {
  await mkdir(dir, { recursive: true });
  await run("git", ["init", "-q", "-b", "main", dir]);
  await writeFile(join(dir, "README.md"), "fixture\n");
  await git(dir, "add", "README.md");
  await git(
    dir,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-qm",
    "init",
  );
  if (origin) await git(dir, "remote", "add", "origin", origin);
}

/**
 * A temporary home folder under the OS temp root (deliberately not real-pathed: on macOS
 * `/var` is a symlink, so containment must compare real paths on both sides).
 */
export async function createSetupHome() {
  const home = await mkdtemp(join(tmpdir(), "cab-setup-home-"));
  const outside = await mkdtemp(join(tmpdir(), "cab-setup-outside-"));
  const src = join(home, "src");
  await checkout(join(src, "atlas"), "https://github.com/acme/atlas.git");
  await checkout(join(src, "relay"), "git@github.com:acme/relay.git");
  await checkout(
    join(src, "leaky"),
    "https://user:SECRETPASS@github.com/acme/leaky.git",
  );
  await checkout(join(src, "gitlab"), "https://gitlab.com/acme/atlas.git");
  await mkdir(join(src, "design-notes"), { recursive: true });
  await mkdir(join(src, "archive", "old"), { recursive: true });
  await writeFile(join(src, "notes.txt"), "PRIVATE FILE CONTENT\n");
  await mkdir(join(home, ".ssh"), { recursive: true });
  await writeFile(join(home, ".ssh", "id"), "PRIVATE FILE CONTENT\n");
  await symlink(outside, join(src, "escape"));
  for (let i = 0; i < 205; i++)
    await mkdir(join(home, "big", `f${String(i).padStart(3, "0")}`), {
      recursive: true,
    });
  return {
    home,
    outside,
    async close() {
      await rm(home, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    },
  };
}

/** Fake discovery: acme/atlas, acme/relay, acme/docs; one Project linked to atlas. */
export function fakeDiscovery(
  state: { failure?: Error; calls?: string[]; truncated?: boolean } = {},
): (credentialRef: string) => DiscoveryReader {
  const fail = (call: string) => {
    state.calls?.push(call);
    if (state.failure) throw state.failure;
  };
  return () => ({
    async repositories() {
      fail("repositories");
      return {
        repositories: [
          ["R_atlas", "atlas"],
          ["R_relay", "relay"],
          ["R_docs", "docs"],
        ].map(([repositoryId, name]) => ({
          repositoryId: String(repositoryId),
          owner: "acme",
          name: String(name),
          defaultBranch: "main",
        })),
        truncated: Boolean(state.truncated),
      };
    },
    async branches() {
      fail("branches");
      return {
        branches: ["develop", "main"],
        truncated: Boolean(state.truncated),
      };
    },
    async labels(_owner, name) {
      fail("labels");
      return {
        labels:
          name === "atlas"
            ? ["bug", "ready", "needs-review"]
            : name === "relay"
              ? ["ready", "triage"]
              : [],
        truncated: Boolean(state.truncated),
      };
    },
    async projectFields(project) {
      fail("projectFields");
      const option = (name: string, id: string) => ({
        optionNodeId: `PVTSSO_${id}`,
        name,
      });
      return {
        fields:
          project === "PVT_atlas"
            ? [
                {
                  fieldNodeId: "PVTSSF_status",
                  name: "Status",
                  options: [option("Todo", "todo"), option("Ready", "ready")],
                },
                {
                  fieldNodeId: "PVTSSF_priority",
                  name: "Priority",
                  options: [option("High", "high"), option("Low", "low")],
                },
              ]
            : [],
        truncated: Boolean(state.truncated),
      };
    },
    async projects(_owner, name) {
      fail("projects");
      return {
        ownerLogin: "acme",
        linked:
          name === "atlas"
            ? [
                {
                  projectNodeId: "PVT_atlas",
                  title: "Atlas roadmap",
                  number: 1,
                },
              ]
            : [],
        // As on GitHub, the owner's Projects exclude only those linked to this repository.
        owned: [
          ...(name === "atlas"
            ? []
            : [
                {
                  projectNodeId: "PVT_atlas",
                  title: "Atlas roadmap",
                  number: 1,
                },
              ]),
          { projectNodeId: "PVT_web", title: "Web", number: 2 },
          { projectNodeId: "PVT_ops", title: "Ops", number: 3 },
          { projectNodeId: "PVT_docs", title: "Docs", number: 4 },
        ],
        truncated: Boolean(state.truncated),
      };
    },
  });
}
