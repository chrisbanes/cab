import {
  profileConfigurationSchema,
  projectConfigurationSchema,
  runtimeSettingsSchema,
  searchReadSchema,
  taskListPageSchema,
  taskMessagePageSchema,
  workspaceSchema,
} from "../operator/contracts.js";
import {
  anyNull,
  type BrowseCommand,
  browseOutput,
  cursorQuery,
  decodeCursor,
  enumArg,
  optionalUuid,
  pageLimit,
  readWithCursor,
  timeArg,
  uuidArg,
} from "./browse.js";
import { CliError } from "./connections.js";
import { isoTime, keyValues, oneLine, table, unavailable } from "./render.js";

const API = "/api/operator";
const query = (params: Record<string, string | number | undefined>) =>
  new URLSearchParams(
    Object.entries(params).flatMap(([k, v]) =>
      v === undefined ? [] : [[k, String(v)]],
    ),
  ).toString();

const runtimeLine = (r: { state: string; since?: number }) =>
  r.state === "available"
    ? "available"
    : `unavailable since ${isoTime(r.since ?? 0)}`;
const harnessLine = (r: {
  harness: string;
  model?: string | null;
  reasoningEffort?: string | null;
}) =>
  r.harness === "claude"
    ? `claude (model ${r.model ?? "default"}, effort ${r.reasoningEffort ?? "default"})`
    : r.harness;

const projectList: BrowseCommand = {
  usage: "project list",
  positionals: 0,
  capabilities: ["cli.identity", "workspace.read"],
  async run(ctx) {
    const client = await ctx.connect();
    const read = await client.get(`${API}/workspace`, workspaceSchema);
    const { projects, runtime } = read.data;
    return browseOutput(ctx, {
      data: { projects, runtime },
      observedAt: read.observedAt,
      gaps: anyNull(...projects.map((p) => p.name))
        ? ["content-unavailable"]
        : [],
      human: [
        projects.length
          ? table(
              ["Project", "Name", "Lead profile", "Paused", "Version"],
              projects.map((p) => [
                p.id,
                unavailable(p.name),
                p.leadProfileId ?? "-",
                p.paused ? "yes" : "no",
                String(p.version),
              ]),
            )
          : "No projects.",
        `Runtime: ${runtimeLine(runtime)}`,
      ].join("\n"),
    });
  },
};

const profileList: BrowseCommand = {
  usage: "profile list",
  positionals: 0,
  capabilities: ["cli.identity", "workspace.read"],
  async run(ctx) {
    const client = await ctx.connect();
    const read = await client.get(`${API}/workspace`, workspaceSchema);
    const { profiles, runtime } = read.data;
    return browseOutput(ctx, {
      data: { profiles, runtime },
      observedAt: read.observedAt,
      gaps: anyNull(...profiles.flatMap((p) => [p.name, p.summary]))
        ? ["content-unavailable"]
        : [],
      human: [
        profiles.length
          ? table(
              ["Profile", "Name", "Revoked", "Version", "Summary"],
              profiles.map((p) => [
                p.id,
                unavailable(p.name),
                p.revoked ? "yes" : "no",
                String(p.version),
                oneLine(p.summary),
              ]),
            )
          : "No profiles.",
        `Runtime: ${runtimeLine(runtime)}`,
      ].join("\n"),
    });
  },
};

const projectGet: BrowseCommand = {
  usage: "project get PROJECT_ID",
  positionals: 1,
  capabilities: ["cli.identity", "workspace.read"],
  async run(ctx) {
    const id = uuidArg(ctx.positionals[2] ?? "", "PROJECT_ID");
    const client = await ctx.connect();
    const read = await client.get(
      `${API}/projects/${encodeURIComponent(id)}/configuration`,
      projectConfigurationSchema,
    );
    const d = read.data;
    return browseOutput(ctx, {
      data: d,
      observedAt: read.observedAt,
      gaps: anyNull(
        d.project.name,
        ...d.profiles.flatMap((p) => [p.name, p.summary]),
        ...d.source.selections.flatMap((s) => [s.id, s.descriptor]),
      )
        ? ["content-unavailable"]
        : [],
      human: [
        keyValues([
          ["Project", d.project.id],
          ["Name", unavailable(d.project.name)],
          ["Version", String(d.project.version)],
          ["Paused", d.project.paused ? "yes" : "no"],
          ["Lead profile", d.project.leadProfileId ?? "-"],
          [
            "Instructions",
            `revision ${d.instructionsRevision}, ${d.instructionPresent ? "present" : "empty"}`,
          ],
          [
            "Routing",
            `${d.routing.availability} (${d.routing.enabled ? "enabled" : "disabled"}, ${d.routing.candidateProfileIds.length} candidates)`,
          ],
          [
            "Sources",
            `${d.source.selections.length} selections, ${d.source.repositories.length} repositories`,
          ],
        ]),
        "",
        d.profiles.length
          ? table(
              ["Profile", "Name"],
              d.profiles.map((p) => [p.id, unavailable(p.name)]),
            )
          : "No profiles.",
      ].join("\n"),
    });
  },
};

const profileGet: BrowseCommand = {
  usage: "profile get PROFILE_ID",
  positionals: 1,
  capabilities: ["cli.identity", "workspace.read"],
  async run(ctx) {
    const id = uuidArg(ctx.positionals[2] ?? "", "PROFILE_ID");
    const client = await ctx.connect();
    const read = await client.get(
      `${API}/profiles/${encodeURIComponent(id)}/configuration`,
      profileConfigurationSchema,
    );
    const d = read.data;
    return browseOutput(ctx, {
      data: d,
      observedAt: read.observedAt,
      gaps: anyNull(d.profile.name, d.profile.summary, d.capabilities)
        ? ["content-unavailable"]
        : [],
      human: keyValues([
        ["Profile", d.profile.id],
        ["Name", unavailable(d.profile.name)],
        ["Summary", unavailable(d.profile.summary)],
        ["Version", String(d.profile.version)],
        ["Revoked", d.profile.revoked ? "yes" : "no"],
        ["Runtime", harnessLine(d.runtime)],
        ["Capabilities", unavailable(d.capabilities)],
        [
          "Instructions",
          `revision ${d.instructionRevision}, ${d.instructionPresent ? "present" : "empty"}`,
        ],
      ]),
    });
  },
};

const taskListCommand: BrowseCommand = {
  usage:
    "task list [--project ID] [--state open|done|cancelled] [--limit N] [--cursor TOKEN]",
  positionals: 0,
  capabilities: ["cli.identity", "task.list"],
  async run(ctx) {
    const { values } = ctx;
    const project = optionalUuid(values.project, "--project");
    const state = enumArg(
      values.state,
      ["open", "done", "cancelled"],
      "--state",
    );
    const limit = pageLimit(values, { serverMax: 100 });
    const q = cursorQuery({ project, state });
    const cursor = decodeCursor(values.cursor, "task list", q);
    const client = await ctx.connect();
    const read = await readWithCursor(!!cursor, () =>
      client.get(
        `${API}/task-list?${query({ limit: limit.limit, cursor: cursor?.c, projectId: project, state })}`,
        taskListPageSchema,
      ),
    );
    const { nextCursor, catalogFingerprint, ...page } = read.data;
    const changed = cursor?.f !== undefined && cursor.f !== catalogFingerprint;
    return browseOutput(ctx, {
      data: page,
      observedAt: read.observedAt,
      gaps: [
        ...(changed ? (["catalog-changed"] as const) : []),
        ...(anyNull(...page.tasks.map((t) => t.title))
          ? (["content-unavailable"] as const)
          : []),
      ],
      ...(changed ? { continuity: "changed" as const } : {}),
      page: {
        kind: "task list",
        query: q,
        limit,
        returned: page.tasks.length,
        next: nextCursor,
        fingerprint: cursor?.f ?? catalogFingerprint,
      },
      human: page.tasks.length
        ? table(
            ["Task", "Project", "State", "Execution", "Attention", "Title"],
            page.tasks.map((t) => [
              t.id,
              t.projectId,
              t.state,
              t.execution.state,
              t.attention.codes.join(",") || "-",
              oneLine(t.title),
            ]),
          )
        : "No tasks.",
    });
  },
};

const taskSearch: BrowseCommand = {
  usage:
    "task search QUERY [--project ID] [--type task|decision|result] [--after TIME] [--before TIME] [--historical] [--limit N] [--cursor TOKEN]",
  positionals: 1,
  capabilities: ["cli.identity", "task.search"],
  async run(ctx) {
    const { values } = ctx;
    const text = (ctx.positionals[2] ?? "").trim();
    if (!text || text.length > 256)
      throw new CliError("invalid-input", "QUERY must be 1 to 256 characters.");
    const project = optionalUuid(values.project, "--project");
    const type = enumArg(values.type, ["task", "decision", "result"], "--type");
    const after = timeArg(values.after, "--after");
    const before = timeArg(values.before, "--before");
    const limit = pageLimit(values, { serverMax: 50 });
    const q = cursorQuery({
      query: text,
      project,
      type,
      after,
      before,
      historical: values.historical,
    });
    const cursor = decodeCursor(values.cursor, "task search", q);
    const client = await ctx.connect();
    const read = await readWithCursor(!!cursor, () =>
      client.get(
        `${API}/search?${query({
          query: text,
          projectId: project,
          type,
          after,
          before,
          historical: values.historical ? "true" : undefined,
          cursor: cursor?.c,
          limit: limit.limit,
        })}`,
        searchReadSchema,
      ),
    );
    const { nextCursor, ...page } = read.data;
    return browseOutput(ctx, {
      data: page,
      observedAt: read.observedAt,
      notes: ["retained records only"],
      gaps: [
        ...(page.omittedCount > 0 ? (["item-omitted"] as const) : []),
        ...(anyNull(
          ...page.matches.flatMap((m) => [
            m.taskTitle,
            m.excerpt,
            m.projectName,
          ]),
        )
          ? (["content-unavailable"] as const)
          : []),
      ],
      page: {
        kind: "task search",
        query: q,
        limit,
        returned: page.matches.length,
        next: nextCursor,
      },
      human: page.matches.length
        ? table(
            ["Type", "Task", "Project", "Created", "Title", "Excerpt"],
            page.matches.map((m) => [
              m.type,
              m.taskId,
              m.projectId,
              isoTime(m.createdAt),
              oneLine(m.taskTitle, 40),
              oneLine(m.excerpt),
            ]),
          )
        : "No matches.",
    });
  },
};

const taskMessages: BrowseCommand = {
  usage: "task messages TASK_ID [--limit N] [--cursor TOKEN]",
  positionals: 1,
  capabilities: ["cli.identity", "task.records"],
  async run(ctx) {
    const id = uuidArg(ctx.positionals[2] ?? "", "TASK_ID");
    const limit = pageLimit(ctx.values, { serverMax: 200 });
    const q = cursorQuery({ task: id });
    const cursor = decodeCursor(ctx.values.cursor, "task messages", q);
    const client = await ctx.connect();
    const read = await readWithCursor(!!cursor, () =>
      client.get(
        `${API}/tasks/${encodeURIComponent(id)}/messages?${query({ limit: limit.limit, cursor: cursor?.c })}`,
        taskMessagePageSchema,
      ),
    );
    const { nextCursor, ...page } = read.data;
    return browseOutput(ctx, {
      data: page,
      observedAt: read.observedAt,
      gaps: anyNull(
        ...page.messages.flatMap((m) => [
          m.text,
          m.action,
          m.target,
          m.routingReason,
        ]),
      )
        ? ["content-unavailable"]
        : [],
      page: {
        kind: "task messages",
        query: q,
        limit,
        returned: page.messages.length,
        next: nextCursor,
      },
      human: [
        `${page.total} messages`,
        page.messages.length
          ? table(
              ["Event", "Created", "Type", "Delivery", "Text"],
              page.messages.map((m) => [
                m.eventId,
                isoTime(m.createdAt),
                m.eventType,
                m.deliveryState,
                m.text === undefined ? "-" : oneLine(m.text),
              ]),
            )
          : "",
      ]
        .filter(Boolean)
        .join("\n"),
    });
  },
};

/** Reads capacity through the runtime settings read; per-task rows are dropped. */
const capacityGet: BrowseCommand = {
  usage: "capacity get",
  positionals: 0,
  capabilities: ["cli.identity", "capacity.read"],
  async run(ctx) {
    const client = await ctx.connect();
    const read = await client.get(`${API}/runtime`, runtimeSettingsSchema);
    const r = read.data;
    const projects = r.projects.map((p) => ({
      projectId: p.project.id,
      name: p.project.name,
      limit: p.limit,
      override: p.override,
      usage: p.usage,
    }));
    return browseOutput(ctx, {
      data: {
        globalLimit: r.globalLimit,
        defaultProjectLimit: r.defaultProjectLimit,
        globalUsage: r.globalUsage,
        projects,
      },
      observedAt: read.observedAt,
      gaps: anyNull(...projects.map((p) => p.name))
        ? ["content-unavailable"]
        : [],
      human: [
        keyValues([
          ["Global limit", String(r.globalLimit)],
          ["Global usage", String(r.globalUsage)],
          ["Default project limit", String(r.defaultProjectLimit)],
        ]),
        "",
        table(
          ["PROJECT", "NAME", "LIMIT", "OVERRIDE", "USAGE"],
          projects.map((p) => [
            p.projectId,
            oneLine(p.name, 40),
            String(p.limit),
            p.override === null ? "default" : String(p.override),
            String(p.usage),
          ]),
        ),
      ].join("\n"),
    });
  },
};

export const workspaceCommands: [string, BrowseCommand][] = [
  ["capacity get", capacityGet],
  ["project list", projectList],
  ["profile list", profileList],
  ["project get", projectGet],
  ["profile get", profileGet],
  ["task list", taskListCommand],
  ["task search", taskSearch],
  ["task messages", taskMessages],
];
