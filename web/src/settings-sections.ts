import { useEffect, useRef } from "react";

/** The Settings index sections, in the designed order (frame 114), with their stable fragments. */
export const SETTINGS_SECTIONS = [
  { id: "projects", label: "Projects" },
  { id: "runtime", label: "Runtime & recovery" },
  { id: "profiles", label: "Profiles" },
  { id: "routing", label: "Routing" },
  { id: "github-discovery", label: "GitHub discovery" },
  { id: "cli-credentials", label: "CLI credentials" },
  { id: "readiness", label: "Readiness" },
] as const;

export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]["id"];

/**
 * Section order for the page and its navigation. Until a task starts a turn Readiness
 * comes first (frame 114c); an unknown start state keeps the designed order.
 */
export function settingsSectionOrder(
  turnStarted: boolean | undefined,
): SettingsSectionId[] {
  const ids = SETTINGS_SECTIONS.map((s) => s.id);
  return turnStarted === false
    ? ["readiness", ...ids.filter((id) => id !== "readiness")]
    : ids;
}

export const settingsSectionHref = (id: SettingsSectionId) =>
  `/app/settings#${id}`;

/** A Readiness check's own article, by its public check id. */
export const readinessCheckHref = (checkId: string) =>
  `/app/settings#readiness-${checkId}`;

/** The fragment as an element id, or null when it is absent or not decodable. */
function fragmentId() {
  try {
    return decodeURIComponent(location.hash.slice(1)) || null;
  } catch {
    return null;
  }
}

/** The section the fragment names, or null (an unknown fragment names none). */
export function fragmentSection(): SettingsSectionId | null {
  const id = fragmentId();
  return SETTINGS_SECTIONS.find((s) => s.id === id)?.id ?? null;
}

/** How long a landing re-asserts itself while the page above it settles. */
const SETTLE_MS = 3000;

/**
 * Scroll `target` into view and focus its heading. Reads above it can still be growing
 * (Safari has no scroll anchoring), so a layout change re-scrolls until the first user
 * input, a focus move elsewhere, or `SETTLE_MS`.
 */
function land(target: HTMLElement) {
  target.scrollIntoView();
  const heading = target.querySelector<HTMLElement>("h2,h3");
  if (heading) {
    heading.tabIndex = -1;
    heading.focus({ preventScroll: true });
  }
  const settle = new ResizeObserver(() => {
    const active = document.activeElement;
    if (target.isConnected && (active === document.body || active === heading))
      target.scrollIntoView();
  });
  settle.observe(document.body);
  const events = ["wheel", "touchstart", "pointerdown", "keydown", "pagehide"];
  const stop = () => {
    clearTimeout(timer);
    settle.disconnect();
    for (const e of events) removeEventListener(e, stop);
  };
  const timer = setTimeout(stop, SETTLE_MS);
  for (const e of events) addEventListener(e, stop, { passive: true });
  return stop;
}

/**
 * Land on the element the URL fragment names, once per history entry and only when that
 * entry has no saved scroll position (a Back or Forward restore keeps the app's own scroll
 * and focus restore). `ready` holds the landing until the page can no longer reorder or
 * grow its target; `accepts` limits which ids this page lands on, so any other fragment
 * does nothing.
 */
export function useFragmentLanding(
  ready: boolean,
  accepts: (id: string) => boolean,
) {
  const state = history.state as { navKey?: string; scrollY?: number } | null;
  const entry = state?.navKey ?? "";
  const landed = useRef<string | null>(null);
  const acceptsNow = useRef(accepts);
  acceptsNow.current = accepts;
  useEffect(() => {
    const id = fragmentId();
    if (!ready || landed.current === entry || !id || !acceptsNow.current(id))
      return;
    const target = document.getElementById(id);
    if (!target) return;
    landed.current = entry;
    if (typeof state?.scrollY === "number") return;
    return land(target);
  }, [entry, ready]);
}
