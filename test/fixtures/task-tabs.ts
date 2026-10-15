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
