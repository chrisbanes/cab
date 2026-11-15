import { useEffect, useRef } from "react";
import { readinessCheckIds } from "../../src/operator/readiness.js";
import type { ResourceState } from "./resource.js";

/**
 * The Settings sections in the designed order. `id` is the stable internal name (it was
 * the index fragment); `slug` is the section's route, `/settings/<slug>`.
 */
export const SETTINGS_SECTIONS = [
  { id: "projects", slug: "projects", label: "Projects" },
  { id: "runtime", slug: "runtime", label: "Runtime & recovery" },
  { id: "profiles", slug: "agents", label: "Agents" },
  { id: "routing", slug: "routing", label: "Routing" },
  {
    id: "github-discovery",
    slug: "github-discovery",
    label: "GitHub discovery",
  },
  {
    id: "gitlab-credentials",
    slug: "gitlab-credentials",
    label: "GitLab credentials",
  },
  { id: "cli-credentials", slug: "cli-credentials", label: "CLI credentials" },
  { id: "notifications", slug: "notifications", label: "Notifications" },
  { id: "readiness", slug: "readiness", label: "Readiness" },
] as const;

export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]["id"];

export const settingsSection = (id: SettingsSectionId) =>
  SETTINGS_SECTIONS.find((s) => s.id === id) ?? SETTINGS_SECTIONS[0];

export const settingsSectionHref = (id: SettingsSectionId) =>
  `/settings/${settingsSection(id).slug}`;

/** The section a path is the page of, or null. */
export const sectionForPath = (pathname: string): SettingsSectionId | null =>
  SETTINGS_SECTIONS.find((s) => pathname === `/settings/${s.slug}`)?.id ?? null;

/** Whether a path is Settings or one of its pages, for the account menu's Settings link. */
export const isSettingsRoute = (pathname: string) =>
  pathname === "/settings" ||
  sectionForPath(pathname) !== null ||
  /^\/settings\/(?:projects|profiles)\/new$/.test(pathname) ||
  /^\/(?:projects|profiles)\/[^/]+\/settings$/.test(pathname) ||
  /^\/assignments\/[^/]+\/recovery$/.test(pathname);

/** Where `/settings` lands: Readiness until a task starts a turn, otherwise Projects. */
export const settingsLanding = (
  turnStarted: boolean | undefined,
): SettingsSectionId => (turnStarted === false ? "readiness" : "projects");

/** Add Claude, the panel at the top of the Runtime page. */
export const addClaudeHref = "/settings/runtime#add-claude";

/** A Readiness check's own article, by its public check id. */
export const readinessCheckHref = (checkId: string) =>
  `/settings/readiness#readiness-${checkId}`;

/** A fragment as an element id, or null when it is empty or not decodable. */
function fragmentId(hash: string) {
  try {
    return decodeURIComponent(hash.slice(1)) || null;
  } catch {
    return null;
  }
}

const knownCheck = (id: string | null): id is string =>
  id?.startsWith("readiness-") === true &&
  readinessCheckIds.some((c) => `readiness-${c}` === id);

/**
 * The canonical URL for a `/settings#…` address made before Settings had section pages,
 * or null when nothing needs rewriting. A section fragment opens its page, a check's
 * fragment opens Readiness at that check, and any other fragment is dropped so the root
 * landing applies. The query is kept.
 */
export function legacySettingsUrl(
  pathname: string,
  search: string,
  hash: string,
): string | null {
  if (pathname !== "/settings" || hash.length <= 1) return null;
  const id = fragmentId(hash);
  const known = SETTINGS_SECTIONS.find((s) => s.id === id);
  if (known) return `${settingsSectionHref(known.id)}${search}`;
  if (knownCheck(id)) return `/settings/readiness${search}#${id}`;
  return `/settings${search}`;
}

/**
 * The element id a Settings page lands on for this address, or null. Only a known check
 * on Readiness and Add Claude on Runtime are targets.
 */
export function landingTargetId(pathname: string, hash: string) {
  const id = fragmentId(hash);
  if (pathname === "/settings/readiness" && knownCheck(id)) return id;
  if (pathname === "/settings/runtime" && id === "add-claude") return id;
  return null;
}

/** The landing last settled, so a page lands at most once per history entry and URL. */
let settledIdentity: string | null = null;
const landingIdentity = () =>
  `${(history.state as { navKey?: string } | null)?.navKey ?? ""}|${location.pathname}${location.hash}`;

/** Reader input that keeps their position: landing after it would move them. */
const readerInput = ["wheel", "touchstart", "pointerdown", "keydown"] as const;

/**
 * Focus and scroll to the address's target once the page's own read is fresh. It lands
 * at most once per landing identity, and not at all when the entry has a saved position
 * (Back/Forward restores it), the reader has acted or moved focus since the entry began,
 * or the fresh read has no such target (the page heading stays). A failed or stale read
 * keeps the landing pending, so a successful Retry can still complete it.
 */
export function useTargetLanding(state: ResourceState<unknown>) {
  const identity = landingIdentity();
  const interacted = useRef({ identity, yes: false });
  if (interacted.current.identity !== identity)
    interacted.current = { identity, yes: false };
  useEffect(() => {
    const mark = () => {
      interacted.current.yes = true;
    };
    for (const e of readerInput)
      addEventListener(e, mark, { passive: true, capture: true });
    return () => {
      for (const e of readerInput)
        removeEventListener(e, mark, { capture: true });
      // Leaving the page forgets its landing, so a later visit lands again.
      settledIdentity = null;
    };
  }, []);
  const fresh = state.status === "fresh";
  useEffect(() => {
    if (!fresh || settledIdentity === identity) return;
    settledIdentity = identity;
    const restoring =
      typeof (history.state as { scrollY?: unknown } | null)?.scrollY ===
      "number";
    const id = landingTargetId(location.pathname, location.hash);
    if (restoring || !id || interacted.current.yes) return;
    // Focus the shell put on the page heading is not the reader's.
    const active = document.activeElement;
    if (active && active !== document.body && !active.matches("main h1"))
      return;
    // After the shell's own scroll for this entry, which runs in the next frame.
    requestAnimationFrame(() => {
      const target = document.getElementById(id);
      if (!target || interacted.current.yes) return;
      target.scrollIntoView();
      const heading = target.querySelector<HTMLElement>("h2,h3");
      if (heading) {
        heading.tabIndex = -1;
        heading.focus({ preventScroll: true });
      }
    });
  }, [fresh, identity]);
}
