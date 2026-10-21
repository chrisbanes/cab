import { createHash } from "node:crypto";
import { z } from "zod";

const id = z.string().min(1).max(512);
const fixtureRepository = "chrisbanes/ensemble-s07a-fixture";
const owner = "chrisbanes";
/** The maintainer's own Project 6 and every Project linked to this repository are never touched. */
const forbiddenProjectNumber = 6;
const forbiddenRepository = "chrisbanes/ensemble";

/** What the maintainer's manifest names for the bounded status-mapping run. */
export const statusMappingManifestSchema = z
  .object({
    version: z.literal(1),
    provider: z.literal("github.com"),
    account: z.object({ nodeId: id, login: z.literal(owner) }).strict(),
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
    actions: z.array(z.literal("project.field")).length(1),
    /** The run drives the real writer and coordinator directly, so it grants no model turns. */
    runtimeTurnLimit: z.literal(0),
    /** Each attempt creates and deletes its own scratch Project. */
    maxAttempts: z.literal(2),
  })
  .strict();
const statusMappingGrantSchema = z
  .object({
    version: z.literal(1),
    manifestSha256: z.string().regex(/^[0-9a-f]{64}$/),
    accountNodeId: id,
    repositoryNodeId: id,
    repositoryVisibility: z.enum(["private", "public"]),
    credential: z.literal("gh-cli"),
    actions: z.array(z.literal("project.field")).length(1),
    runtimeTurnLimit: z.literal(0),
    expiresAt: z.iso.datetime(),
    cleanup: z
      .object({
        deleteScratchProjects: z.literal(true),
        closeFixtureIssues: z.literal(true),
      })
      .strict(),
  })
  .strict();
export type StatusMappingManifest = z.output<
  typeof statusMappingManifestSchema
>;

/** The Status options a scratch Project is given, in order. */
export const statusOptionNames = [
  "Todo",
  "In Progress",
  "In review",
  "Done",
] as const;

/** The filters a scratch Project source may use: none, or issues only. */
export const projectFilters = ["", "is:issue"] as const;
export const projectTitle = (runId: string) => `ensemble-1194-${runId}`;
export const issueTitle = (runId: string) =>
  `Status mapping qualification ${runId}`;

/** The graph documents the harness itself sends through `gh api graphql`; nothing else is granted. */
export const harnessDocuments = {
  setStatusOptions: `mutation($field:ID!){updateProjectV2Field(input:{fieldId:$field,singleSelectOptions:[${statusOptionNames
    .map((name) => `{name:"${name}",color:GRAY,description:""}`)
    .join(
      ",",
    )}]}){projectV2Field{... on ProjectV2SingleSelectField{id options{id name}}}}}`,
  projectLinks: `query($project:ID!){node(id:$project){... on ProjectV2{number repositories(first:50){nodes{nameWithOwner}}}}}`,
  projectExists: `query($project:ID!){node(id:$project){id}}`,
} as const;

/** The operation prefixes of the product's own documents a run may send. */
const productOperations = [
  "query EnsembleDeliveryRepository",
  "query EnsembleDeliveryField",
  "mutation EnsembleDeliveryProject",
  "query EnsembleProjectPage",
  "query EnsembleProjectFieldValues",
  "query EnsembleProjectFields",
] as const;

/**
 * Enforces a separately supplied exact grant: only api.github.com, only the fixture repository and the
 * one scratch user-owned Project this run created, and cleanup of exactly what the run recorded. The
 * credential belongs to the guarded product client; `gh` runs under its own login, through `assertGh`.
 */
export class StatusMappingGuard {
  readonly manifest: StatusMappingManifest;
  private readonly grant: z.output<typeof statusMappingGrantSchema>;
  private readonly root: string;
  private readonly ids = new Set<string>();
  private readonly options = new Set<string>();
  private runId: string | undefined;
  private project: { nodeId: string; number: number } | undefined;
  private issue: number | undefined;
  private field: string | undefined;
  private item: string | undefined;
  readonly writes: string[] = [];
  readonly ghCommands: string[] = [];
  constructor(manifestText: string, grant: unknown, now = Date.now()) {
    if (grant === undefined) throw new Error("Named live grant is required");
    this.manifest = statusMappingManifestSchema.parse(JSON.parse(manifestText));
    this.grant = statusMappingGrantSchema.parse(grant);
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
  /** The attempt this run is, within the manifest's allowance. */
  begin(runId: string, attempt: number) {
    this.current();
    if (
      !Number.isInteger(attempt) ||
      attempt < 1 ||
      attempt > this.manifest.maxAttempts
    )
      throw new Error("guard: attempt is outside the granted allowance");
    if (!/^[0-9a-f]{8}$/.test(runId)) throw new Error("guard: bad run id");
    this.runId = runId;
  }
  /** The Project this run created; Project 6 and any Project linked to the repository are refused. */
  recordProject(project: {
    nodeId: string;
    number: number;
    linkedRepositories: readonly string[];
  }) {
    if (project.number === forbiddenProjectNumber)
      throw new Error("guard: Project 6 is never used");
    if (
      project.linkedRepositories.some(
        (name) =>
          name.toLowerCase() === forbiddenRepository ||
          name.toLowerCase() !== fixtureRepository,
      )
    )
      throw new Error("guard: Project is linked to an ungranted repository");
    if (this.project && this.project.nodeId !== project.nodeId)
      throw new Error("guard: a run creates one Project");
    this.project = { nodeId: project.nodeId, number: project.number };
    this.ids.add(project.nodeId);
  }
  recordIssue(number: number, nodeId?: string) {
    this.issue = number;
    if (nodeId) this.ids.add(nodeId);
  }
  recordItem(nodeId: string) {
    this.item = nodeId;
    this.ids.add(nodeId);
  }
  recordField(fieldId: string, optionIds: readonly string[]) {
    this.field = fieldId;
    this.ids.add(fieldId);
    for (const option of optionIds) {
      this.options.add(option);
      this.ids.add(option);
    }
  }
  /** The product's HTTP requests: delivery and source-read documents on the recorded resources only. */
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
      if (!productOperations.some((prefix) => query.startsWith(prefix)))
        throw new Error("guard: only the granted documents may be sent");
      for (const [key, value] of Object.entries(variables))
        if (
          typeof value === "string" &&
          key !== "after" &&
          // The Project filter: the scratch Project holds one issue.
          !(
            key === "query" &&
            (projectFilters as readonly string[]).includes(value)
          ) &&
          !this.ids.has(value)
        )
          throw new Error(`guard: unexpected id ${key}`);
      if (query.startsWith("mutation EnsembleDeliveryProject")) {
        if (
          !this.project ||
          variables.project !== this.project.nodeId ||
          variables.item !== this.item ||
          variables.field !== this.field ||
          typeof variables.option !== "string" ||
          !this.options.has(variables.option)
        )
          throw new Error("guard: unexpected Project write");
        this.writes.push("POST /graphql updateProjectV2ItemFieldValue");
      }
      return;
    }
    if (
      method !== "GET" ||
      (url.pathname !== "/user" &&
        url.pathname !== this.root &&
        !url.pathname.startsWith(`${this.root}/issues/`))
    )
      throw new Error(`guard: unexpected ${method} ${url.pathname}`);
  }
  /** `gh` runs under its own login; only these exact command shapes are allowed. */
  assertGh(args: readonly string[]) {
    this.current();
    const run = this.runId,
      project = this.project,
      full = this.manifest.repository.fullName;
    if (!run) throw new Error("guard: no attempt has begun");
    const is = (...expected: string[]) =>
      args.length === expected.length &&
      expected.every((e, i) => e === args[i]);
    const number = String(project?.number);
    const projectCommand =
      project !== undefined &&
      (is("project", "link", number, "--owner", owner, "--repo", full) ||
        is(
          "project",
          "field-list",
          number,
          "--owner",
          owner,
          "--format",
          "json",
        ) ||
        is(
          "project",
          "item-list",
          number,
          "--owner",
          owner,
          "--format",
          "json",
        ) ||
        is("project", "delete", number, "--owner", owner) ||
        (this.issue !== undefined &&
          is(
            "project",
            "item-add",
            number,
            "--owner",
            owner,
            "--url",
            `https://github.com/${full}/issues/${this.issue}`,
            "--format",
            "json",
          )) ||
        (this.item !== undefined &&
          this.field !== undefined &&
          this.options.has(args[9] ?? "") &&
          is(
            "project",
            "item-edit",
            "--id",
            this.item,
            "--project-id",
            project.nodeId,
            "--field-id",
            this.field,
            "--single-select-option-id",
            args[9] ?? "",
          )));
    const create = is(
      "project",
      "create",
      "--owner",
      owner,
      "--title",
      projectTitle(run),
      "--format",
      "json",
    );
    const issueCreate =
      args.length === 8 &&
      is(
        "issue",
        "create",
        "--repo",
        full,
        "--title",
        issueTitle(run),
        "--body",
        args[7] ?? "",
      );
    const issueClose =
      this.issue !== undefined &&
      is("issue", "close", String(this.issue), "--repo", full);
    const issueRead =
      this.issue !== undefined &&
      is("api", `repos/${full}/issues/${this.issue}`, "--jq", ".state");
    const graph =
      project !== undefined && args[0] === "api" && args[1] === "graphql"
        ? this.graphCall(args)
        : false;
    if (
      !(
        is("api", "-i", "/user") ||
        create ||
        projectCommand ||
        issueCreate ||
        issueClose ||
        issueRead ||
        graph
      )
    )
      throw new Error(`guard: gh ${args.slice(0, 2).join(" ")} is not granted`);
    const label = args.slice(0, 2).join(" ");
    this.ghCommands.push(label);
    if (
      create ||
      issueCreate ||
      issueClose ||
      (projectCommand &&
        ["link", "item-add", "item-edit", "delete"].includes(args[1] ?? "")) ||
      (graph && (args[3] ?? "").includes("mutation"))
    )
      this.writes.push(`gh ${label}`);
  }
  /** `gh api graphql -f query=<document> -f name=value ...`, on the recorded resources. */
  private graphCall(args: readonly string[]): boolean {
    const [, , flag, query, ...rest] = args;
    if (flag !== "-f" || !query?.startsWith("query=")) return false;
    const document = query.slice("query=".length);
    const variables = new Map<string, string>();
    for (let i = 0; i < rest.length; i += 2) {
      if (rest[i] !== "-f") return false;
      const [name, value] = (rest[i + 1] ?? "").split(/=(.*)/s);
      if (!name || value === undefined) return false;
      variables.set(name, value);
    }
    if (document === harnessDocuments.setStatusOptions)
      return (
        variables.size === 1 &&
        this.field !== undefined &&
        variables.get("field") === this.field
      );
    if (
      document === harnessDocuments.projectLinks ||
      document === harnessDocuments.projectExists
    )
      return (
        variables.size === 1 &&
        variables.get("project") === this.project?.nodeId
      );
    return false;
  }
}
