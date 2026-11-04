import assert from "node:assert/strict";

/** Signed-in browser session transport for disposable qualification fixtures. */
export async function sessionCommand(page, origin, command) {
  const response = await page
    .context()
    .request.get(`${origin}/api/operator/session`);
  assert.equal(response.status(), 200);
  const session = await response.json();
  assert.equal(session.authenticated, true);
  const result = await page
    .context()
    .request.post(`${origin}/api/operator/commands`, {
      headers: { origin, "x-csrf-token": session.csrfToken },
      data: command,
    });
  assert.equal(result.status(), 200);
  return result.json();
}
export async function signOutOperator(page, origin) {
  const session = await (
    await page.context().request.get(`${origin}/api/operator/session`)
  ).json();
  const result = await page
    .context()
    .request.post(`${origin}/api/operator/logout`, {
      headers: { origin, "x-csrf-token": session.csrfToken },
      data: {},
    });
  assert.equal(result.status(), 200);
  await page.goto(`${origin}/login`);
}
