import { useSyncExternalStore } from "react";

export const FOCUS_MODE_KEY = "cab.focus-mode.v1";

/** The remembered choice; blocked or unavailable storage reads as off. */
export function rememberedFocusMode() {
  try {
    return localStorage.getItem(FOCUS_MODE_KEY) === "1";
  } catch {
    return false;
  }
}
/** Only "on" is stored; off removes the key. */
export function rememberFocusMode(on: boolean) {
  try {
    if (on) localStorage.setItem(FOCUS_MODE_KEY, "1");
    else localStorage.removeItem(FOCUS_MODE_KEY);
  } catch {}
}

let current: boolean | undefined;
const listeners = new Set<() => void>();
/** Update the in-memory value (kept even when storage is blocked), remember it and notify. */
export function setFocusMode(on: boolean) {
  current = on;
  rememberFocusMode(on);
  for (const listener of listeners) listener();
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
export function useFocusMode(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => (current ??= rememberedFocusMode()),
  );
}

type ShortcutEvent = {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  repeat: boolean;
  isComposing: boolean;
  defaultPrevented: boolean;
};
type ShortcutTarget = {
  tagName: string;
  isContentEditable: boolean;
  closest(selector: string): unknown;
};
const IGNORED_ANCESTORS = [
  "textbox",
  "combobox",
  "searchbox",
  "spinbutton",
  "dialog",
  "alertdialog",
]
  .map((role) => `[role="${role}"]`)
  .join(",");

/** Whether a key press toggles focus mode: a bare `\` outside fields and dialogs. */
export function focusShortcutApplies(
  event: ShortcutEvent,
  target: ShortcutTarget | null,
) {
  // shortcut: Ctrl/Alt are ignored, so layouts that type `\` through AltGr use the button.
  if (event.key !== "\\" || event.ctrlKey || event.metaKey || event.altKey)
    return false;
  if (event.repeat || event.isComposing || event.defaultPrevented) return false;
  if (!target) return true;
  if (["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return false;
  return !target.isContentEditable && !target.closest(IGNORED_ANCESTORS);
}
