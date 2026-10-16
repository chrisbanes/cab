import { Inbox, InboxState, loadInbox, type InboxHeader } from "./inbox.js";
import { inboxSummaryOf } from "./request-presentation.js";
import { useMediaQuery } from "./use-media-query.js";
import { QuestionResponseStates } from "./question-response-state.js";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useReducer,
  useState,
  useRef,
  type ReactNode,
} from "react";
import {
  CirclePause,
  ExternalLink,
  Folder,
  Gauge,
  InboxIcon,
  LayoutDashboard,
  ListChecks,
  LogOut,
  Plus,
  Search as SearchIcon,
  Settings,
} from "lucide-react";
import {
  workspaceSchema,
  type Session,
  type TaskListSummary,
  type Workspace,
} from "../../src/operator/contracts.js";
import { ClientError, OperatorClient } from "./api.js";
import { useOperatorResource, type ResourceState } from "./resource.js";
import {
  ActionLink,
  Button,
  StatusBadge,
  ResourceStatus,
  MobileNavigation,
  NavigationRow,
  PageHeader,
  TopBar,
} from "./components.js";
import { ActionOutcome } from "./action-feedback.js";
import { Alert } from "./ui/alert.js";
import {
  isActiveColumn,
  loadTaskList,
  taskColumn,
  taskRouteSubtitle,
} from "./tasks.js";
import { TaskComposer } from "./task-composer.js";
import { RuntimeSettings, AssignmentRecovery } from "./recovery.js";
import { unavailableAlert } from "./execution-runtime.js";
import { ConfigurationDrafts } from "./settings-state.js";
import { ProjectSetup } from "./project-setup.js";
import { SettingsWorkspace } from "./settings-index.js";
import { ProfileConfiguration, ProfileCreate } from "./profile-config.js";
import { ProjectConfiguration } from "./project-config.js";
import { settingsHeader } from "./settings-view.js";
import { Search, SearchState } from "./search.js";
import { TaskWorkspace } from "./task-workspace.js";
import { TaskHeaderActions, type TaskHeaderReport } from "./task-header.js";
import { TaskWorkspaceStates } from "./task-workspace-state.js";
import { TaskViews } from "./task-views.js";
import { Login, SignInBootstrap } from "./sign-in.js";
import { NotFound, notFoundSubtitle } from "./not-found.js";
import { AccountMenu, OPERATOR_LABEL } from "./account-menu.js";
import {
  configureGettingStarted,
  GETTING_STARTED_DRAFT,
  GettingStarted,
} from "./getting-started.js";
function RouteLink({
  href,
  current,
  navigate,
  icon,
  row,
  trailing,
  className,
  describedBy,
  children,
}: {
  href: string;
  /** `true` marks the current page; `"true"` marks a related current item (project settings). */
  current: boolean | "true";
  navigate: (path: string) => void;
  icon: ReactNode;
  row: boolean;
  trailing?: ReactNode;
  className?: string;
  describedBy?: string;
  children: ReactNode;
}) {
  return (
    <a
      className={`nav-link${row ? " nav-row" : ""}${className ? ` ${className}` : ""}`}
      href={href}
      aria-current={current === true ? "page" : current || undefined}
      aria-describedby={describedBy}
      onClick={(e) => {
        if (
          e.button === 0 &&
          !e.ctrlKey &&
          !e.metaKey &&
          !e.shiftKey &&
          !e.altKey
        ) {
          e.preventDefault();
          navigate(href);
        }
      }}
    >
      {row ? (
        <NavigationRow icon={icon} title={children} trailing={trailing} />
      ) : (
        <>
          {icon}
          <span className="nav-label">
            <span>{children}</span>
          </span>
          {trailing}
        </>
      )}
    </a>
  );
}
const navIcon = { "aria-hidden": true, className: "nav-icon" } as const;
function ProjectNavigation({
  workspace,
  path,
  navigate,
  inboxCount,
  tasks,
  row,
}: {
  workspace: Workspace | null;
  path: string;
  navigate: (path: string) => void;
  inboxCount: number | null;
  tasks: TaskListSummary[] | undefined;
  row: boolean;
}) {
  const countId = useId();
  const pathname = path.split(/[?#]/)[0] ?? "";
  const link = (
    href: string,
    current: boolean | "true",
    icon: ReactNode,
    label: ReactNode,
    extra: {
      trailing?: ReactNode;
      className?: string;
      describedBy?: string;
    } = {},
  ) => (
    <RouteLink
      href={href}
      current={current}
      navigate={navigate}
      icon={icon}
      row={row}
      {...extra}
    >
      {label}
    </RouteLink>
  );
  return (
    <nav aria-label="Operator navigation">
      {link(
        "/app",
        pathname === "/app",
        <LayoutDashboard {...navIcon} />,
        "Overview",
      )}
      {link(
        "/app/inbox",
        pathname === "/app/inbox",
        <InboxIcon {...navIcon} />,
        "Inbox",
        inboxCount === null
          ? {}
          : {
              describedBy: countId,
              trailing: (
                <>
                  <span className="nav-count metadata" aria-hidden="true">
                    {inboxCount}
                  </span>
                  <span id={countId} hidden>
                    {inboxCount} unresolved
                  </span>
                </>
              ),
            },
      )}
      {link(
        "/app/tasks",
        pathname === "/app/tasks",
        <ListChecks {...navIcon} />,
        "Tasks",
      )}
      {link(
        "/app/search",
        pathname === "/app/search",
        <SearchIcon {...navIcon} />,
        "Search",
      )}
      <h2 className="nav-heading">Projects</h2>
      {workspace?.data.projects.length === 0 && (
        <p className="body muted">No projects yet.</p>
      )}
      {workspace?.data.projects.map((p) =>
        link(
          `/app/projects/${p.id}`,
          pathname === `/app/projects/${p.id}` ||
            (pathname === `/app/projects/${p.id}/settings` && "true"),
          <Folder {...navIcon} />,
          p.name ?? "Name unavailable",
          {
            trailing: p.paused ? (
              <StatusBadge tone="idle" icon={CirclePause}>
                Paused
              </StatusBadge>
            ) : tasks ? (
              <span className="nav-count metadata">
                {
                  tasks.filter(
                    (t) =>
                      t.project.id === p.id && isActiveColumn(taskColumn(t)),
                  ).length
                }{" "}
                active
              </span>
            ) : undefined,
          },
        ),
      )}
      {link(
        "/app/settings/projects/new",
        pathname === "/app/settings/projects/new",
        <Plus {...navIcon} />,
        "New project",
      )}
    </nav>
  );
}
/** Sidebar Search work field: opens the retained-record search; ⌘K / Ctrl+K focuses it (or Search's field). */
function SearchWorkField({ navigate }: { navigate: (path: string) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const go = useRef(navigate);
  go.current = navigate;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "k") return;
      e.preventDefault();
      // The drawer layouts hide this field, so the shortcut opens the Search page's field instead.
      if (input.current?.checkVisibility()) return input.current.focus();
      if (location.pathname !== "/app/search") go.current("/app/search");
      requestAnimationFrame(() =>
        document.getElementById("retained-query")?.focus(),
      );
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, []);
  return (
    <search>
      <form
        className="search-work"
        onSubmit={(e) => {
          e.preventDefault();
          const query = input.current?.value.trim();
          navigate(
            query
              ? `/app/search?query=${encodeURIComponent(query)}`
              : "/app/search",
          );
        }}
      >
        <SearchIcon {...navIcon} />
        <input
          ref={input}
          type="search"
          name="query"
          aria-label="Search work"
          aria-keyshortcuts="Meta+K Control+K"
          placeholder="Search work"
          maxLength={256}
          className="body"
        />
        <span className="kbd identifier" aria-hidden="true">
          ⌘K
        </span>
      </form>
    </search>
  );
}
/**
 * Sidebar capacity meter. shortcut: reads global turn usage from the task list (every summary
 * carries the same global figures), so it is absent with no tasks; read the runtime capacity
 * directly if the shell needs it on an empty installation.
 */
function CapacityMeter({ tasks }: { tasks: TaskListSummary[] | undefined }) {
  const capacity = tasks?.[0]?.capacity;
  if (!capacity) return null;
  const { globalUsage: used, globalLimit: limit } = capacity;
  return (
    <div className="capacity-meter">
      <p className="metadata">
        <span className="muted">Running turns</span>{" "}
        <span className="identifier">
          {used}/{limit}
        </span>
      </p>
      <meter
        min={0}
        max={Math.max(limit, 1)}
        value={Math.min(used, limit)}
        aria-label={`Running turns: ${used} of ${limit}`}
      />
    </div>
  );
}
/** Connection status from the shell's workspace read: delayed keeps the last data, disconnected has none. */
function connectionOf(state: ResourceState<unknown>) {
  if (state.status === "error")
    return { tone: "error", label: "Disconnected" } as const;
  if (state.status === "stale" && state.error)
    return { tone: "warning", label: "Updates delayed" } as const;
  // Only a completed read claims a connection; before the first one, show nothing.
  return state.data ? ({ tone: "success", label: "Connected" } as const) : null;
}
/** Phone drawer account group: always visible rows, since no popup is nested in the Sheet. */
function AccountRows({
  path,
  navigate,
  pending,
  onSignOut,
  gettingStartedDismissed,
  onShowGettingStarted,
}: {
  path: string;
  navigate: (path: string) => void;
  pending: boolean;
  onSignOut: () => void;
  gettingStartedDismissed: boolean | null;
  onShowGettingStarted: () => void;
}) {
  const pathname = path.split(/[?#]/)[0];
  return (
    <section className="account-rows" aria-label="Account">
      <p className="metadata muted">Signed in as {OPERATOR_LABEL}</p>
      <RouteLink
        href="/app/settings"
        current={pathname === "/app/settings"}
        navigate={navigate}
        icon={<Settings {...navIcon} />}
        row
      >
        Settings
      </RouteLink>
      <RouteLink
        href="/app/settings/runtime"
        current={pathname === "/app/settings/runtime"}
        navigate={navigate}
        icon={<Gauge {...navIcon} />}
        row
      >
        Runtime
      </RouteLink>
      {gettingStartedDismissed === false && (
        <RouteLink
          href="/app/getting-started"
          current={pathname === "/app/getting-started"}
          navigate={navigate}
          icon={<ListChecks {...navIcon} />}
          row
        >
          Getting started
        </RouteLink>
      )}
      {gettingStartedDismissed && (
        <Button variant="secondary" onClick={onShowGettingStarted}>
          <ListChecks aria-hidden="true" />
          Show getting started
        </Button>
      )}
      {/* Server-rendered page outside the app shell: a plain anchor, so it loads as a document. */}
      <a className="nav-link nav-row" href="/coordination">
        <NavigationRow
          icon={<ExternalLink {...navIcon} />}
          title="Approval and delivery forms"
        />
      </a>
      <Button variant="secondary" disabled={pending} onClick={onSignOut}>
        <LogOut aria-hidden="true" />
        {pending ? "Signing out…" : "Sign out"}
      </Button>
    </section>
  );
}
/** Static parent of a nested route, for the phone Back link. Top-level routes have none. */
function parentRoute(
  pathname: string,
  search: string,
  workspace: Workspace | null,
): { href: string; label: string } | null {
  if (pathname === "/app/tasks/new") {
    const id = new URLSearchParams(search).get("project");
    return id
      ? {
          href: `/app/projects/${encodeURIComponent(id)}`,
          label:
            workspace?.data.projects.find((p) => p.id === id)?.name ??
            "Project",
        }
      : { href: "/app/tasks", label: "Tasks" };
  }
  if (/^\/app\/tasks\/[^/]+$/.test(pathname))
    return { href: "/app/tasks", label: "Tasks" };
  if (/^\/app\/assignments\/[^/]+\/recovery$/.test(pathname))
    return { href: "/app/settings/runtime", label: "Runtime" };
  if (
    pathname.startsWith("/app/settings/") ||
    /^\/app\/(projects|profiles)\/[^/]+\/settings$/.test(pathname)
  )
    return { href: "/app/settings", label: "Settings" };
  return null;
}
/**
 * Whether an `/app` address matches a client route; mirrors the view chosen in `App` and the
 * service's `shell()` routes. Task ids are not checked here: the task workspace owns its own
 * not-found state for a malformed id.
 */
function knownRoute(pathname: string) {
  const id = "[a-f0-9-]{36}";
  return (
    [
      "/app",
      "/app/tasks",
      "/app/tasks/new",
      "/app/inbox",
      "/app/search",
      "/app/getting-started",
      "/app/settings",
      "/app/settings/runtime",
      "/app/settings/projects/new",
      "/app/settings/profiles/new",
    ].includes(pathname) ||
    /^\/app\/tasks\/[^/]+$/.test(pathname) ||
    new RegExp(`^/app/projects/${id}$`).test(pathname) ||
    new RegExp(`^/app/assignments/${id}/recovery$`).test(pathname) ||
    new RegExp(`^/app/(?:projects|profiles)/${id}/settings$`).test(pathname)
  );
}
function pushAppEntry(href: string, navigationScope: string) {
  const fromSearch = location.pathname === "/app/search";
  history.pushState(
    {
      origin: location.pathname + location.search,
      workspaceOrigin: fromSearch
        ? history.state?.workspaceOrigin
        : location.pathname + location.search,
      navigationScope,
      navKey: crypto.randomUUID(),
      entryIndex: (history.state?.entryIndex ?? 0) + 1,
      workspaceIndex: fromSearch
        ? (history.state?.workspaceIndex ?? 0)
        : (history.state?.entryIndex ?? 0),
    },
    "",
    href,
  );
}
export function App() {
  const drafts = useRef(new ConfigurationDrafts());
  // Re-renders the shell, so the open page re-binds a draft the shell started.
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const acceptedIdentity = useRef<string | null>(null);
  const navigationScope = useRef(crypto.randomUUID());
  const clearPrivateNavigation = () => {
    const next =
      location.pathname === "/app/search"
        ? "/app/search"
        : location.pathname + location.search;
    history.replaceState(
      { navigationScope: navigationScope.current, navKey: crypto.randomUUID() },
      "",
      next,
    );
    setPath(next);
  };
  const clientRef = useRef<OperatorClient | null>(null);
  const [session, setSession] = useState<Session | null>(null),
    [bootstrapError, setBootstrapError] = useState(false),
    [bootstrap, setBootstrap] = useState(0),
    [path, setPath] = useState(location.pathname + location.search),
    [navigationVersion, setNavigationVersion] = useState(0),
    [drawer, setDrawer] = useState(false),
    [logoutPending, setLogoutPending] = useState(false),
    [stillSignedIn, setStillSignedIn] = useState(false),
    [expiredNotice, setExpiredNotice] = useState(false),
    [refreshNonce, setRefreshNonce] = useState(0);
  // Set when a sign-out could not be confirmed; the session re-read that follows settles it.
  const unconfirmedSignOut = useRef(false);
  const searchState = useRef(new Map<string, SearchState>());
  const taskStates = useRef(new TaskWorkspaceStates());
  const questionStates = useRef(new QuestionResponseStates());
  const inboxState = useRef(new InboxState());
  // biome-ignore lint/correctness/useExhaustiveDependencies: navigation purge uses current browser entry and stable scope ref.
  const expired = useCallback(() => {
    navigationScope.current = crypto.randomUUID();
    clearPrivateNavigation();
    clientRef.current?.invalidateAuthentication();
    acceptedIdentity.current = null;
    setLogoutPending(false);
    drafts.current.purge();
    taskStates.current.purge();
    questionStates.current.purge();
    inboxState.current.clear();
    searchState.current.clear();
    setSession(null);
    setExpiredNotice(true);
    setBootstrap((v) => v + 1);
    setDrawer(false);
  }, []);
  const client = useMemo(() => new OperatorClient(fetch, expired), [expired]);
  clientRef.current = client;
  // biome-ignore lint/correctness/useExhaustiveDependencies: browser-entry purge is needed only when accepting this exact current authentication scope.
  const acceptSession = useCallback(
    (next: Session) => {
      const identity = next.authenticated ? next.csrfToken : null;
      if (identity !== acceptedIdentity.current) {
        if (!identity && acceptedIdentity.current) {
          navigationScope.current = crypto.randomUUID();
          clearPrivateNavigation();
        }
        client.invalidateAuthentication();
        drafts.current.purge();
        taskStates.current.purge();
        questionStates.current.purge();
        inboxState.current.clear();
        searchState.current.clear();
        if (
          identity &&
          history.state?.navigationScope &&
          history.state.navigationScope !== navigationScope.current
        )
          clearPrivateNavigation();
        if (identity)
          history.replaceState(
            { ...history.state, navigationScope: navigationScope.current },
            "",
          );
        acceptedIdentity.current = identity;
        setLogoutPending(false);
        setStillSignedIn(false);
      }
      // Signed out is the outcome; only a session that survived needs a word.
      if (unconfirmedSignOut.current) {
        unconfirmedSignOut.current = false;
        setStillSignedIn(next.authenticated);
      }
      if (next.authenticated) setExpiredNotice(false);
      setSession(next);
    },
    [client],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: bootstrap explicitly refreshes the server session after expiry or retry.
  useEffect(() => {
    let active = true;
    setBootstrapError(false);
    const isCurrentScope = client.captureAuthenticationScope();
    client.session().then(
      (s) => {
        if (active && isCurrentScope()) acceptSession(s);
      },
      () => {
        if (active && isCurrentScope()) setBootstrapError(true);
      },
    );
    return () => {
      active = false;
    };
  }, [client, bootstrap, acceptSession]);
  const restoreFocus = useRef<string | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: current scope ref guards browser Back/Forward entries across authentication expiry.
  useEffect(() => {
    const pop = () => {
      if (history.state?.navigationScope !== navigationScope.current) {
        clearPrivateNavigation();
        restoreFocus.current = null;
      } else restoreFocus.current = history.state?.focusedHref ?? null;
      setDrawer(false);
      setPath(location.pathname + location.search);
      setNavigationVersion((n) => n + 1);
      requestAnimationFrame(() =>
        scrollTo(
          0,
          (history.state as { scrollY?: number } | null)?.scrollY ?? 0,
        ),
      );
    };
    addEventListener("popstate", pop);
    return () => removeEventListener("popstate", pop);
  }, []);
  const loader = useCallback(
    (signal: AbortSignal) =>
      client.read("/api/operator/workspace", workspaceSchema, signal),
    [client],
  );
  const workspace = useOperatorResource(
    session?.authenticated ? session.csrfToken : null,
    loader,
  );
  const taskLoader = useCallback(
    (signal: AbortSignal) => loadTaskList(client, signal),
    [client],
  );
  const tasks = useOperatorResource(
    session?.authenticated ? session.csrfToken : null,
    taskLoader,
  );
  const inboxLoader = useCallback(
    (signal: AbortSignal) => loadInbox(client, signal),
    [client],
  );
  // The Inbox route polls its own full read and reports its total, so the shell reads only elsewhere.
  const onInboxRoute = path.split(/[?#]/)[0] === "/app/inbox";
  // At the sidebar shell the Inbox queue header owns the heading, summary and Refresh.
  const inboxOwnsHeader = useMediaQuery("(min-width: 1121px)") && onInboxRoute;
  const [inboxRouteSummary, setInboxRouteSummary] =
    useState<ReturnType<typeof inboxSummaryOf>>(null);
  const [inboxHeader, setInboxHeader] = useState<InboxHeader | null>(null);
  const [taskHeader, setTaskHeader] = useState<TaskHeaderReport | null>(null);
  const inboxSummary = useOperatorResource(
    session?.authenticated ? session.csrfToken : null,
    inboxLoader,
    !onInboxRoute,
  );
  const taskRefresh = useRef(tasks.poll);
  taskRefresh.current = tasks.poll;
  const workspaceRefresh = useRef(workspace.poll);
  workspaceRefresh.current = workspace.poll;
  const inboxScope =
    session?.authenticated && path.split("?")[0] === "/app/inbox"
      ? session.csrfToken
      : null;
  useEffect(() => {
    if (!inboxScope) return;
    taskRefresh.current();
    const timer = setInterval(() => {
      taskRefresh.current();
      workspaceRefresh.current();
    }, 15000);
    return () => clearInterval(timer);
  }, [inboxScope]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: restore the previous entry focus after its route and asynchronous task content render.
  useEffect(() => {
    const href = restoreFocus.current;
    if (!href) return;
    const target = [
      ...document.querySelectorAll<HTMLAnchorElement>("a[href]"),
    ].find((a) => a.getAttribute("href") === href);
    if (target) {
      target.focus({ preventScroll: true });
      restoreFocus.current = null;
    }
  }, [path, navigationVersion, tasks.state.data, workspace.state.data]);
  useEffect(() => {
    const click = (e: MouseEvent) => {
      if (e.defaultPrevented) return;
      const target = e.target;
      if (!(target instanceof Element)) return;
      const anchor = target.closest("a"),
        href = anchor?.getAttribute("href");
      if (
        href?.startsWith("/app") &&
        // A link that asks for a new tab keeps this page as it is.
        anchor?.target !== "_blank" &&
        !e.ctrlKey &&
        !e.metaKey &&
        !e.shiftKey &&
        !e.altKey &&
        e.button === 0
      ) {
        e.preventDefault();
        history.replaceState(
          { ...history.state, scrollY, focusedHref: href },
          "",
        );
        pushAppEntry(href, navigationScope.current);
        setPath(href);
        setNavigationVersion((n) => n + 1);
        setDrawer(false);
      }
    };
    document.addEventListener("click", click);
    return () => document.removeEventListener("click", click);
  }, []);
  const addressPath = path.split(/[?#]/)[0] ?? "/app";
  // A signed-in visit to /login lands on Overview, like the legacy server's redirect.
  const pathname =
    addressPath === "/login" && session?.authenticated ? "/app" : addressPath;
  useEffect(() => {
    if (pathname !== addressPath) {
      history.replaceState({ ...history.state }, "", "/app");
      setPath("/app");
    }
  }, [pathname, addressPath]);
  const navigate = (next: string) => {
    history.replaceState({ ...history.state, scrollY }, "");
    pushAppEntry(next, navigationScope.current);
    setPath(next);
    setNavigationVersion((n) => n + 1);
    setDrawer(false);
  };
  if (!session)
    return (
      <SignInBootstrap
        unavailable={bootstrapError}
        retry={() => setBootstrap((v) => v + 1)}
      />
    );
  if (!session.authenticated)
    return (
      <Login
        key={session.csrfToken}
        client={client}
        session={session}
        expired={expiredNotice}
        onSignedIn={(next) => {
          if (pathname === "/login") {
            history.replaceState(null, "", "/app");
            setPath("/app");
          }
          acceptSession(next);
        }}
      />
    );
  const entryKey = history.state?.navKey ?? path;
  let activeSearch = searchState.current.get(entryKey);
  if (!activeSearch) {
    activeSearch = new SearchState();
    searchState.current.set(entryKey, activeSearch);
  }
  const projectId = pathname.match(/^\/app\/projects\/([a-f0-9-]{36})$/)?.[1];
  const project = workspace.state.data?.data.projects.find(
    (p) => p.id === projectId,
  );
  const unknownRoute = !knownRoute(pathname);
  // A fragment (#source-readiness) is not part of the query.
  const search = path.split("#")[0] ?? "",
    query = search.includes("?") ? search.slice(search.indexOf("?")) : "";
  const settingsPage = unknownRoute
    ? null
    : settingsHeader(pathname, query, workspace.state.data);
  const title = settingsPage
    ? settingsPage.title
    : unknownRoute
      ? "Page not found"
      : pathname === "/app/search"
        ? "Search"
        : pathname === "/app/getting-started"
          ? "Getting started"
          : pathname === "/app"
            ? "Overview"
            : /^\/app\/tasks\/[^/]+$/.test(pathname) &&
                pathname !== "/app/tasks/new"
              ? "Task"
              : pathname === "/app/tasks"
                ? "All tasks"
                : pathname === "/app/tasks/new"
                  ? "Create a task"
                  : pathname === "/app/inbox"
                    ? "Inbox"
                    : (project?.name ?? "Project");
  const inboxCount =
    (onInboxRoute ? inboxRouteSummary : inboxSummaryOf(inboxSummary.state))
      ?.count ?? null;
  // The task views put their intro and the one primary action in the page header.
  const taskRoute =
    pathname === "/app" || pathname === "/app/tasks" || Boolean(projectId);
  const newTaskHref = `/app/tasks/new${projectId ? `?project=${encodeURIComponent(projectId)}` : ""}`;
  const headerSubtitle = unknownRoute
    ? notFoundSubtitle
    : taskRoute
      ? taskRouteSubtitle(
          projectId ? "project" : pathname === "/app" ? "overview" : "tasks",
          tasks.state.data?.tasks,
          workspace.state.data?.data ?? null,
          projectId,
        )
      : pathname === "/app/tasks/new"
        ? "Describe the result you want. The project lead stays accountable."
        : pathname === "/app/settings/projects/new"
          ? workspace.state.data?.data.projects.length === 0
            ? "No projects yet. A project groups tasks with a lead, instructions and explicit repository access."
            : "Three short steps. Saving creates a paused project; nothing runs until you resume it."
          : undefined;
  // The Inbox route refreshes its own list (and so the count) when the workspace read changes.
  const refreshAll = () => {
    workspace.refresh();
    if (!onInboxRoute) inboxSummary.refresh();
    if (settingsPage) setRefreshNonce((n) => n + 1);
  };
  // These pages own a refresh that already re-reads their data.
  const ownsRefresh =
    unknownRoute ||
    pathname === "/app" ||
    pathname === "/app/tasks" ||
    Boolean(projectId) ||
    (/^\/app\/tasks\/[^/]+$/.test(pathname) && pathname !== "/app/tasks/new") ||
    (pathname === "/app/search" &&
      Boolean(new URLSearchParams(query).get("query")));
  const parent = unknownRoute
    ? null
    : parentRoute(pathname, query, workspace.state.data);
  // The Inbox reports its own subtitle, and on a phone its request-detail header.
  const { detail: inboxDetail, subtitle: inboxSubtitle } =
    (onInboxRoute && inboxHeader) || {};
  const inboxHeaderProps = inboxDetail
    ? {
        title: inboxDetail.title,
        subtitle: inboxDetail.subtitle,
        back: inboxDetail.back,
        menu: undefined,
        badge: undefined,
        action: inboxDetail.action,
      }
    : inboxSubtitle
      ? { subtitle: inboxSubtitle }
      : {};
  // The task page reports its title, status line, Back and Stop once its read lands.
  const taskReport =
    taskHeader && pathname === `/app/tasks/${taskHeader.taskId}`
      ? taskHeader
      : null;
  const taskHeaderProps = taskReport
    ? {
        title: taskReport.title,
        subtitle: taskReport.subtitle,
        back: taskReport.back,
        desktopBack: true,
        action: (
          <TaskHeaderActions
            report={taskReport}
            csrfToken={session.csrfToken}
          />
        ),
      }
    : {};
  async function logout() {
    navigationScope.current = crypto.randomUUID();
    clearPrivateNavigation();
    client.invalidateAuthentication();
    acceptedIdentity.current = null;
    const isCurrentScope = client.captureAuthenticationScope();
    drafts.current.purge();
    taskStates.current.purge();
    questionStates.current.purge();
    inboxState.current.clear();
    searchState.current.clear();
    setLogoutPending(true);
    setStillSignedIn(false);
    try {
      await client.logout(session?.csrfToken ?? "");
    } catch (error) {
      if (
        isCurrentScope() &&
        error instanceof ClientError &&
        error.status !== 401
      )
        unconfirmedSignOut.current = true;
    } finally {
      if (isCurrentScope()) {
        setSession(null);
        setDrawer(false);
        setLogoutPending(false);
        setBootstrap((v) => v + 1);
      }
    }
  }
  const gettingStartedMenu = {
    gettingStartedDismissed:
      workspace.state.data?.data.gettingStarted.dismissed ?? null,
    onShowGettingStarted: () => {
      navigate("/app/getting-started");
      void configureGettingStarted(
        drafts.current.get(GETTING_STARTED_DRAFT, rerender),
        { client, session, onChanged: workspace.refresh },
        false,
      );
    },
  };
  const waitProps = {
    client,
    session,
    drafts: drafts.current,
    workspace: workspace.state.data,
    onChanged: refreshAll,
  };
  const navigation = (row: boolean) => (
    <>
      <ProjectNavigation
        workspace={workspace.state.data}
        path={path}
        navigate={navigate}
        inboxCount={inboxCount}
        tasks={tasks.state.data?.tasks}
        row={row}
      />
      {row ? (
        <AccountRows
          path={path}
          navigate={navigate}
          pending={logoutPending}
          onSignOut={() => void logout()}
          {...gettingStartedMenu}
        />
      ) : (
        <div className="account-footer">
          <CapacityMeter tasks={tasks.state.data?.tasks} />
          <AccountMenu
            key={navigationVersion}
            path={path}
            navigate={navigate}
            pending={logoutPending}
            onSignOut={() => void logout()}
            {...gettingStartedMenu}
          />
        </div>
      )}
    </>
  );
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="workspace-header">
          <span className="workspace-mark" aria-hidden="true" />
          <div>
            <p className="body">Ensemble</p>
            <p className="metadata muted">Personal workspace</p>
          </div>
        </div>
        <SearchWorkField navigate={navigate} />
        {navigation(false)}
      </aside>
      <div className="workspace">
        <TopBar
          // Not found marks no current page.
          trail={
            unknownRoute
              ? []
              : settingsPage?.trail.length
                ? settingsPage.trail
                : [
                    // The page header's Back links the parent; the crumb only names it.
                    ...(parent ? [{ label: parent.label }] : []),
                    { label: taskReport?.title ?? title },
                  ]
          }
          connection={connectionOf(workspace.state)}
          action={
            unknownRoute ? undefined : (
              <ActionLink variant="primary" href={newTaskHref}>
                New task
              </ActionLink>
            )
          }
        />
        <main className={onInboxRoute ? "page page-inbox" : "page"}>
          {!inboxOwnsHeader && (
            <PageHeader
              title={title}
              subtitle={headerSubtitle}
              plain={unknownRoute || Boolean(settingsPage)}
              {...(settingsPage ? { shortTitle: settingsPage.shortTitle } : {})}
              badge={
                onInboxRoute && inboxCount !== null
                  ? `${inboxCount} unresolved`
                  : undefined
              }
              {...(parent
                ? { back: parent }
                : {
                    menu: (
                      <MobileNavigation open={drawer} onOpenChange={setDrawer}>
                        {navigation(true)}
                      </MobileNavigation>
                    ),
                  })}
              action={
                taskRoute ? (
                  // The top bar carries New task on desktop; this one serves the drawer shell.
                  <ActionLink
                    variant="primary"
                    href={newTaskHref}
                    className="page-header-new-task"
                  >
                    New task
                  </ActionLink>
                ) : ownsRefresh ? undefined : (
                  <Button
                    variant="secondary"
                    onClick={() => {
                      refreshAll();
                      if (pathname === "/app/inbox") tasks.refresh();
                    }}
                    disabled={workspace.state.pending}
                  >
                    Refresh
                  </Button>
                )
              }
              {...inboxHeaderProps}
              {...taskHeaderProps}
            />
          )}
          {stillSignedIn && (
            <ActionOutcome
              tone="warning"
              message="We couldn't sign you out. You're still signed in."
            />
          )}
          {workspace.state.data?.data.harnesses
            .filter((h) => h.state === "unavailable")
            .map((h) => (
              <Alert key={h.harness} variant="destructive" role="alert">
                {unavailableAlert(h)}
              </Alert>
            ))}
          {workspace.state.status !== "fresh" && (
            <ResourceStatus state={workspace.state} retry={workspace.refresh} />
          )}
          {unknownRoute ? (
            <NotFound />
          ) : pathname === "/app/settings/runtime" ? (
            <RuntimeSettings
              client={client}
              session={session}
              drafts={drafts.current}
              workspace={workspace.state.data}
              refresh={workspace.refresh}
              refreshNonce={refreshNonce}
            />
          ) : /^\/app\/assignments\/[^/]+\/recovery$/.test(pathname) ? (
            <AssignmentRecovery
              client={client}
              session={session}
              drafts={drafts.current}
              workspace={workspace.state.data}
              refresh={workspace.refresh}
              refreshNonce={refreshNonce}
              assignmentId={pathname.split("/")[3] ?? ""}
            />
          ) : pathname === "/app/settings" ? (
            <SettingsWorkspace
              client={client}
              session={session}
              drafts={drafts.current}
              workspace={workspace.state.data}
              refresh={workspace.refresh}
              refreshNonce={refreshNonce}
            />
          ) : pathname === "/app/settings/projects/new" ? (
            <ProjectSetup
              // Choosing New project again remounts, so a recorded create starts clean.
              key={navigationVersion}
              client={client}
              session={session}
              drafts={drafts.current}
              workspace={workspace.state.data}
              refresh={workspace.refresh}
              navigate={navigate}
            />
          ) : pathname === "/app/settings/profiles/new" ? (
            <ProfileCreate
              client={client}
              session={session}
              drafts={drafts.current}
              workspace={workspace.state.data}
              refresh={workspace.refresh}
            />
          ) : /^\/app\/profiles\/[^/]+\/settings$/.test(pathname) ? (
            <ProfileConfiguration
              key={pathname}
              client={client}
              session={session}
              drafts={drafts.current}
              workspace={workspace.state.data}
              refresh={workspace.refresh}
              refreshNonce={refreshNonce}
              profileId={pathname.split("/")[3] ?? ""}
            />
          ) : /^\/app\/projects\/[^/]+\/settings$/.test(pathname) ? (
            <ProjectConfiguration
              key={pathname}
              client={client}
              session={session}
              drafts={drafts.current}
              workspace={workspace.state.data}
              refresh={workspace.refresh}
              refreshNonce={refreshNonce}
              projectId={pathname.split("/")[3] ?? ""}
              query={query}
            />
          ) : pathname === "/app/tasks/new" ? (
            <TaskComposer
              key={session.csrfToken}
              client={client}
              session={session}
              workspace={workspace.state.data}
              initialProject={
                new URLSearchParams(path.split("?")[1] ?? "").get("project") ??
                ""
              }
              onRecorded={tasks.refresh}
              drafts={drafts.current}
              refresh={workspace.refresh}
            />
          ) : pathname === "/app/inbox" ? (
            <Inbox
              client={client}
              session={session}
              path={path}
              navigate={navigate}
              state={inboxState.current}
              questions={questionStates.current}
              observation={workspace.state.data}
              onSummary={setInboxRouteSummary}
              onHeader={setInboxHeader}
              chrome={
                inboxOwnsHeader
                  ? {
                      onRefresh: () => {
                        refreshAll();
                        tasks.refresh();
                      },
                      refreshing: workspace.state.pending,
                    }
                  : undefined
              }
            />
          ) : pathname === "/app/search" ? (
            <Search
              key={`${session.csrfToken}:${entryKey}`}
              client={client}
              session={session}
              workspace={workspace.state.data}
              path={path}
              navigate={navigate}
              onRefresh={refreshAll}
              state={activeSearch}
            />
          ) : /^\/app\/tasks\/[^/]+$/.test(pathname) ? (
            <TaskWorkspace
              key={`${session.csrfToken}:${entryKey}`}
              client={client}
              session={session}
              drafts={drafts.current}
              taskId={pathname.split("/")[3] ?? ""}
              path={path}
              onRefresh={refreshAll}
              workspace={workspace.state.data}
              onHeader={setTaskHeader}
              questionStates={questionStates.current}
              state={taskStates.current.forTask(
                pathname.split("/")[3] ?? "",
                entryKey,
              )}
            />
          ) : pathname === "/app/getting-started" ? (
            <GettingStarted mode="page" {...waitProps} />
          ) : (
            <>
              {pathname === "/app" && (
                <GettingStarted mode="home" {...waitProps} />
              )}
              <TaskViews
                state={tasks.state}
                requests={inboxSummary.state}
                refresh={() => {
                  tasks.refresh();
                  refreshAll();
                }}
                workspace={workspace.state.data}
                path={path}
                navigate={navigate}
                {...(projectId
                  ? {
                      projectId,
                      resume: {
                        ...waitProps,
                        onChanged: () => {
                          tasks.refresh();
                          refreshAll();
                        },
                      },
                    }
                  : {})}
                overview={pathname === "/app"}
                operator={
                  pathname === "/app"
                    ? { client, session, questions: questionStates.current }
                    : undefined
                }
              />
            </>
          )}
        </main>
      </div>
    </div>
  );
}
