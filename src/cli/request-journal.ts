import { constants } from "node:fs";
import { chmod, mkdir, open, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { CliError } from "./connections.js";
import type { RequestIdentity } from "./types.js";

const states = ["sending", "recorded", "rejected", "unknown"] as const;
export type JournalState = (typeof states)[number];
const lineSchema = z
  .object({
    at: z.number(),
    state: z.enum(states),
    service: z.string(),
    scope: z.string(),
    type: z.string(),
    key: z.string(),
    digest: z.string(),
  })
  .strict();
type Line = z.infer<typeof lineSchema>;
const reachedStates = new Set<JournalState>(["unknown", "recorded"]);

const unavailable = () =>
  new CliError(
    "journal-unavailable",
    "The local request journal cannot be written; nothing was sent.",
  );

/**
 * Append-only `requests.jsonl`: request identities and material digests, never request
 * bodies, instruction text or tokens. Each line is one O_APPEND write, so concurrent
 * CLI processes cannot interleave partial lines.
 */
export class RequestJournal {
  constructor(
    readonly directory: string,
    private readonly now: () => number = Date.now,
  ) {}

  private get file() {
    return join(this.directory, "requests.jsonl");
  }

  async append(
    identity: RequestIdentity,
    digest: string,
    state: JournalState,
  ): Promise<void> {
    const line: Line = { at: this.now(), state, ...identity, digest };
    try {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      await chmod(this.directory, 0o700);
      const created = !(await stat(this.file).catch(() => undefined));
      const handle = await open(
        this.file,
        constants.O_WRONLY |
          constants.O_APPEND |
          constants.O_CREAT |
          constants.O_NOFOLLOW,
        0o600,
      );
      try {
        await handle.chmod(0o600);
        await handle.write(`${JSON.stringify(lineSchema.parse(line))}\n`);
        await handle.sync();
      } finally {
        await handle.close();
      }
      if (created) {
        // Make the new directory entry durable as well as its first line.
        const directory = await open(this.directory, constants.O_RDONLY);
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
      }
    } catch {
      throw unavailable();
    }
  }

  private async lines(): Promise<Line[]> {
    let text: string;
    try {
      text = await readFile(this.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw unavailable();
    }
    return text.split("\n").flatMap((raw) => {
      if (!raw) return [];
      try {
        const parsed = lineSchema.safeParse(JSON.parse(raw));
        return parsed.success ? [parsed.data] : [];
      } catch {
        return [];
      }
    });
  }

  /**
   * The most recent reusable key for this service and digest. A key is skipped only when
   * its latest state is rejected and no attempt with it may have reached the service.
   * With `unresolved`, a key that was ever recorded is skipped too, so a repeatable
   * intent (Stop, a message) reuses only a key whose outcome is still unknown.
   */
  async find(
    service: string,
    digest: string,
    options: { unresolved?: boolean } = {},
  ) {
    const lines = await this.lines();
    const latest = new Map(lines.map((l) => [l.key, l.state]));
    const reached = new Set(
      lines.filter((l) => reachedStates.has(l.state)).map((l) => l.key),
    );
    const recorded = new Set(
      lines.filter((l) => l.state === "recorded").map((l) => l.key),
    );
    return lines.findLast(
      (l) =>
        l.service === service &&
        l.digest === digest &&
        (latest.get(l.key) !== "rejected" || reached.has(l.key)) &&
        !(options.unresolved && recorded.has(l.key)),
    )?.key;
  }

  /**
   * The latest state and digest for one full identity, and whether any attempt with it
   * may have reached the service (in flight, unknown or recorded at any point).
   */
  async state(identity: RequestIdentity) {
    const lines = (await this.lines()).filter(
      (l) =>
        l.service === identity.service &&
        l.scope === identity.scope &&
        l.type === identity.type &&
        l.key === identity.key,
    );
    const match = lines.at(-1);
    return (
      match && {
        state: match.state,
        digest: match.digest,
        reached:
          match.state === "sending" ||
          lines.some((l) => reachedStates.has(l.state)),
      }
    );
  }
}
