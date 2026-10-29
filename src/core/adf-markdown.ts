import { z } from "zod";
import { issueBodyLimit } from "./issue-text-limits.js";

const unreadable = "[Jira description could not be read]";
const maxDepth = 32;
const attributes = z.record(z.string(), z.unknown()).optional();
const doc = z.object({ type: z.literal("doc"), content: z.array(z.unknown()) });
const node = z.object({
  type: z.string(),
  text: z.string().optional(),
  attrs: attributes,
  marks: z.array(z.object({ type: z.string(), attrs: attributes })).optional(),
  content: z.array(z.unknown()).optional(),
});
type Node = z.infer<typeof node>;

const parse = (raw: unknown): Node | undefined => {
  const result = node.safeParse(raw);
  return result.success ? result.data : undefined;
};
// The type string is hostile input: keep it to a short, inert token.
const placeholder = (type = "unknown") =>
  `[Jira ${type.replace(/[^\w.-]/g, "?").slice(0, 40)} not shown]`;
const escapeText = (text: string) => text.replace(/[\\`*_[\]<>#~]/g, "\\$&");
const oneLine = (text: string) => text.replace(/\s*\n\s*/g, " ");
// A paragraph line that starts with a list marker would become a list.
const escapeLeadingMarker = (text: string) =>
  text
    .replace(/^(\d+)([.)])(?=\s|$)/gm, "$1\\$2")
    .replace(/^([-+])(?=\s|-|$)/gm, "\\$1");
const ticks = (text: string, minimum: number) =>
  "`".repeat(
    Math.max(
      minimum,
      (text.match(/`+/g) ?? []).reduce((m, s) => Math.max(m, s.length), 0) + 1,
    ),
  );

/** Only http(s) links are rendered; the returned form is safe inside Markdown link syntax. */
const safeUrl = (value: unknown): string | undefined => {
  try {
    if (typeof value !== "string") return undefined;
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:"
      ? url.href.replace(/[()<>]/g, (c) => `%${c.charCodeAt(0).toString(16)}`)
      : undefined;
  } catch {
    return undefined;
  }
};

const wrappers: Record<string, string> = {
  strong: "**",
  em: "_",
  strike: "~~",
};

const text = (n: Node) => {
  const raw = n.text ?? "";
  const code = n.marks?.some((m) => m.type === "code");
  let result = code
    ? `${ticks(raw, 1)}${/^`|`$/.test(raw) ? ` ${raw} ` : raw}${ticks(raw, 1)}`
    : escapeText(raw);
  for (const mark of n.marks ?? []) {
    const wrapper = wrappers[mark.type];
    if (wrapper) {
      // Emphasis delimiters must hug the text, so keep edge whitespace outside them.
      const [, before = "", body = "", after = ""] =
        /^(\s*)([\s\S]*?)(\s*)$/.exec(result) ?? [];
      if (body) result = `${before}${wrapper}${body}${wrapper}${after}`;
    } else if (mark.type === "link") {
      const url = safeUrl(mark.attrs?.href);
      if (url) result = `[${result}](${url})`;
    }
  }
  return result;
};

const card = (n: Node) => {
  const url = safeUrl(n.attrs?.url);
  return url ? `<${url}>` : placeholder(n.type);
};

const inline = (nodes: unknown[] = []): string =>
  nodes
    .map((raw) => {
      const n = parse(raw);
      if (!n) return placeholder();
      switch (n.type) {
        case "text":
          return text(n);
        case "hardBreak":
          return "  \n";
        case "emoji": {
          const { text: glyph, shortName } = n.attrs ?? {};
          const value = typeof glyph === "string" ? glyph : shortName;
          return typeof value === "string" ? escapeText(value) : "";
        }
        case "inlineCard":
          return card(n);
        default:
          return placeholder(n.type);
      }
    })
    .join("");

const isList = (n: Node) => n.type === "bulletList" || n.type === "orderedList";

const render = (
  nodes: unknown[] = [],
  depth: number,
  tight = false,
): string => {
  let out = "";
  for (const raw of nodes) {
    const n = parse(raw);
    const s = block(raw, depth);
    if (s)
      out = out ? `${out}${tight && n && isList(n) ? "\n" : "\n\n"}${s}` : s;
  }
  return out;
};

const list = (n: Node, depth: number) => {
  const ordered = n.type === "orderedList";
  const order = n.attrs?.order;
  const start =
    typeof order === "number" && Number.isSafeInteger(order) && order >= 0
      ? order
      : 1;
  return (n.content ?? [])
    .map((raw, i) => {
      const item = parse(raw);
      const body =
        item?.type === "listItem"
          ? render(item.content, depth + 1, true)
          : placeholder(item?.type);
      const marker = ordered ? `${start + i}. ` : "- ";
      return `${marker}${body.replace(/\n(?=[^\n])/g, `\n${" ".repeat(marker.length)}`)}`.trimEnd();
    })
    .join("\n");
};

const cell = (raw: unknown): string | undefined => {
  const c = parse(raw);
  const spans = [c?.attrs?.colspan, c?.attrs?.rowspan].some(
    (s) => typeof s === "number" && s > 1,
  );
  if ((c?.type !== "tableCell" && c?.type !== "tableHeader") || spans) return;
  const paragraphs = (c.content ?? []).map(parse);
  if (paragraphs.some((p) => p?.type !== "paragraph")) return;
  return oneLine(paragraphs.map((p) => inline(p?.content)).join(" ")).replace(
    /\|/g,
    "\\|",
  );
};

const table = (n: Node): string | undefined => {
  const rows = (n.content ?? []).map((raw) => {
    const row = parse(raw);
    const cells = row?.type === "tableRow" ? (row.content ?? []).map(cell) : [];
    return cells.every((c): c is string => c !== undefined) ? cells : undefined;
  });
  const width = rows.reduce((m, r) => Math.max(m, r?.length ?? 0), 0);
  if (!width || !rows.every((r): r is string[] => r !== undefined)) return;
  const line = (r: string[]) =>
    `| ${Array.from({ length: width }, (_, i) => r[i] ?? "").join(" | ")} |`;
  const [header = [], ...body] = rows;
  return [line(header), `|${" --- |".repeat(width)}`, ...body.map(line)].join(
    "\n",
  );
};

const block = (raw: unknown, depth: number): string => {
  const n = parse(raw);
  if (!n || depth > maxDepth) return placeholder(n?.type);
  switch (n.type) {
    case "paragraph":
      return escapeLeadingMarker(inline(n.content));
    case "heading": {
      const level = n.attrs?.level;
      const content = oneLine(inline(n.content));
      return content
        ? `${"#".repeat(typeof level === "number" ? Math.min(6, Math.max(1, Math.trunc(level))) : 1)} ${content}`
        : "";
    }
    case "bulletList":
    case "orderedList":
      return list(n, depth);
    case "codeBlock": {
      const code = (n.content ?? [])
        .map((c) => parse(c)?.text ?? "")
        .join("")
        .replace(/\n$/, "");
      const language = n.attrs?.language;
      const fence = ticks(code, 3);
      return `${fence}${typeof language === "string" && /^[\w+#.-]+$/.test(language) ? language : ""}\n${code}\n${fence}`;
    }
    case "blockquote":
      return render(n.content, depth + 1)
        .split("\n")
        .map((l) => (l ? `> ${l}` : ">"))
        .join("\n")
        .replace(/^>$/, "");
    case "rule":
      return "---";
    case "blockCard":
    case "inlineCard":
      return card(n);
    case "table":
      return table(n) ?? placeholder(n.type);
    default:
      return placeholder(n.type);
  }
};

/** Converts a Jira Cloud ADF description to bounded Markdown; unsupported nodes become visible placeholders. */
export function adfToMarkdown(value: unknown): string {
  const parsed = doc.safeParse(value);
  if (!parsed.success) return unreadable;
  return render(parsed.data.content, 0).slice(0, issueBodyLimit).trimEnd();
}
