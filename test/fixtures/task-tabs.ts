import type { Page } from "playwright";

export type TaskTabName =
  | "Overview"
  | "Files"
  | "Changes"
  | "Review"
  | "Execution";

/**
 * Opens one of the task page's tabs and waits until its panel shows. An open tab is left
 * alone, so the focus stays where it was.
 */
export async function openTaskTab(page: Page, name: TaskTabName) {
  const tab = page
    .getByRole("tablist", { name: "Task sections" })
    .getByRole("tab", { name, exact: true });
  if ((await tab.getAttribute("aria-selected")) !== "true") await tab.click();
  await page.locator(`#${await tab.getAttribute("aria-controls")}`).waitFor();
}

export type OverviewCardName =
  | "brief"
  | "issue-brief"
  | "evidence"
  | "assignments"
  | "context";

/** The collapsed Overview card's `details` element. */
export const overviewCard = (page: Page, name: OverviewCardName) =>
  page.locator(
    `#${name === "evidence" ? "result-evidence" : name} > details.overview-disclosure`,
  );

/** Opens the task's facts without changing any inner disclosure. */
export async function openTaskDetails(page: Page) {
  const fold = page.locator("details.inspector-fold");
  if ((await fold.getAttribute("open")) === null)
    await fold.locator("> summary").click();
}

/** Opens a collapsed Overview card through its summary, as an operator does; an open one is left alone. */
export async function openOverviewCard(page: Page, name: OverviewCardName) {
  // The cards sit in the inspector's fold, which a phone leaves closed.
  await openTaskTab(page, name === "context" ? "Execution" : "Overview");
  if (name !== "context" && name !== "evidence") await openTaskDetails(page);
  const card = overviewCard(page, name);
  if ((await card.getAttribute("open")) === null)
    await card.locator("> summary").click();
  await card.and(page.locator("[open]")).waitFor();
}

/** A phone keeps the task options in the header's Task actions; wider, in the strip's menu. */
const onPhone = (page: Page) => (page.viewportSize()?.width ?? 0) < 760;

/** A task option's button, read even while its closed menu hides it. */
export const taskOptionButton = (page: Page, name: string) =>
  page
    .locator(onPhone(page) ? ".task-header-actions" : ".task-tools")
    .getByRole("button", { name, includeHidden: true });

/** Opens the menu that holds the task options, unless the named option already shows. */
export async function openTaskOptions(page: Page, name: string) {
  if (await taskOptionButton(page, name).isVisible()) return;
  await page
    .locator(
      onPhone(page) ? ".task-header-overflow-toggle" : ".task-tools > summary",
    )
    .click();
  await taskOptionButton(page, name).waitFor();
}
