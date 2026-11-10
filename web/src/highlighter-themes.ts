import { createThemeCollection } from "@pierre/theming";

/**
 * Stands in for two theme catalogues the diff never uses (see `web/vite.config.ts`): the 65
 * Shiki themes in `@pierre/theming/themes` (the diff uses Pierre's own light and dark themes)
 * and the Highlights backend's catalogue (the diff uses the Shiki backend). Each would add a
 * chunk per theme, and the operator service reads every built asset at startup.
 */
export const shikiThemes = createThemeCollection({ themes: [] });
export const themes = {};
