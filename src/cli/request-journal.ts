import { constants } from "node:fs";
import { chmod, mkdir, open, readFile } from "node:fs/promises";
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

  /** The most recent key recorded for this service and material digest. */
  async find(service: string, digest: string) {
    return (await this.lines()).findLast(
      (l) => l.service === service && l.digest === digest,
    )?.key;
  }

  /** The latest state and digest recorded for one full identity. */
  async state(identity: RequestIdentity) {
    const match = (await this.lines()).findLast(
      (l) =>
        l.service === identity.service &&
        l.scope === identity.scope &&
        l.type === identity.type &&
        l.key === identity.key,
    );
    return match && { state: match.state, digest: match.digest };
  }
}
