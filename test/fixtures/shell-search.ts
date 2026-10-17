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
