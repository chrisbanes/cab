import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { hostname } from "node:os";
import { join, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { DeliveryStore } from "../../../src/core/delivery.js";
import { DomainStore } from "../../../src/core/domain.js";
import { UnstackStore } from "../../../src/core/unstack.js";
import {
  codexHomeFor,
  codexLoginLink,
  operatorAuthFile,
} from "../../../src/standalone/codex-home.js";
import {
  STANDALONE_MARKER_CONTENTS,
  STANDALONE_MARKER_NAME,
} from "../../../src/standalone/data-directory.js";
import { repositoryBindingSchema } from "../../../src/standalone/workspaces.js";
import {
  authorityHash,
  materialHash,
  type StackV2Authority,
} from "./stack-authority.js";

const configurationTables = [
  "domain_projects",
  "domain_tasks",
  "domain_assignments",
  "profiles",
  "project_repository_links",
  "delivery_policies",
  "installation_runtimes",
  "task_lead_bindings",
] as const;
/** Root can capture this same bounded readonly material when preparing each independent fixture. */
export function capturePreparedStackDatabase(databasePath: string) {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const schema = db
      .prepare(
        "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name,tbl_name",
      )
      .all();
    const configuration = Object.fromEntries(
      configurationTables.map((table) => [
        table,
        db
          .prepare(`SELECT * FROM ${table}`)
          .all()
          .sort((a, b) => materialHash(a).localeCompare(materialHash(b))),
      ]),
    );
    const level = z
      .object({ level: z.literal(14) })
      .parse(
        db
          .prepare(
            "SELECT level FROM startup_migration_level WHERE singleton=1",
          )
          .get(),
      ).level;
    const projects = z
      .array(z.object({ id: z.string() }))
      .parse(configuration.domain_projects);
    const tasks = z
      .array(
        z.object({
          id: z.string(),
          projectId: z.string(),
          version: z.number().int().positive(),
        }),
      )
      .parse(configuration.domain_tasks);
    const assignments = z
      .array(
        z.object({
          id: z.string(),
          taskId: z.string(),
          projectId: z.string(),
          version: z.number().int().positive(),
        }),
      )
      .parse(configuration.domain_assignments);
    const domain = new DomainStore(db);
    const runtimeSettings = assignments.map((assignment) => {
      const row = domain.assignment(assignment.id);
      const profileId = String(row.profileId),
        revision = Number(row.profileRevision);
      const runtime = domain.profileRuntime(profileId, revision),
        skills = domain.profileSkills(profileId, revision);
      return {
        taskId: assignment.taskId,
        assignmentId: assignment.id,
        profileRevision: revision,
        harness: runtime.harness,
        model: runtime.model ?? null,
        effort: runtime.reasoningEffort ?? null,
        plugins: skills.plugins.length,
        settingsSha256: materialHash({
          model: runtime.model ?? null,
          reasoningEffort: runtime.reasoningEffort ?? null,
        }),
      };
    });
    const leads = z
      .array(
        z.object({
          taskId: z.string(),
          assignmentId: z.string(),
          profileRevision: z.number(),
          instructionsRevision: z.number(),
        }),
      )
      .parse(configuration.task_lead_bindings);
    const unstack = new UnstackStore(db).records().map((record) => ({
      key: record.operationId,
      taskId: record.identity.taskId,
      identity: record.identity,
      commandSha256: materialHash({
        type: "task.unstack",
        ...record.command,
      }),
    }));
    const pendingActions = new DeliveryStore(db)
      .actions()
      .filter((action) =>
        ["prepared", "attempting", "uncertain"].includes(action.state),
      ).length;
    const pendingPublications = db
      .prepare(
        "SELECT publicationId FROM task_publications WHERE state IN ('reviewed','approved','sending')",
      )
      .all().length;
    const workspaceBindings = z
      .array(
        z.object({
          taskId: z.string(),
          path: z.string(),
          state: z.literal("ready"),
          gitUncertain: z.literal(0),
          repositories: z.string(),
        }),
      )
      .parse(
        db
          .prepare(
            "SELECT taskId,path,state,gitUncertain,repositories FROM task_workspace_bindings",
          )
          .all(),
      );
    const repositoryLinks = projects.map((project) => ({
      projectId: project.id,
      links: domain.repositoryLinks(project.id).links,
    }));
    const startupReferences = [
      domain.discoveryCredentialReference(),
      ...projects.map(
        (project) => domain.githubConfiguration(project.id).credentialRef,
      ),
    ];
    const otherCredentials =
      domain.codeHostCredentials().length +
      domain.issueTrackerCredentials().length +
      (domain.claudeTokenReference() ? 1 : 0);
    const archivedThreads = z
      .array(z.object({ threadId: z.string() }))
      .parse(db.prepare("SELECT threadId FROM conversation_archives").all())
      .map((row) => row.threadId);
    const unsafeExecutions = db
      .prepare(
        "SELECT workId FROM execution_intents WHERE state IN ('submitting','running','held','capacity-waiting')",
      )
      .all().length;
    const holds =
      db.prepare("SELECT taskId FROM task_writer_holds").all().length +
      db.prepare("SELECT taskId FROM task_writer_ambiguity_holds").all().length;
    const sourceRows = z
      .array(
        z.object({
          provider: z.string(),
          instance: z.string(),
          credentialRef: z.string().nullable(),
          selections: z.string(),
        }),
      )
      .parse(
        db
          .prepare(
            "SELECT provider,instance,credentialRef,selections FROM project_task_sources",
          )
          .all(),
      );
    const sources =
      sourceRows.filter(
        (row) =>
          row.provider !== "github" ||
          row.instance !== "github.com" ||
          row.credentialRef !== null ||
          z.array(z.unknown()).parse(JSON.parse(row.selections)).length !== 0,
      ).length +
      db.prepare("SELECT projectId FROM project_active_selections").all()
        .length;
    return {
      level,
      schemaFingerprint: authorityHash(JSON.stringify(schema)),
      configSha256: materialHash(configuration),
      projects,
      tasks,
      assignments,
      runtimeSettings,
      leads,
      unstack,
      pendingActions,
      pendingPublications,
      workspaceBindings,
      repositoryLinks,
      startupReferences,
      otherCredentials,
      archivedThreads,
      unsafeExecutions,
      holds,
      sources,
    };
  } finally {
    db.close();
  }
}

/** Capture actual Git metadata; HEAD explicitly represents a detached checkout. */
export async function captureSourceReferencePaths(
  root: string,
  git: (...args: string[]) => string,
) {
  const sourceHeadFile = resolve(root, git("rev-parse", "--git-path", "HEAD"));
  const sourceBranch = git("branch", "--show-current") || "HEAD";
  const loose = resolve(
    root,
    git("rev-parse", "--git-path", `refs/heads/${sourceBranch}`),
  );
  const sourceRefFile =
    sourceBranch === "HEAD"
      ? sourceHeadFile
      : await lstat(loose).then(
          () => loose,
          (error: NodeJS.ErrnoException) => {
            if (error.code !== "ENOENT") throw error;
            return resolve(root, git("rev-parse", "--git-path", "packed-refs"));
          },
        );
  return { sourceHeadFile, sourceBranch, sourceRefFile };
}

/** Exact commit identity for loose, packed and detached Git storage forms. */
export function sourceReferenceMatches(
  branch: string,
  head: string,
  ref: string,
  commit: string,
  packed: boolean,
) {
  if (branch === "HEAD")
    return !packed && head.trim() === commit && ref.trim() === commit;
  const name = `refs/heads/${branch}`;
  if (head.trim() !== `ref: ${name}`) return false;
  if (!packed) return ref.trim() === commit;
  const entries = ref
    .split(/\r?\n/)
    .filter((line) => line.split(" ")[1] === name);
  return entries.length === 1 && entries[0] === `${commit} ${name}`;
}

export async function verifyPreparedStackResources(
  authority: StackV2Authority,
  executionMode: "native" | "offline-only" = "native",
) {
  authority.current();
  const m = authority.manifest,
    host = m.authority.host;
  if (!/^env:[A-Z_][A-Z0-9_]*$/.test(m.credentialRef))
    throw Error("v2-credential-reference-not-supported");
  if (
    !authority.hasBoundInputs() ||
    (executionMode !== "offline-only" && process.platform !== "darwin") ||
    authority.readiness.hostId !== hostname()
  )
    throw Error("v2-host-readiness");
  const loadedRoot = await realpath(
    fileURLToPath(new URL("../../../../", import.meta.url)),
  );
  const toolchain = host.toolchain;
  if (
    host.sourceRoot !== loadedRoot ||
    (await realpath(process.execPath)) !== toolchain.nodeExecutable.path ||
    process.versions.node !== toolchain.nodeVersion ||
    toolchain.nvmrc.path !== join(loadedRoot, ".nvmrc") ||
    toolchain.packageJson.path !== join(loadedRoot, "package.json") ||
    toolchain.lockfile.path !== join(loadedRoot, "package-lock.json")
  )
    throw Error("v2-toolchain-identity");
  for (const pin of [
    toolchain.nodeExecutable,
    toolchain.nvmrc,
    toolchain.packageJson,
    toolchain.lockfile,
  ]) {
    const info = await lstat(pin.path);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      authorityHash(await readFile(pin.path)) !== pin.sha256
    )
      throw Error("v2-toolchain-pin");
  }
  if (
    (await readFile(toolchain.nvmrc.path, "utf8")).trim() !==
      toolchain.nodeVersion ||
    z
      .object({ packageManager: z.literal(toolchain.packageManager) })
      .parse(JSON.parse(await readFile(toolchain.packageJson.path, "utf8")))
      .packageManager !== toolchain.packageManager
  )
    throw Error("v2-toolchain-configuration");
  const sourceFiles = await readdir(join(loadedRoot, "src"), {
    recursive: true,
    withFileTypes: true,
  });
  const compiledSource = sourceFiles
    .filter((file) => file.isFile() && file.name.endsWith(".ts"))
    .map((file) =>
      join(
        loadedRoot,
        "dist",
        "src",
        file.parentPath.slice(join(loadedRoot, "src").length),
        file.name.replace(/\.ts$/, ".js"),
      ),
    );
  const requiredModules = [
    "./stack-authority.js",
    "./stack-real-journey.js",
    "./stack-audit.js",
    "./stack-files.js",
    "../../../src/standalone/git-process.js",
    "./stack-runtime.js",
    "./stack-real-adapter.js",
    "./stack-resource-preflight.js",
    "../../../src/standalone/service.js",
    "../../../src/standalone/codex.js",
    "../../../src/standalone/operator-api.js",
    "../../../src/standalone/github-delivery.js",
    "../../../src/standalone/git-fetch.js",
    "../../../src/standalone/rebase-proof.js",
    "../../../src/standalone/push-verification.js",
  ].map((relative) => fileURLToPath(new URL(relative, import.meta.url)));
  for (const path of [
    ...requiredModules,
    ...compiledSource,
    join(loadedRoot, "test/delivery/github-qualification/live-stack.mjs"),
    host.sourceHeadFile,
    host.sourceRefFile,
  ])
    if (!authority.readiness.source.some((pin) => pin.path === path))
      throw Error("v2-loaded-source-pin-missing");
  if (
    (host.sourceBranch === "HEAD" &&
      host.sourceHeadFile !== host.sourceRefFile) ||
    !sourceReferenceMatches(
      host.sourceBranch,
      await readFile(host.sourceHeadFile, "utf8"),
      await readFile(host.sourceRefFile, "utf8"),
      authority.readiness.sourceCommit,
      host.sourceRefFile.endsWith("/packed-refs"),
    )
  )
    throw Error("v2-source-head-changed");
  for (const pin of [host.runtimeExecutable, host.gitExecutable])
    if (!((await lstat(pin.path)).mode & 0o111))
      throw Error("v2-executable-mode");
  const directoryPins = [
    host.runRoot,
    host.dataDirectory,
    host.scratchParent,
    m.authority.gitFetch.workspace,
    m.authority.gitFetch.commonDirectory,
    ...m.authority.runtime.map((scope) => scope.workspace),
  ];
  if (
    !directoryPins.every((path) =>
      host.directories.some((pin) => pin.path === path),
    )
  )
    throw Error("v2-host-directory-pin-missing");
  const requiredWrites = [
    host.dataDirectory,
    host.scratchParent,
    join(m.authority.gitFetch.commonDirectory, "objects"),
    // Adopted refs live in the managed repository's reftable.
    join(m.authority.gitFetch.commonDirectory, "reftable"),
  ];
  if (
    !requiredWrites.every((path) => host.writes.includes(path)) ||
    new Set(m.authority.runtime.map((scope) => scope.workspace)).size !== 2
  )
    throw Error("v2-host-write-scope");
  const allowedWrites = new Set([
    ...requiredWrites,
    host.resultPath,
    `${host.resultPath}.tmp`,
    `${host.resultPath}.lock`,
    host.runtimeCredential.home,
    host.runtimeCredential.userHome,
    host.runtimeCredential.authTarget,
    ...m.authority.runtime.map((scope) => scope.workspace),
  ]);
  if (host.writes.some((path) => !allowedWrites.has(path)))
    throw Error("v2-extra-host-write-scope");
  const marker = join(host.dataDirectory, STANDALONE_MARKER_NAME);
  if (
    !host.files.some((pin) => pin.path === marker) ||
    (await readFile(marker, "utf8")) !== STANDALONE_MARKER_CONTENTS
  )
    throw Error("v2-prepared-service-marker");
  if (
    m.authority.runtime.some(
      (scope) => scope.maxTurns > 0 && !host.writes.includes(scope.workspace),
    )
  )
    throw Error("v2-runtime-workspace-write-scope");
  const databasePath = join(host.dataDirectory, "standalone.sqlite");
  const files = host.databaseFiles;
  if (
    !files.some((pin) => pin.path === databasePath) ||
    files.some(
      (pin) =>
        ![databasePath, `${databasePath}-wal`, `${databasePath}-shm`].includes(
          pin.path,
        ),
    )
  )
    throw Error("v2-database-scope");
  for (const pin of files) {
    const info = await lstat(pin.path);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.size > 33554432 ||
      authorityHash(await readFile(pin.path)) !== pin.sha256
    )
      throw Error("v2-database-pin");
  }
  // Prepared fixtures are checkpointed and quiescent; opening them never needs to create WAL metadata.
  const wal = await lstat(`${databasePath}-wal`).catch(
    (e: NodeJS.ErrnoException) => {
      if (e.code === "ENOENT") return null;
      throw e;
    },
  );
  if (wal && wal.size !== 0)
    throw Error("v2-prepared-database-not-checkpointed");
  const observed = capturePreparedStackDatabase(databasePath);
  authority.current();
  const taskIds = [m.resource.lowerTask, m.resource.upperTask];
  if (
    observed.schemaFingerprint !==
      "f0cc50cf3e479a85922ecfe951a4337fafbfd8af243328b38f2838e2ac328117" ||
    observed.schemaFingerprint !== host.schemaFingerprint ||
    observed.configSha256 !== host.configSha256 ||
    observed.projects.length !== 1 ||
    observed.projects[0]?.id !== m.resource.projectId ||
    observed.tasks.length !== 2 ||
    observed.tasks.some(
      (task) =>
        task.projectId !== m.resource.projectId || !taskIds.includes(task.id),
    ) ||
    observed.assignments.length !== 2 ||
    observed.assignments.some(
      (assignment) =>
        assignment.projectId !== m.resource.projectId ||
        !m.authority.runtime.some(
          (scope) =>
            scope.taskId === assignment.taskId &&
            scope.assignmentId === assignment.id,
        ),
    ) ||
    observed.unsafeExecutions ||
    observed.holds ||
    observed.sources
  )
    throw Error("v2-prepared-resource-ownership");
  if (
    observed.leads.length !== 2 ||
    observed.pendingActions ||
    observed.pendingPublications ||
    observed.otherCredentials ||
    observed.startupReferences.some(
      (ref) => ref !== null && ref !== m.credentialRef,
    ) ||
    observed.unstack.some(
      (record) =>
        record.key !== m.resource.operationKey ||
        record.taskId !== m.resource.upperTask,
    )
  )
    throw Error("v2-prepared-operation-ownership");
  if (
    observed.repositoryLinks.length !== 1 ||
    observed.repositoryLinks[0]?.links.length !== 1 ||
    observed.repositoryLinks[0].links.some(
      (link) =>
        link.codeHost !== "github" ||
        link.host !== "github.com" ||
        link.repositoryId !== m.resource.repositoryNodeId,
    )
  )
    throw Error("v2-prepared-repository-scope");
  if (observed.workspaceBindings.length !== 2)
    throw Error("v2-prepared-workspace-count");
  for (const record of observed.unstack) {
    const identity = record.identity,
      resource = m.resource;
    if (
      identity.projectId !== resource.projectId ||
      identity.repositoryId !== resource.repositoryNodeId ||
      identity.pr.nodeId !== resource.upperPrId ||
      identity.pr.number !== resource.upperPr ||
      identity.pr.headRef !== resource.upperRef ||
      identity.pr.headSha !== resource.upperHead ||
      identity.pr.baseRef !== resource.lowerRef ||
      identity.targetBaseRef !== resource.base ||
      String(identity.stack.id) !== resource.stackId ||
      identity.stack.number !== resource.stackNumber ||
      record.commandSha256 !== resource.unstackCommandSha256 ||
      identity.stack.members.length !== 2 ||
      identity.stack.members.some(
        (member, index) =>
          member.nodeId !==
            (index === 0 ? resource.lowerPrId : resource.upperPrId) ||
          member.number !==
            (index === 0 ? resource.lowerPr : resource.upperPr) ||
          member.headRef !==
            (index === 0 ? resource.lowerRef : resource.upperRef) ||
          member.headSha !==
            (index === 0 ? resource.lowerHead : resource.upperHead),
      )
    )
      throw Error("v2-original-journal-resource-binding");
  }
  for (const scope of m.authority.runtime) {
    const workspace = observed.workspaceBindings.find(
      (value) => value.taskId === scope.taskId,
    );
    if (!workspace || workspace.path !== scope.workspace)
      throw Error("v2-prepared-workspace-binding");
    const repositories = z
      .array(repositoryBindingSchema)
      .length(1)
      .parse(JSON.parse(workspace.repositories));
    const repository = repositories[0]!,
      link = observed.repositoryLinks[0]!.links[0]!;
    if (
      repository.repositoryId !== m.resource.repositoryNodeId ||
      repository.sourcePath !== link.path ||
      repository.gitCommonDir !== m.authority.gitFetch.commonDirectory ||
      !repository.workspacePath.startsWith(`${scope.workspace}${sep}`) ||
      (scope.taskId === m.resource.upperTask &&
        repository.workspacePath !== m.authority.gitFetch.workspace)
    )
      throw Error("v2-prepared-repository-workspace");
    if (
      (await realpath(repository.workspacePath)) !== repository.workspacePath ||
      (await realpath(link.path)) !== link.path
    )
      throw Error("v2-prepared-repository-path");
    if (
      scope.threadId !== null &&
      observed.archivedThreads.includes(scope.threadId)
    )
      throw Error("v2-archived-thread-not-granted");
    const task = observed.tasks.find((value) => value.id === scope.taskId),
      assignment = observed.assignments.find(
        (value) => value.id === scope.assignmentId,
      );
    if (
      !task ||
      !assignment ||
      !scope.taskVersions.includes(task.version) ||
      !scope.assignmentVersions.includes(assignment.version)
    )
      throw Error("v2-prepared-runtime-versions");
    const settings = observed.runtimeSettings.find(
      (value) => value.assignmentId === scope.assignmentId,
    );
    const lead = observed.leads.find(
      (value) =>
        value.taskId === scope.taskId &&
        value.assignmentId === scope.assignmentId,
    );
    if (
      !settings ||
      !lead ||
      lead.instructionsRevision !== scope.instructionsRevision ||
      lead.profileRevision !== scope.profileRevision ||
      settings.profileRevision !== scope.profileRevision ||
      settings.harness !== "codex" ||
      settings.plugins !== 0 ||
      settings.model !== scope.model ||
      settings.effort !== scope.effort ||
      settings.settingsSha256 !== scope.settingsSha256
    )
      throw Error("v2-prepared-runtime-settings");
  }
  if (materialHash(observed.runtimeSettings) !== host.settingsSha256)
    throw Error("v2-prepared-settings-digest");
  const home = codexHomeFor(host.dataDirectory),
    login = host.runtimeCredential;
  if (
    login.home !== home.home ||
    login.userHome !== home.userHome ||
    login.authTarget !== operatorAuthFile(process.env) ||
    authority.readiness.runtimeCredentialRef !==
      `codex-login:${login.authTarget}` ||
    (await codexLoginLink(home, process.env)) !== "ok"
  )
    throw Error("v2-runtime-login-binding");
  const auth = await lstat(login.authTarget);
  if (
    !auth.isFile() ||
    auth.isSymbolicLink() ||
    auth.dev !== login.dev ||
    auth.ino !== login.ino ||
    !host.writes.includes(login.authTarget)
  )
    throw Error("v2-runtime-login-ownership");
  authority.current();
  await authority.verifySourceIdentity();
  return observed;
}
