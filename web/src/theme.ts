import { useSyncExternalStore } from "react";

export type ThemeChoice = "system" | "light" | "dark";
export const THEME_CHOICES: readonly ThemeChoice[] = [
  "system",
  "light",
  "dark",
];
export const THEME_KEY = "cab.theme.v1";
const DARK_QUERY = "(prefers-color-scheme: dark)";

/** Anything but an explicit light or dark reads as System. */
export function parseThemeChoice(value: unknown): ThemeChoice {
  return value === "light" || value === "dark" ? value : "system";
}
export function resolveTheme(
  choice: ThemeChoice,
  systemPrefersDark: boolean,
): "light" | "dark" {
  return choice === "system" ? (systemPrefersDark ? "dark" : "light") : choice;
}

/** The remembered choice; blocked or unavailable storage reads as System. */
export function rememberedTheme(): ThemeChoice {
  try {
    return parseThemeChoice(localStorage.getItem(THEME_KEY));
  } catch {
    return "system";
  }
}
/** Only an explicit Light or Dark is stored; System removes the key. */
export function rememberTheme(choice: ThemeChoice) {
  try {
    if (choice === "system") localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, choice);
  } catch {}
}

let current: ThemeChoice = "system";
const listeners = new Set<() => void>();

function apply() {
  const dark = resolveTheme(current, matchMedia(DARK_QUERY).matches) === "dark";
  document.documentElement.classList.toggle("dark", dark);
}

/** Apply the remembered choice and follow OS changes while System is chosen. Call before the first render. */
export function initTheme() {
  current = rememberedTheme();
  apply();
  matchMedia(DARK_QUERY).addEventListener("change", () => {
    if (current === "system") apply();
  });
}
export function setTheme(choice: ThemeChoice) {
  current = choice;
  rememberTheme(choice);
  apply();
  for (const listener of listeners) listener();
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
export function useTheme(): ThemeChoice {
  return useSyncExternalStore(subscribe, () => current);
}
