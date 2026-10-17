import type { Page } from "playwright";

export type TaskTabName =
  | "Overview"
  | "Files"
  | "Changes"
  | "Review"
  | "History";

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

export type OverviewCardName = "brief" | "evidence" | "assignments";

/** The collapsed Overview card's `details` element. */
export const overviewCard = (page: Page, name: OverviewCardName) =>
  page.locator(
    `#${name === "evidence" ? "result-evidence" : name} > details.overview-disclosure`,
  );

/** Opens a collapsed Overview card through its summary, as an operator does; an open one is left alone. */
export async function openOverviewCard(page: Page, name: OverviewCardName) {
  const card = overviewCard(page, name);
  if ((await card.getAttribute("open")) === null)
    await card.locator("> summary").click();
  await page
    .locator(
      `#${name === "evidence" ? "result-evidence" : name} > details[open]`,
    )
    .waitFor();
}
