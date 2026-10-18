/**
 * Who owns a LaunchDaemon install: the one pure decision behind `service install --mode
 * daemon` verification and `service uninstall` completion, so the two cannot disagree.
 *
 * What Ensemble has seen of the service is recorded as `Observed`. Observations only ever
 * move up (never seen, then loaded, then an identified process), and an identity is
 * dropped only when its exit is confirmed. A job that was loaded but had no pid yet is
 * not "never started": launchd may have started it a moment later, so it is held to the
 * same log and port evidence as a job that was never seen.
 *
 * Decision table (`job` is what `launchctl print system/<label>` reports now):
 *
 *   verify    job absent                                      -> not-started (print the steps)
 *   verify    loaded, no pid                                  -> hold
 *   verify    loaded, pid, identity unreadable                -> hold
 *   verify    loaded, pid, port not served by that pid        -> hold
 *   verify    loaded, pid, identity, port served by that pid  -> started
 *   uninstall job loaded or plist present                     -> pending (print the steps)
 *   uninstall both gone, any process unconfirmed or unidentified -> hold
 *   uninstall both gone, port in use                          -> hold
 *   uninstall both gone, no identity ever recorded, a log exists -> hold
 *   uninstall both gone, otherwise                            -> complete
 */

/**
 * The pids in `lsof -nP -iTCP:PORT -sTCP:LISTEN -Fp` output, from its exit status and stdout.
 * lsof exits 1 with no output when nothing listens; any other failure, or a status that is not
 * 0, is unknown (null). Only whole `p<digits>` lines are pids.
 */
export function parseLsofListeners(result: {
  status: number;
  stdout: string;
}): number[] | null {
  if (result.status === 1 && result.stdout.trim() === "") return [];
  if (result.status !== 0) return null;
  return [...result.stdout.matchAll(/^p(\d+)$/gm)].map((m) => Number(m[1]));
}

export type ProcessIdentity = {
  processId: string;
  processStartedAt: string;
  bootId: string;
};

/** What was seen of the service; absent means launchd was never seen running it. */
export type Observed = {
  /** Identities of processes launchd ran and whose exit is not yet confirmed. */
  processes: ProcessIdentity[];
  /** A process ran whose identity could not be read: never cleared, only by hand. */
  unidentified: boolean;
  /** An identity was recorded at some point, even if its exit is confirmed since. */
  identified: boolean;
};

/** What one look at the loaded job found. */
export type Seen = "no-process" | "unreadable" | ProcessIdentity;

export const MAX_OBSERVED_PROCESSES = 8;

/** The one test of "the same process": pid, start time and boot session all equal. */
export const sameIdentity = (a: ProcessIdentity, b: ProcessIdentity) =>
  a.processId === b.processId &&
  a.processStartedAt === b.processStartedAt &&
  a.bootId === b.bootId;

/** Folds one observation into what is recorded. `processes` must already hold only unconfirmed ones. */
export function refineObserved(
  previous: Observed | undefined,
  seen: Seen,
): Observed {
  const base: Observed = previous ?? {
    processes: [],
    unidentified: false,
    identified: false,
  };
  if (seen === "no-process") return base;
  if (seen === "unreadable") return { ...base, unidentified: true };
  if (base.processes.some((process) => sameIdentity(process, seen)))
    return { ...base, identified: true };
  if (base.processes.length >= MAX_OBSERVED_PROCESSES)
    return { ...base, unidentified: true };
  return { ...base, processes: [...base.processes, seen], identified: true };
}

export type Job =
  | { state: "absent" }
  | { state: "loaded"; pid: number | undefined };

/** Who answers on the daemon's port, relative to the job's pid. */
export type Listener = "ours" | "foreign" | "unknown" | "free";

export type DaemonFacts = {
  operation: "verify" | "uninstall";
  job: Job;
  plistPresent: boolean;
  /** What the record holds, after folding in this run's observation. */
  observed: Observed | undefined;
  /** Every recorded process is confirmed gone (vacuously true with none). */
  processesGone: boolean;
  portBusy: boolean;
  logsPresent: boolean;
  /** Verify only: the loaded job's identity was read. */
  identityRead: boolean;
  listener: Listener;
};

export type DaemonDecision =
  | { kind: "started" | "not-started" | "pending" | "complete" }
  | { kind: "hold"; reason: string };

const hold = (reason: string): DaemonDecision => ({ kind: "hold", reason });

export function daemonDecision(facts: DaemonFacts): DaemonDecision {
  if (facts.operation === "verify") {
    if (facts.job.state === "absent") return { kind: "not-started" };
    if (facts.job.pid === undefined)
      return hold("the job is loaded but has no running process");
    if (!facts.identityRead) return hold("its process could not be identified");
    if (facts.listener === "foreign")
      return hold("another process answers on the port");
    if (facts.listener === "unknown")
      return hold("the process serving the port could not be established");
    if (facts.listener === "free")
      return hold("its process is not serving the port");
    return { kind: "started" };
  }
  if (facts.job.state === "loaded" || facts.plistPresent)
    return { kind: "pending" };
  const { observed } = facts;
  if (observed?.unidentified)
    return hold("its process could not be identified");
  if (!facts.processesGone)
    return hold("its recorded process may still be running");
  if (facts.portBusy) return hold("its port is still in use");
  // No identity to confirm: a job seen without a pid, or never seen, may still have started.
  if (!observed?.identified && facts.logsPresent)
    return hold("it may have run without being recorded");
  return { kind: "complete" };
}
