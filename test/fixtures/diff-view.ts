import type { Locator } from "playwright";

/**
 * Selectors for the Changes file tree (@pierre/trees) and diff (@pierre/diffs). Both render in
 * open shadow roots, which Playwright's CSS locators pierce.
 */
export type DiffSide = "Before" | "After";

/** The changed-files tree row for a file, by its tree path (repository and change-set folders included). */
export function changedFile(scope: Locator, path: string) {
  return scope.locator(`[role="treeitem"][data-item-path="${path}"]`);
}

/** The rendered diff of the open file. */
export function fileDiff(scope: Locator) {
  return scope.locator(".changes-file-diff");
}

/** Waits until the diff (loaded on first use) has rendered its lines. */
export async function waitForDiff(scope: Locator) {
  await fileDiff(scope)
    .locator("pre[data-diff] [data-gutter]")
    .first()
    .waitFor();
}

/** The open file's path as the diff header shows it. */
export function diffTitle(scope: Locator) {
  return fileDiff(scope).locator("[data-title]");
}

function column(side: DiffSide) {
  return side === "Before" ? "code[data-deletions]" : "code[data-additions]";
}
function unifiedType(side: DiffSide) {
  return side === "Before" ? "change-deletion" : "change-addition";
}

/**
 * The line-number cell of `line` on one side; clicking it selects that line. Split view has a
 * column per side; unified view has one column, where a Before line is a deletion and an After
 * line an addition or context line.
 */
export function diffLineNumber(scope: Locator, side: DiffSide, line: number) {
  const number = `[data-gutter] [data-column-number="${line}"]`;
  return fileDiff(scope)
    .locator(
      `${column(side)} ${number}, ` +
        `code[data-unified] ${number}:is([data-line-type="${unifiedType(side)}"]${side === "After" ? ', [data-line-type="context"]' : ""})`,
    )
    .first();
}

/** The code text of `line` on one side. */
export function diffLineText(scope: Locator, side: DiffSide, line: number) {
  const content = `[data-content] [data-line="${line}"]`;
  return fileDiff(scope)
    .locator(
      `${column(side)} ${content}, ` +
        `code[data-unified] ${content}:is([data-line-type="${unifiedType(side)}"]${side === "After" ? ', [data-line-type="context"]' : ""})`,
    )
    .first();
}

/** Line numbers the diff shows as selected on one side, in order. */
export async function selectedDiffLines(scope: Locator, side: DiffSide) {
  const cells = fileDiff(scope).locator(
    `${column(side)} [data-gutter] [data-selected-line], code[data-unified] [data-gutter] [data-selected-line]`,
  );
  return (await cells.evaluateAll((elements) =>
    elements.map((element) =>
      Number(element.getAttribute("data-column-number")),
    ),
  )) as number[];
}

/** The texts of one side's changed lines (deletions Before, additions After). */
export async function changedLineTexts(scope: Locator, side: DiffSide) {
  return fileDiff(scope)
    .locator(
      `${column(side)} [data-content] [data-line-type="${unifiedType(side)}"], ` +
        `code[data-unified] [data-content] [data-line-type="${unifiedType(side)}"]`,
    )
    .allTextContents();
}

/** The keyboard stop of a selectable diff. */
export function diffKeys(scope: Locator) {
  return scope.locator(".changes-diff-keys");
}

/** The line numbers one side's gutter shows, in order. */
export function diffLineNumbers(scope: Locator, side: DiffSide) {
  return fileDiff(scope)
    .locator(`${column(side)} [data-gutter] [data-column-number]`)
    .allTextContents();
}

/** The tree paths of the file rows the changed-files tree shows. */
export function changedFilePaths(scope: Locator) {
  return scope
    .locator('[role="treeitem"][data-item-type="file"]')
    .evaluateAll((elements) =>
      elements.map((element) => element.getAttribute("data-item-path") ?? ""),
    );
}
