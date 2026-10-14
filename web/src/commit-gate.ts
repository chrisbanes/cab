/**
 * Counts announced changes so a caller can wait for the React commit that shows them,
 * instead of guessing with an animation frame (which may run before the commit).
 */
export class CommitGate {
  revision = 0;
  private shown = 0;
  private queue: (() => void)[] = [];
  /** A change was announced; the next commit must show it. */
  changed() {
    this.revision++;
  }
  /** The page committed a render that shows every change up to `revision`. */
  committed(revision: number) {
    this.shown = Math.max(this.shown, revision);
    if (this.shown < this.revision) return;
    for (const run of this.queue.splice(0)) run();
  }
  /** Run `run` once the page has committed every change announced so far. */
  afterRender(run: () => void) {
    if (this.shown >= this.revision) run();
    else this.queue.push(run);
  }
  /** Drop work waiting for a commit that will not come. */
  discard() {
    this.queue = [];
  }
}
