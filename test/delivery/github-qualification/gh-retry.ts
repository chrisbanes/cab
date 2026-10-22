/** GitHub's own "try again" answers: the command did not take effect. */
const transientGhError =
  /temporary conflict|Please try again|HTTP 50[234]|Bad Gateway|Service Unavailable|Gateway Time-?out/i;
const ghTries = 3;
/** Creates are not repeated: an answer lost after the write would leave a second, unrecorded resource. */
export const notRepeated = (args: readonly string[]) =>
  (args[1] === "create" && (args[0] === "project" || args[0] === "issue")) ||
  args.includes("POST");

/**
 * Runs a guarded `gh` command, trying it again (at most three tries) when GitHub answers with a
 * transient error in setup; a create is never repeated.
 */
export function retryingGh(
  assert: (args: string[]) => void,
  run: (args: string[]) => string,
  retryMs: number,
) {
  return (args: string[]) => {
    assert(args);
    for (let attempt = 1; ; attempt++) {
      try {
        return run(args);
      } catch (error) {
        if (
          attempt >= ghTries ||
          notRepeated(args) ||
          !transientGhError.test(String((error as Error).message))
        )
          throw error;
        // shortcut: blocks the thread, which is fine in a single-run script; upgrade if the harness goes concurrent.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, retryMs);
      }
    }
  };
}
