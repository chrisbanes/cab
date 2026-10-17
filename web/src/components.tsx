import {
  forwardRef,
  useRef,
  type AnchorHTMLAttributes,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type MouseEvent,
  type ReactNode,
} from "react";
import type { ResourceState } from "./resource.js";
import * as Dialog from "@radix-ui/react-dialog";
import {
  ChevronLeft,
  ChevronRight,
  Circle,
  CircleAlert,
  CircleCheck,
  CircleX,
  Menu,
  type LucideIcon,
} from "lucide-react";
import type { ProjectLabel } from "../../src/operator/project-labels.js";
import { cn } from "./lib/utils.js";
import { shortId } from "./presentation.js";
import { Alert, AlertDescription } from "./ui/alert.js";
import { Badge } from "./ui/badge.js";
import { Button as PrimitiveButton } from "./ui/button.js";
import { Input } from "./ui/input.js";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "./ui/sheet.js";

/** An unmodified primary click; other clicks keep the browser's own link behaviour. */
export const isPlainClick = (event: MouseEvent) =>
  event.button === 0 &&
  !event.ctrlKey &&
  !event.metaKey &&
  !event.shiftKey &&
  !event.altKey;

export const Button = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: "primary" | "secondary" | "destructive";
  }
>(function Button({ children, variant = "primary", className, ...props }, ref) {
  return (
    <PrimitiveButton
      ref={ref}
      variant={
        variant === "primary"
          ? "default"
          : variant === "destructive"
            ? "destructive"
            : "outline"
      }
      className={cn("control", className)}
      {...props}
    >
      {children}
    </PrimitiveButton>
  );
});

export function ActionLink({
  children,
  variant = "primary",
  className,
  ...props
}: AnchorHTMLAttributes<HTMLAnchorElement> & {
  children: ReactNode;
  variant?: "primary" | "secondary";
}) {
  return (
    <PrimitiveButton
      asChild
      variant={variant === "primary" ? "default" : "outline"}
      className={cn("control", className)}
    >
      <a {...props}>{children}</a>
    </PrimitiveButton>
  );
}

export const TextField = forwardRef<
  HTMLInputElement,
  InputHTMLAttributes<HTMLInputElement> & { label: string; id: string }
>(function TextField({ label, id, className, ...props }, ref) {
  return (
    <label className="field body" htmlFor={id}>
      {label}
      <Input ref={ref} {...props} id={id} className={className} />
    </label>
  );
});

/**
 * Colour never carries state alone: every state tone adds a symbol beside the
 * word. `neutral` is for counts and labels that are not states.
 */
const badgeTones = {
  neutral: { variant: "secondary", Icon: null },
  idle: { variant: "secondary", Icon: Circle },
  warning: { variant: "attention", Icon: CircleAlert },
  error: { variant: "destructive", Icon: CircleX },
  success: { variant: "success", Icon: CircleCheck },
} as const;
/**
 * An identifier as short mono metadata, never inside a sentence. The full value is the title (and
 * the abbreviation's expansion for assistive technology); `focusable` is off inside a link.
 */
export function ShortId({
  value,
  focusable = true,
  length,
}: {
  value: string;
  focusable?: boolean;
  /** Characters shown; the default suits a single identifier. */
  length?: number;
}) {
  return (
    <abbr
      className="identifier"
      title={value}
      tabIndex={focusable ? 0 : undefined}
    >
      {shortId(value, length)}
    </abbr>
  );
}
/**
 * A project's name, then the suffix that tells it from same-named projects: the lead's name or
 * the ID in mono. Text order is DOM order, so the link's accessible name reads "Atlas · Mira".
 */
export function ProjectName({
  label,
  id,
}: {
  label: ProjectLabel;
  id: string;
}) {
  return (
    <>
      {label.name ?? "Name unavailable"}
      {label.suffix && (
        <span className="muted">
          {" · "}
          {label.suffix.kind === "id" ? (
            <ShortId
              value={id}
              focusable={false}
              length={label.suffix.text.length}
            />
          ) : (
            label.suffix.text
          )}
        </span>
      )}
    </>
  );
}
export function StatusBadge({
  children,
  tone = "neutral",
  icon,
  className,
}: {
  children: ReactNode;
  tone?: keyof typeof badgeTones;
  /** Replaces the tone's default symbol. */
  icon?: LucideIcon | undefined;
  className?: string;
}) {
  const { variant, Icon: toneIcon } = badgeTones[tone];
  const Icon = icon ?? toneIcon;
  return (
    <Badge variant={variant} className={cn("metadata", className)}>
      {Icon && <Icon aria-hidden="true" />}
      {children}
    </Badge>
  );
}

export function ResourceStatus<T>({
  state,
  retry,
  label = "Projects",
}: {
  state: ResourceState<T>;
  retry: () => void;
  label?: string;
}) {
  if (state.status === "fresh") return null;
  const message =
    state.error === "not-found"
      ? `${label} not found.`
      : state.status === "loading"
        ? `Loading ${label.toLowerCase()}…`
        : state.status === "stale"
          ? state.error
            ? "Refresh failed. Showing the last fetched data."
            : "Refreshing. Showing the last fetched data."
          : state.status === "error"
            ? `${label} are unavailable. Try again.`
            : "No data loaded.";
  return (
    <Alert
      className={cn("resource-status", state.error && "resource-status-error")}
      variant={state.error ? "destructive" : "default"}
      role={state.error ? "alert" : "status"}
    >
      <AlertDescription>
        <p className="body">{message}</p>
        {state.fetchedAt && (
          <p className="metadata">
            Last fetched {new Date(state.fetchedAt).toLocaleTimeString()}
          </p>
        )}
        {state.error && (
          <Button variant="secondary" onClick={retry}>
            Try again
          </Button>
        )}
      </AlertDescription>
    </Alert>
  );
}

export function MobileNavigation({
  children,
  open,
  onOpenChange,
}: {
  children: ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetTrigger asChild>
        <PrimitiveButton
          ref={trigger}
          variant="ghost"
          size="icon"
          className="control"
        >
          <Menu aria-hidden="true" />
          <span className="sr-only">Projects and navigation</span>
        </PrimitiveButton>
      </SheetTrigger>
      <SheetContent
        className="drawer"
        onCloseAutoFocus={(event) => {
          if (trigger.current) {
            event.preventDefault();
            trigger.current.focus();
          }
        }}
      >
        <SheetHeader>
          <SheetTitle className="section-heading">
            Projects and navigation
          </SheetTitle>
          <SheetDescription className="body muted">
            Choose a project or operator destination.
          </SheetDescription>
        </SheetHeader>
        <SheetClose asChild>
          <Button variant="secondary">Close navigation</Button>
        </SheetClose>
        <Dialog.Close asChild>
          <div className="drawer-body">{children}</div>
        </Dialog.Close>
      </SheetContent>
    </Sheet>
  );
}

/** Content of a link that only opens another view: title, optional summary and a chevron. */
export function NavigationRow({
  icon,
  title,
  summary,
  trailing,
}: {
  icon?: ReactNode;
  title: ReactNode;
  summary?: ReactNode;
  trailing?: ReactNode;
}) {
  return (
    <>
      {icon}
      <span className="nav-label">
        <span>{title}</span>
        {summary && <span className="metadata muted">{summary}</span>}
      </span>
      {trailing}
      <ChevronRight aria-hidden="true" className="nav-chevron" />
    </>
  );
}

/**
 * The one title (h1) of a route. Desktop shows title, optional subtitle and one action.
 * At phone widths a top-level route adds the menu button and a count; a nested route
 * adds a Back link to its static parent instead.
 */
export function PageHeader({
  title,
  subtitle,
  action,
  badge,
  menu,
  back,
  desktopBack,
  plain,
  shortTitle,
  shortSubtitle,
  compactPhone,
}: {
  title: string;
  subtitle?: string | undefined;
  action?: ReactNode;
  badge?: string | undefined;
  menu?: ReactNode;
  /** `history` returns to the in-session origin entry instead of opening `href`. */
  back?: { href: string; label: string; ariaLabel?: string; history?: boolean };
  /** Keep the Back link visible on desktop too (the task header draws it there). */
  desktopBack?: boolean;
  /** Omit the desktop divider under the header (the Not found frame has none). */
  plain?: boolean;
  /** Phone title, rendered in the same h1 and shown below 760px instead of `title`. */
  shortTitle?: string | undefined;
  /** Phone subtitle, a separate line the detail header shows in place of `subtitle` below 760px. */
  shortSubtitle?: string | undefined;
  /** Phone only: Back and a centred title, with no subtitle (a create form's Back names its parent). */
  compactPhone?: boolean | undefined;
}) {
  return (
    <header
      className="page-header"
      data-variant={back ? "detail" : "top-level"}
      data-plain={plain || undefined}
      data-desktop-back={desktopBack || undefined}
      data-compact-phone={compactPhone || undefined}
    >
      {menu && <div className="phone-nav">{menu}</div>}
      {back && (
        <PrimitiveButton
          asChild
          variant="ghost"
          className="control page-header-back"
        >
          <a
            href={back.href}
            aria-label={back.ariaLabel ?? `Back to ${back.label}`}
            onClick={
              back.history
                ? (event) => {
                    if (!isPlainClick(event)) return;
                    // Return to the origin entry rather than letting the shell push a new one.
                    event.preventDefault();
                    history.back();
                  }
                : undefined
            }
          >
            <ChevronLeft aria-hidden="true" />
            <span>{back.label}</span>
          </a>
        </PrimitiveButton>
      )}
      <div className="page-header-title">
        <h1 className="page-heading">
          {shortTitle ? (
            <>
              <span className="page-title-full">{title}</span>
              <span className="page-title-short">{shortTitle}</span>
            </>
          ) : (
            title
          )}
        </h1>
        {subtitle && <p className="introduction muted">{subtitle}</p>}
        {shortSubtitle && (
          <p className="page-subtitle-short">{shortSubtitle}</p>
        )}
      </div>
      {badge && (
        <StatusBadge className="page-header-count">{badge}</StatusBadge>
      )}
      {action}
    </header>
  );
}

/** Desktop top bar: breadcrumb (the last item is the current page), connection status and New task. */
export function TopBar({
  trail,
  connection,
  action,
}: {
  trail: { label: string; href?: string }[];
  connection: {
    tone: "success" | "warning" | "error";
    label: "Connected" | "Updates delayed" | "Disconnected";
  } | null;
  action?: ReactNode;
}) {
  return (
    <header className="top-bar">
      {trail.length > 0 ? (
        <nav aria-label="Breadcrumb" className="top-bar-trail metadata">
          <ol>
            {trail.map((c, i) => (
              <li key={c.href ?? c.label}>
                {c.href && i < trail.length - 1 ? (
                  <a href={c.href}>{c.label}</a>
                ) : (
                  <span
                    aria-current={i === trail.length - 1 ? "page" : undefined}
                  >
                    {c.label}
                  </span>
                )}
              </li>
            ))}
          </ol>
        </nav>
      ) : (
        <span className="top-bar-trail" />
      )}
      {connection && (
        <StatusBadge tone={connection.tone} className="top-bar-connection">
          {connection.label}
        </StatusBadge>
      )}
      {action}
    </header>
  );
}
