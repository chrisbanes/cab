import type { Page } from "playwright";

/**
 * Opens Search from the sidebar's Search work field (the desktop shell's only Search entry): an
 * empty submit navigates to /app/search in-app, like the drawer's Search row at narrow widths.
 * `keepFocus` submits without moving focus, for journeys that assert the origin's focus survives.
 */
export async function openSearchFromSidebar(
  page: Page,
  { keepFocus = false }: { keepFocus?: boolean } = {},
) {
  const field = page.getByRole("search").getByLabel("Search work");
  if (keepFocus)
    await field.evaluate((input) =>
      (input as HTMLInputElement).form?.requestSubmit(),
    );
  else await field.press("Enter");
  await page
    .getByLabel("Search retained task, decision and result records")
    .waitFor();
}

export const searchFieldLabel =
  "Search retained task, decision and result records";

/** The local-day bounds Search puts in the URL for a YYYY-MM-DD date. */
export const searchDayStart = (day: string) =>
  String(new Date(`${day}T00:00:00`).getTime());
export const searchDayEnd = (day: string) =>
  String(new Date(`${day}T23:59:59.999`).getTime());

/**
 * Waits for the Search page the current one is replaced by. Every applied query or filter pushes
 * an entry and remounts the page, so a marker on the old page proves the new one is showing.
 */
async function replacedSearchPage(page: Page, action: () => Promise<unknown>) {
  await page
    .locator(".search-workspace")
    .evaluate((el) => el.setAttribute("data-replaced", ""));
  await action();
  await page
    .locator(".search-workspace[data-replaced]")
    .waitFor({ state: "detached" });
}

export type SearchFilters = {
  /** Includes historical records; a filter must change the URL to be applied. */
  historical?: true;
  type?: "task" | "decision" | "result";
  projectId?: string;
  /** Local day, YYYY-MM-DD. */
  from?: string;
  through?: string;
};

/**
 * Searches from an open Search page, then applies each filter the way a person does: the filters
 * sit beside the result count once there is a query and each one re-runs the search. Every step
 * waits for the URL it produces and for the page that replaces the old one; nothing is timed.
 */
export async function searchRecords(
  page: Page,
  query: string,
  filters: SearchFilters = {},
) {
  const param = (name: string, value: string) =>
    page.waitForURL(
      (url) =>
        url.pathname === "/app/search" && url.searchParams.get(name) === value,
    );
  const apply = (name: string, value: string, act: () => Promise<unknown>) =>
    replacedSearchPage(page, async () => {
      await act();
      await param(name, value);
    });
  const field = page.getByLabel(searchFieldLabel);
  await apply("query", query, async () => {
    await field.fill(query);
    await field.press("Enter");
  });
  await page.locator("#search-count").waitFor();
  if (filters.historical)
    await apply("historical", "true", () =>
      page.getByLabel("Include historical records").check(),
    );
  if (filters.type)
    await apply("type", filters.type, () =>
      page
        .getByLabel("Record type", { exact: true })
        .selectOption(filters.type as string),
    );
  if (filters.projectId)
    await apply("projectId", filters.projectId, () =>
      page
        .getByLabel("Project", { exact: true })
        .selectOption(filters.projectId as string),
    );
  if (filters.from)
    await apply("after", searchDayStart(filters.from), async () => {
      const from = page.getByLabel("From date", { exact: true });
      await from.fill(filters.from as string);
      await from.blur();
    });
  if (filters.through)
    await apply("before", searchDayEnd(filters.through), async () => {
      const through = page.getByLabel("Through date", { exact: true });
      await through.fill(filters.through as string);
      await through.press("Enter");
    });
  await page.locator("#search-count").waitFor();
}
