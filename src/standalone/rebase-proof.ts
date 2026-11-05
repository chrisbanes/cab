import { gitChildExited, type GitChildObserver } from "./git-process.js";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflate } from "node:zlib";
import { promisify } from "node:util";
const compress = promisify(deflate);
import { verifierGit, type Git } from "./push-verification.js";

const oid = /^[0-9a-f]{40}$/;
const budget = { objects: 20_000, bytes: 64 * 1024 * 1024, commits: 256 };
export interface RebaseProof {
  version: 1;
  oldBase: string;
  oldHead: string;
  newBase: string;
  newHead: string;
  pairs: {
    oldCommit: string;
    newCommit: string;
    patchId: string;
    messageSha256: string;
  }[];
}

/** No source refs, index, HEAD or files are changed. Only verified objects enter the scratch diff repository. */
export async function proveUnchangedRebase(
  source: Git,
  oldBase: string,
  oldHead: string,
  newBase: string,
  newHead: string,
  signal?: AbortSignal,
  fixture?: {
    scratchParent: string;
    executable: string;
    beforeEffect(teardown: boolean): Promise<void>;
    children?: GitChildObserver;
  },
): Promise<RebaseProof | null> {
  if (![oldBase, oldHead, newBase, newHead].every((id) => oid.test(id)))
    return null;
  if (fixture) await fixture.beforeEffect(false);
  const scratch = await mkdtemp(
    join(fixture?.scratchParent ?? tmpdir(), "cab-rebase-proof-"),
  );
  let unsettledChild = false;
  const children = fixture?.children
    ? {
        beforeChild: () => fixture.children!.beforeChild(),
        afterChild: async (
          sequence: number,
          result: Awaited<ReturnType<Git>>,
        ) => {
          if (!gitChildExited(result)) unsettledChild = true;
          await fixture.children!.afterChild(sequence, result);
        },
      }
    : undefined;
  const deadline = Date.now() + 30_000;
  const objects = new Map<string, { type: string; body: Buffer }>();
  let bytes = 0;
  const check = () => {
    if (signal?.aborted || Date.now() >= deadline)
      throw new Error("Proof interrupted");
  };
  try {
    if (fixture) await fixture.beforeEffect(false);
    await mkdir(join(scratch, "objects"));
    await mkdir(join(scratch, "refs"));
    await writeFile(join(scratch, "HEAD"), "ref: refs/heads/proof\n");
    await writeFile(
      join(scratch, "config"),
      "[core]\n\tbare = true\n\trepositoryformatversion = 0\n",
    );
    const read = async (id: string, type: string): Promise<Buffer> => {
      check();
      if (!oid.test(id)) throw new Error("Invalid object identity");
      const cached = objects.get(id);
      if (cached) {
        if (cached.type !== type) throw new Error("Object type mismatch");
        return cached.body;
      }
      if (objects.size >= budget.objects) throw new Error("Object count bound");
      const result = await source(["cat-file", "--batch"], {
        input: Buffer.from(`${id}\n`),
        maxOutputBytes: budget.bytes - bytes + 128,
      });
      if (result.status !== "ok") throw new Error("Object unavailable");
      const end = result.stdout.indexOf(10);
      const header = result.stdout.subarray(0, end).toString("ascii");
      const match = /^([0-9a-f]{40}) (commit|tree|blob) (0|[1-9][0-9]*)$/.exec(
        header,
      );
      if (!match || match[1] !== id || match[2] !== type)
        throw new Error("Object header mismatch");
      const size = Number(match[3]);
      if (
        size > budget.bytes - bytes ||
        result.stdout.length !== end + size + 2 ||
        result.stdout.at(-1) !== 10
      )
        throw new Error("Object size bound");
      const body = result.stdout.subarray(end + 1, end + 1 + size);
      const raw = Buffer.concat([Buffer.from(`${type} ${size}\0`), body]);
      if (createHash("sha1").update(raw).digest("hex") !== id)
        throw new Error("Forged object");
      bytes += size;
      objects.set(id, { type, body });
      const compressed = await compress(raw);
      if (fixture) await fixture.beforeEffect(false);
      await mkdir(join(scratch, "objects", id.slice(0, 2)), {
        recursive: true,
      });
      await writeFile(
        join(scratch, "objects", id.slice(0, 2), id.slice(2)),
        compressed,
      );
      return body;
    };
    const trees = new Set<string>();
    const tree = async (id: string, depth = 0): Promise<void> => {
      if (depth > 64) throw new Error("Tree depth bound");
      if (trees.has(id)) return;
      const body = await read(id, "tree");
      trees.add(id);
      let at = 0;
      while (at < body.length) {
        check();
        const space = body.indexOf(32, at),
          nul = body.indexOf(0, space + 1);
        if (space < at || nul <= space + 1 || nul + 21 > body.length)
          throw new Error("Invalid tree");
        const mode = body.toString("ascii", at, space);
        const name = body.subarray(space + 1, nul);
        if (
          name.includes(47) ||
          name.equals(Buffer.from(".")) ||
          name.equals(Buffer.from(".."))
        )
          throw new Error("Invalid tree name");
        const child = body.subarray(nul + 1, nul + 21).toString("hex");
        if (mode === "40000") await tree(child, depth + 1);
        else if (["100644", "100755", "120000"].includes(mode))
          await read(child, "blob");
        else throw new Error("Unsupported tree mode");
        at = nul + 21;
      }
    };
    const commit = async (id: string) => {
      const body = await read(id, "commit");
      const split = body.indexOf(Buffer.from("\n\n"));
      if (split < 0) throw new Error("Invalid commit");
      const header = body.subarray(0, split).toString("utf8").split("\n");
      const roots = header.filter((line) => line.startsWith("tree "));
      const parents = header
        .filter((line) => line.startsWith("parent "))
        .map((line) => line.slice(7));
      if (
        roots.length !== 1 ||
        !oid.test(roots[0]!.slice(5)) ||
        parents.some((id) => !oid.test(id))
      )
        throw new Error("Invalid commit links");
      const root = roots[0]!.slice(5);
      await tree(root);
      return { id, root, parents, message: body.subarray(split + 2) };
    };
    const range = async (base: string, head: string) => {
      const commits = [];
      let current = head;
      while (current !== base) {
        if (commits.length >= budget.commits) throw new Error("Commit bound");
        const c = await commit(current);
        if (c.parents.length !== 1) throw new Error("Nonlinear range");
        commits.push(c);
        current = c.parents[0]!;
      }
      const anchor = await commit(base);
      return { anchor, commits: commits.reverse() };
    };
    const old = await range(oldBase, oldHead),
      next = await range(newBase, newHead);
    if (!old.commits.length || old.commits.length !== next.commits.length)
      return null;
    const underlying = verifierGit(
      scratch,
      signal,
      fixture?.executable,
      children,
    );
    const git: Git = async (args, options) => {
      if (fixture) await fixture.beforeEffect(false);
      return underlying(args, options);
    };
    const patches = async (r: typeof old) => {
      let parent = r.anchor;
      const result = [];
      for (const c of r.commits) {
        check();
        const diff = await git(
          [
            "-c",
            "core.attributesFile=/dev/null",
            "diff-tree",
            "--no-commit-id",
            "--no-color",
            "-r",
            "-p",
            "--binary",
            "--text",
            "--full-index",
            "--no-renames",
            "--no-ext-diff",
            "--no-textconv",
            "--diff-algorithm=myers",
            "--no-indent-heuristic",
            "--src-prefix=a/",
            "--dst-prefix=b/",
            parent.root,
            c.root,
            "--",
          ],
          { maxOutputBytes: budget.bytes },
        );
        if (diff.status !== "ok" || !diff.stdout.length)
          throw new Error("Unproved or empty patch");
        const patch = await git(["patch-id", "--stable"], {
          input: diff.stdout,
        });
        if (patch.status !== "ok") throw new Error("Patch unavailable");
        const match =
          /^([0-9a-f]{40}) 0000000000000000000000000000000000000000\n$/.exec(
            patch.stdout.toString("ascii"),
          );
        if (!match) throw new Error("Ambiguous patch");
        result.push(match[1]!);
        parent = c;
      }
      return result;
    };
    const a = await patches(old),
      b = await patches(next);
    const pairs: RebaseProof["pairs"] = [];
    for (let i = 0; i < a.length; i++) {
      const left = old.commits[i]!,
        right = next.commits[i]!;
      if (a[i] !== b[i] || !left.message.equals(right.message)) return null;
      pairs.push({
        oldCommit: left.id,
        newCommit: right.id,
        patchId: a[i]!,
        messageSha256: createHash("sha256").update(left.message).digest("hex"),
      });
    }
    check();
    return { version: 1, oldBase, oldHead, newBase, newHead, pairs };
  } catch {
    return null;
  } finally {
    if (!unsettledChild) {
      if (fixture) await fixture.beforeEffect(true);
      await rm(scratch, { recursive: true, force: true });
    }
  }
}
