import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import tailwindcss from "@tailwindcss/vite";

const source = (path: string) => fileURLToPath(new URL(path, import.meta.url));

/**
 * Keeps the diff highlighter to the grammars and themes it uses. The operator service reads
 * every built asset at startup, and Shiki's catalogues add a chunk per grammar and theme.
 */
const trimHighlighter: Plugin = {
  name: "cab-trim-highlighter",
  enforce: "pre",
  resolveId(id, importer) {
    if (id === "shiki/langs") return source("src/shiki-langs.ts");
    if (id === "@pierre/highlights/themes/loader")
      return source("src/highlighter-themes.ts");
    if (
      id === "./collections/shiki.js" &&
      importer?.replaceAll("\\", "/").includes("/@pierre/theming/dist/")
    )
      return source("src/highlighter-themes.ts");
    return null;
  },
};
export default defineConfig({
  plugins: [trimHighlighter, tailwindcss()],
  root: fileURLToPath(new URL(".", import.meta.url)),
  base: "/",
  // The favicon and push worker are copied verbatim; the worker is served under /.
  publicDir: "public",
  build: {
    outDir: "../dist/operator",
    emptyOutDir: true,
    sourcemap: false,
    target: "es2023",
    assetsDir: "assets",
    // ponytail: the operator UI is served locally; code-split routes if the main chunk passes 1 MB.
    chunkSizeWarningLimit: 1000,
    rolldownOptions: {
      // React Server Component "use client" directives are irrelevant to this client-only bundle.
      checks: { moduleLevelDirective: false },
    },
  },
});
