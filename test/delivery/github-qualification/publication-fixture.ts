import { createHash } from "node:crypto";
import { z } from "zod";
import { deliveryDocuments } from "../../../src/standalone/github-delivery.js";

const id = z.string().min(1).max(512);
const fixtureRepository = "chrisbanes/ensemble-s07a-fixture";
const publicationActions = [
  "branch.push",
  "branch.force-push",
  "branch.adopt",
  "pr.create",
] as const;
const exactActions = (actions: readonly string[]) =>
  actions.length === publicationActions.length &&
  publicationActions.every((a) => actions.includes(a));

/** What the maintainer's manifest names for the bounded publication run. */
export const publicationManifestSchema = z
  .object({
    version: z.literal(1),
    provider: z.literal("github.com"),
    account: z.object({ nodeId: id, login: z.literal("chrisbanes") }).strict(),
    repository: z
      .object({
        nodeId: id,
        fullName: z.literal(fixtureRepository),
        private: z.boolean(),
        defaultBranch: z.literal("qualification"),
      })
      .strict(),
    /** The product's `ghToken()` (the maintainer's `gh` login), read in-process and never stored. */
    credential: z.literal("gh-cli"),
    actions: z.array(z.enum(publicationActions)).refine(exactActions),
    /** The run drives the real delivery coordinator directly, so it grants no model turns. */
    runtimeTurnLimit: z.literal(0),
    branchPrefix: z.literal("s07a-pub/"),
  })
  .strict();
const publicationGrantSchema = z
  .object({
    version: z.literal(1),
    manifestSha256: z.string().regex(/^[0-9a-f]{64}$/),
    accountNodeId: id,
    repositoryNodeId: id,
    repositoryVisibility: z.enum(["private", "public"]),
    credential: z.literal("gh-cli"),
    actions: z.array(z.enum(publicationActions)).refine(exactActions),
    runtimeTurnLimit: z.literal(0),
    expiresAt: z.iso.datetime(),
    cleanup: z
      .object({
        closeRecordedPrs: z.literal(true),
        deleteRecordedHeads: z.literal(true),
      })
      .strict(),
  })
  .strict();
export type PublicationManifest = z.output<typeof publicationManifestSchema>;

const queryDocuments = new Set<string>(
  Object.values(deliveryDocuments).filter((d) => d.startsWith("query")),
);

/**
 * Enforces a separately supplied exact grant: only api.github.com, only the fixture repository, one
 * draft PR from a recorded `s07a-pub/` branch, two outside commits on that branch, and cleanup of exactly
 * what the run recorded.
 */
export class PublicationGuard {
  readonly manifest: PublicationManifest;
  private readonly grant: z.output<typeof publicationGrantSchema>;
  private readonly root: string;
  private readonly ids = new Set<string>();
  private branch: string | undefined;
  private pr: number | undefined;
  private created = false;
  /** Outside commits the harness made on the scratch branch, and the fast-forward moves that published them. */
  private outsideCommits = 0;
  private outsideMoves = 0;
  readonly writes: string[] = [];
  constructor(manifestText: string, grant: unknown, now = Date.now()) {
    if (grant === undefined) throw new Error("Named live grant is required");
    this.manifest = publicationManifestSchema.parse(JSON.parse(manifestText));
    this.grant = publicationGrantSchema.parse(grant);
    const m = this.manifest,
      g = this.grant;
    if (
      g.manifestSha256 !==
        createHash("sha256").update(manifestText).digest("hex") ||
      g.repositoryNodeId !== m.repository.nodeId ||
      g.accountNodeId !== m.account.nodeId ||
      g.repositoryVisibility !==
        (m.repository.private ? "private" : "public") ||
      Date.parse(g.expiresAt) <= now
    )
      throw new Error(
        "Live grant does not match current manifest or has expired",
      );
    this.root = `/repos/${m.repository.fullName}`;
    this.ids.add(m.repository.nodeId);
  }
  private current() {
    if (Date.now() >= Date.parse(this.grant.expiresAt))
      throw new Error("Live grant expired");
  }
  assertRepositoryVisibility(observedPrivate: boolean) {
    this.current();
    if (observedPrivate !== this.manifest.repository.private)
      throw new Error("Observed fixture visibility does not match the grant");
  }
  /** The scratch branch the run assigned; the only head a PR or cleanup may name. */
  recordBranch(branch: string) {
    if (!branch.startsWith(this.manifest.branchPrefix))
      throw new Error("Branch is outside the granted prefix");
    this.branch = branch;
  }
  recordPr(number: number, nodeId: string) {
    this.pr = number;
    this.ids.add(nodeId);
  }
  assertPush(request: { nameWithOwner: string; branch: string }) {
    this.current();
    if (
      request.nameWithOwner !== this.manifest.repository.fullName ||
      !request.branch.startsWith(this.manifest.branchPrefix) ||
      (this.branch !== undefined && request.branch !== this.branch)
    )
      throw new Error("guard: unexpected push target");
  }
  /** The adopt fetch is held to the same repository and recorded branch as the push. */
  assertAdopt(request: { nameWithOwner: string; branch: string }) {
    this.assertPush(request);
    if (this.branch === undefined)
      throw new Error("guard: unexpected adopt target");
  }
  assertRequest(input: string | URL | Request, init: RequestInit = {}) {
    this.current();
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== "https://api.github.com" || url.hash)
      throw new Error("guard: unexpected origin");
    const method = (
      init.method ?? (input instanceof Request ? input.method : "GET")
    ).toUpperCase();
    const body = typeof init.body === "string" ? init.body : undefined;
    if (url.pathname === "/graphql") {
      if (method !== "POST" || body === undefined)
        throw new Error("guard: GraphQL method");
      const { query, variables = {} } = JSON.parse(body) as {
        query: string;
        variables?: Record<string, unknown>;
      };
      if (!queryDocuments.has(query))
        throw new Error("guard: only delivery queries are granted");
      for (const [key, value] of Object.entries(variables))
        if (
          key !== "after" &&
          typeof value === "string" &&
          !this.ids.has(value)
        )
          throw new Error(`guard: unexpected id ${key}`);
      return;
    }
    if (method === "GET") {
      if (
        url.pathname !== "/user" &&
        !url.pathname.startsWith(`${this.root}/`) &&
        url.pathname !== this.root
      )
        throw new Error("guard: unexpected GET path");
      return;
    }
    const branch = this.branch;
    if (method === "POST" && url.pathname === `${this.root}/pulls`) {
      const pr = JSON.parse(body ?? "{}") as Record<string, unknown>;
      if (
        this.created ||
        !branch ||
        pr.head !== branch ||
        pr.base !== this.manifest.repository.defaultBranch ||
        pr.draft !== true
      )
        throw new Error("guard: unexpected PR creation");
      this.created = true;
    } else if (
      method === "PATCH" &&
      this.pr !== undefined &&
      url.pathname === `${this.root}/pulls/${this.pr}` &&
      body === JSON.stringify({ state: "closed" })
    ) {
      // Cleanup: close exactly the recorded PR.
    } else if (
      // The harness plays the outside writer: a commit whose only parent is the current head and whose
      // tree is that head's, then a fast-forward (never forced) move of the scratch branch onto it.
      method === "POST" &&
      branch &&
      url.pathname === `${this.root}/git/commits` &&
      this.outsideCommits < 2 &&
      (JSON.parse(body ?? "{}") as { parents?: unknown[] }).parents?.length ===
        1
    ) {
      this.outsideCommits++;
    } else if (
      method === "PATCH" &&
      branch &&
      url.pathname === `${this.root}/git/refs/heads/${branch}` &&
      this.outsideMoves < 2 &&
      (JSON.parse(body ?? "{}") as { force?: unknown }).force === false
    ) {
      this.outsideMoves++;
    } else if (
      method === "DELETE" &&
      branch &&
      url.pathname === `${this.root}/git/refs/heads/${branch}`
    ) {
      // Cleanup: delete exactly the recorded head (cab never deletes branches).
    } else throw new Error(`guard: unexpected write ${method} ${url.pathname}`);
    this.writes.push(`${method} ${url.pathname}`);
  }
}
