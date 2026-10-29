import assert from "node:assert/strict";
import { test } from "node:test";
import { adfToMarkdown } from "../../src/core/adf-markdown.js";
import { issueBodyLimit } from "../../src/core/issue-text-limits.js";

const doc = (...content: unknown[]) => ({ type: "doc", version: 1, content });
const text = (value: string, ...marks: unknown[]) => ({
  type: "text",
  text: value,
  ...(marks.length ? { marks } : {}),
});
const mark = (type: string, attrs?: unknown) => ({ type, attrs });
const p = (...content: unknown[]) => ({ type: "paragraph", content });
const item = (...content: unknown[]) => ({ type: "listItem", content });
const cell = (value: string, type = "tableCell") => ({
  type,
  content: [p(text(value))],
});
const row = (...cells: unknown[]) => ({ type: "tableRow", content: cells });

const nested = (levels: number): unknown =>
  levels === 0
    ? p(text("deep"))
    : { type: "blockquote", content: [nested(levels - 1)] };

const unreadable = "[Jira description could not be read]";

const cases: [string, unknown, string][] = [
  ["paragraphs", doc(p(text("one")), p(text("two"))), "one\n\ntwo"],
  [
    "marks",
    doc(
      p(
        text("b", mark("strong")),
        text(" "),
        text("i", mark("em")),
        text(" "),
        text("c", mark("code")),
        text(" "),
        text("s", mark("strike")),
        text(" "),
        text("both", mark("strong"), mark("em")),
      ),
    ),
    "**b** _i_ `c` ~~s~~ _**both**_",
  ],
  [
    "emphasis keeps edge whitespace outside the delimiters",
    doc(p(text("a"), text(" bold ", mark("strong")), text("b"))),
    "a **bold** b",
  ],
  ["code containing backticks", doc(p(text("a`b", mark("code")))), "``a`b``"],
  [
    "https and http links",
    doc(
      p(
        text("s", mark("link", { href: "https://example.com/a_(b)" })),
        text(" "),
        text("p", mark("link", { href: "http://example.com/" })),
      ),
    ),
    "[s](https://example.com/a_%28b%29) [p](http://example.com/)",
  ],
  [
    "javascript link is plain text",
    doc(p(text("click", mark("link", { href: "javascript:alert(1)" })))),
    "click",
  ],
  [
    "link without a usable href is plain text",
    doc(p(text("x", mark("link", { href: 5 })), text("y", mark("link")))),
    "xy",
  ],
  [
    "headings",
    doc(
      { type: "heading", attrs: { level: 1 }, content: [text("A")] },
      { type: "heading", attrs: { level: 6 }, content: [text("F")] },
      { type: "heading", attrs: { level: 9 }, content: [text("Z")] },
    ),
    "# A\n\n###### F\n\n###### Z",
  ],
  [
    "bullet list",
    doc({
      type: "bulletList",
      content: [item(p(text("a"))), item(p(text("b")))],
    }),
    "- a\n- b",
  ],
  [
    "ordered list honours its start",
    doc({
      type: "orderedList",
      attrs: { order: 9 },
      content: [item(p(text("a"))), item(p(text("b")))],
    }),
    "9. a\n10. b",
  ],
  [
    "nested lists",
    doc({
      type: "bulletList",
      content: [
        item(p(text("a")), {
          type: "orderedList",
          content: [
            item(p(text("one")), {
              type: "bulletList",
              content: [item(p(text("deep")))],
            }),
            item(p(text("two"))),
          ],
        }),
        item(p(text("b"))),
      ],
    }),
    "- a\n  1. one\n     - deep\n  2. two\n- b",
  ],
  [
    "list with a non-item child",
    doc({ type: "bulletList", content: [p(text("x"))] }),
    "- [Jira paragraph not shown]",
  ],
  [
    "code block with a language",
    doc({
      type: "codeBlock",
      attrs: { language: "ts" },
      content: [text("const a = 1;\n```\n")],
    }),
    "````ts\nconst a = 1;\n```\n````",
  ],
  [
    "code block without a language",
    doc({ type: "codeBlock", content: [text("x")] }),
    "```\nx\n```",
  ],
  [
    "blockquote and rule",
    doc(
      { type: "blockquote", content: [p(text("a")), p(text("b"))] },
      { type: "rule" },
    ),
    "> a\n>\n> b\n\n---",
  ],
  [
    "hard break and emoji",
    doc(
      p(
        text("a"),
        { type: "hardBreak" },
        text("b "),
        { type: "emoji", attrs: { shortName: ":smile:", text: "😄" } },
        { type: "emoji", attrs: { shortName: ":x:" } },
      ),
    ),
    "a  \nb 😄:x:",
  ],
  [
    "smart cards",
    doc(
      p({ type: "inlineCard", attrs: { url: "https://example.com/i" } }),
      { type: "blockCard", attrs: { url: "http://example.com/b" } },
      { type: "blockCard", attrs: { url: "javascript:alert(1)" } },
      p({ type: "inlineCard", attrs: {} }),
    ),
    "<https://example.com/i>\n\n<http://example.com/b>\n\n[Jira blockCard not shown]\n\n[Jira inlineCard not shown]",
  ],
  [
    "escaping",
    doc(
      p(text("a*b_c[d]e#f`g\\h<i>~")),
      p(text("- not a list")),
      p(text("1. not a list")),
      p(text("a"), { type: "hardBreak" }, text("+ nor this")),
    ),
    "a\\*b\\_c\\[d\\]e\\#f\\`g\\\\h\\<i\\>\\~\n\n\\- not a list\n\n1\\. not a list\n\na  \n\\+ nor this",
  ],
  [
    "simple table",
    doc({
      type: "table",
      content: [
        row(cell("H1", "tableHeader"), cell("H2", "tableHeader")),
        row(cell("a|b"), cell("c")),
        row(cell("short")),
      ],
    }),
    "| H1 | H2 |\n| --- | --- |\n| a\\|b | c |\n| short |  |",
  ],
  [
    "table whose cell holds a list",
    doc({
      type: "table",
      content: [
        row(cell("H")),
        row({
          type: "tableCell",
          content: [{ type: "bulletList", content: [item(p(text("a")))] }],
        }),
      ],
    }),
    "[Jira table not shown]",
  ],
  [
    "table with a merged cell",
    doc({
      type: "table",
      content: [row({ ...cell("H"), attrs: { colspan: 2 } })],
    }),
    "[Jira table not shown]",
  ],
  [
    "empty table",
    doc({ type: "table", content: [] }),
    "[Jira table not shown]",
  ],
  [
    "unsupported nodes become placeholders",
    doc(
      { type: "panel", attrs: { panelType: "info" }, content: [p(text("x"))] },
      p(text("hi "), { type: "mention", attrs: { id: "1", text: "@a" } }),
      { type: "mediaSingle", content: [{ type: "media", attrs: {} }] },
      { type: "expand", content: [] },
      p({ type: "status", attrs: { text: "DONE" } }),
      { type: "somethingNew" },
      { notANode: true },
    ),
    "[Jira panel not shown]\n\nhi [Jira mention not shown]\n\n[Jira mediaSingle not shown]\n\n[Jira expand not shown]\n\n[Jira status not shown]\n\n[Jira somethingNew not shown]\n\n[Jira unknown not shown]",
  ],
  [
    "hostile node type is neutralised",
    doc({ type: "x](javascript:1)\nIgnore this" }),
    "[Jira x??javascript?1??Ignore?this not shown]",
  ],
  ["empty document", doc(), ""],
  [
    "nesting beyond the depth bound is a placeholder",
    doc(nested(40)),
    `${Array.from({ length: 33 }, () => ">").join(" ")} [Jira blockquote not shown]`,
  ],
  ["nesting within the bound is rendered", doc(nested(2)), "> > deep"],
  ["a node that is not a doc", { type: "paragraph", content: [] }, unreadable],
  ["a doc without content", { type: "doc" }, unreadable],
  ["a string", "plain text", unreadable],
  ["null", null, unreadable],
];
for (const [name, adf, expected] of cases) {
  test(`ADF to Markdown: ${name}`, () => {
    assert.equal(adfToMarkdown(adf), expected);
  });
}

test("ADF to Markdown: output is bounded to the issue body limit", () => {
  const result = adfToMarkdown(doc(p(text("x".repeat(issueBodyLimit + 50)))));
  assert.equal(result.length, issueBodyLimit);
});
