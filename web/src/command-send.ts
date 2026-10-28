import {
  createContext,
  useContext,
  useEffect,
  useReducer,
  useRef,
} from "react";
import type {
  CommandReceipt,
  OperatorCommand,
  Session,
} from "../../src/operator/contracts.js";
import type { CommandState, OperatorClient } from "./api.js";
import { CommandLifecycle } from "./command-lifecycle.js";

export type SendOutcome = {
  kind: "recorded" | "unknown" | "conflict" | "failed";
  command: OperatorCommand;
  code?: string | undefined;
};
type Matches = (command: OperatorCommand, receipt: CommandReceipt) => boolean;

/**
 * One operator command at a time, sent once per key. `send(…, command)` freezes and sends a new
 * command; `send(…)` resends the frozen one after an unknown outcome, so a retry never records
 * twice. It lives outside React, so a send left unconfirmed is still here on return.
 */
export class CommandSend {
  readonly lifecycle = new CommandLifecycle<OperatorCommand>();
  sending: OperatorCommand | null = null;
  outcome: SendOutcome | null = null;
  /** The draft behind this command; cleared once it is recorded. */
  text = "";
  /** Run when a send settles while a component using this entry is mounted. */
  readonly onSettled = new Set<(kind: SendOutcome["kind"]) => void>();
  constructor(private readonly changed: () => void = () => {}) {}
  get uncertain() {
    return this.lifecycle.uncertain;
  }
  clear() {
    this.outcome = null;
    this.changed();
  }
  edit(text: string) {
    this.text = text;
    this.changed();
  }
  /**
   * How the send settled and the service's answer, or null when nothing was sent or the session
   * changed while it was in flight.
   */
  async send(
    client: OperatorClient,
    csrfToken: string,
    matches: Matches,
    command?: OperatorCommand,
  ): Promise<{ kind: SendOutcome["kind"]; result: CommandState } | null> {
    if (command) {
      // A recorded command is finished; only an unconfirmed one must be resent before another.
      if (this.lifecycle.receipt) this.lifecycle.reset();
      if (!this.lifecycle.freeze(command)) return null;
    }
    const begun = this.lifecycle.begin();
    if (!begun) return null;
    const currentAuthentication = client.captureAuthenticationScope();
    this.sending = begun;
    this.changed();
    const result = await client.command(begun, csrfToken);
    if (!currentAuthentication()) return null;
    return { kind: this.settle(begun, result, matches), result };
  }
  /** Records how `command`'s send ended and tells the mounted components. */
  settle(
    command: OperatorCommand,
    result: CommandState,
    matches: Matches,
  ): SendOutcome["kind"] {
    const disposition = this.lifecycle.settle(result, matches, {
      settleRefusal: true,
    });
    const kind = disposition === "rejected" ? "failed" : disposition;
    this.sending = null;
    this.outcome = {
      kind,
      command,
      code: result.state === "recorded" ? undefined : result.code,
    };
    if (kind === "recorded") this.text = "";
    this.changed();
    for (const settled of this.onSettled) settled(kind);
    return kind;
  }
}

/** The signed-in session's unconfirmed commands by task and resource; a session change purges them. */
export class CommandSends {
  private entries = new Map<string, CommandSend>();
  private listeners = new Set<() => void>();
  entry(key: string) {
    let entry = this.entries.get(key);
    if (!entry) {
      entry = new CommandSend(() => this.changed());
      this.entries.set(key, entry);
    }
    return entry;
  }
  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  changed() {
    for (const listener of this.listeners) listener();
  }
  purge() {
    this.entries.clear();
    this.changed();
  }
}
export const CommandSendsContext = createContext(new CommandSends());

/** The entry for `key`, re-rendering the component whenever any entry changes. */
export function useSendEntry(key: string) {
  const sends = useContext(CommandSendsContext),
    [, render] = useReducer((n: number) => n + 1, 0);
  useEffect(() => sends.subscribe(render), [sends]);
  return sends.entry(key);
}

/** Re-renders when the entry changes, and while mounted runs `onSettled` for sends that settle. */
export function useCommandSend(
  client: OperatorClient,
  session: Session,
  /** The task and resource the command acts on, e.g. `${taskId}:result:${resultId}`. */
  key: string,
  matches: Matches,
  /** Runs once each send settles while this component is mounted, with how it ended. */
  onSettled?: (kind: SendOutcome["kind"]) => void,
) {
  const entry = useSendEntry(key),
    latest = useRef(onSettled);
  latest.current = onSettled;
  useEffect(() => {
    const settled = (kind: SendOutcome["kind"]) => latest.current?.(kind);
    entry.onSettled.add(settled);
    return () => {
      entry.onSettled.delete(settled);
      // A recorded confirmation belongs to the visit that sent it, not to the next one.
      if (entry.outcome?.kind === "recorded") entry.outcome = null;
    };
  }, [entry]);
  return {
    entry,
    send: (command?: OperatorCommand) =>
      entry.send(client, session.csrfToken, matches, command),
    sending: entry.sending,
    outcome: entry.outcome,
    /** The last send's outcome is unconfirmed; only `send()` may resolve it. */
    uncertain: entry.uncertain,
    clear: () => entry.clear(),
  };
}
