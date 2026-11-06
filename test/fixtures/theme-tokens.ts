import { readFileSync } from "node:fs";

/** The `:root` (light) and `.dark` custom-property declarations of `web/src/tokens.css`. */
export function themeBlocks(
  css = readFileSync(
    new URL("../../../web/src/tokens.css", import.meta.url),
    "utf8",
  ),
) {
  const block = (selector: string) => {
    const match = new RegExp(`(?:^|\\n)${selector} \\{([^}]*)\\}`).exec(css);
    if (!match?.[1]) throw new Error(`missing ${selector} block`);
    return new Map(
      [...match[1].matchAll(/(--[\w-]+):\s*([^;]+);/g)].map(
        ([, name, value]) => [name as string, (value as string).trim()],
      ),
    );
  };
  return { light: block(":root"), dark: block("\\.dark") };
}
