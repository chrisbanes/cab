/**
 * A press waits for the installation-wide refresh, which answers only after the scheduler wake it
 * starts: each newly ready imported task gets a workspace (about ten git processes) first. That is
 * about a second here, but has exceeded the 5 s default on a contended CI runner.
 */
export const refreshed = { timeout: 15_000 };
