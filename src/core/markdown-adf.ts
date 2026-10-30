/** The only ADF nodes this converter emits; never a mention, media, card or link. */
export type AdfNode =
  | { type: "paragraph"; content: AdfInline[] }
  | {
      type: "codeBlock";
      attrs?: { language: string };
      content?: [{ type: "text"; text: string }];
    };
type AdfInline = { type: "text"; text: string } | { type: "hardBreak" };
export interface AdfDoc {
  version: 1;
  type: "doc";
  content: AdfNode[];
}

const fenceOpen = /^```([A-Za-z0-9_+#.-]{0,30})[^`]*$/;
const fenceClose = /^```\s*$/;

/**
 * Markdown to the Atlassian Document Format for a Jira comment: blank-line paragraphs, single
 * newlines as hard breaks and fenced code blocks. Everything else stays literal text, so a posted
 * comment cannot notify, embed or link anything. Throws on text with no content.
 */
export function markdownToAdf(markdown: string): AdfDoc {
  const content: AdfNode[] = [];
  let paragraph: string[] = [];
  const flush = () => {
    if (!paragraph.length) return;
    const inline: AdfInline[] = [];
    for (const line of paragraph) {
      if (inline.length) inline.push({ type: "hardBreak" });
      inline.push({ type: "text", text: line });
    }
    content.push({ type: "paragraph", content: inline });
    paragraph = [];
  };
  const lines = markdown
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const open = fenceOpen.exec(line);
    if (open) {
      flush();
      const code: string[] = [];
      // An unclosed fence runs to the end, as in Markdown.
      for (i++; i < lines.length && !fenceClose.test(lines[i] ?? ""); i++)
        code.push(lines[i] ?? "");
      const text = code.join("\n");
      content.push({
        type: "codeBlock",
        ...(open[1] ? { attrs: { language: open[1] } } : {}),
        ...(text ? { content: [{ type: "text" as const, text }] } : {}),
      });
    } else if (line.trim()) paragraph.push(line);
    else flush();
  }
  flush();
  if (!content.length) throw new Error("Comment has no content");
  return { version: 1, type: "doc", content };
}
