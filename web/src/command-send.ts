import { useRef, useState } from "react";
import type {
  CommandReceipt,
  OperatorCommand,
  Session,
} from "../../src/operator/contracts.js";
import type { OperatorClient } from "./api.js";
import { CommandLifecycle } from "./command-lifecycle.js";

export type SendOutcome = {
  kind: "recorded" | "unknown" | "conflict" | "failed";
  command: OperatorCommand;
  code?: string | undefined;
};

/**
 * One operator command at a time, sent once per key. `send(command)` freezes and sends a new
 * command; `send()` resends the frozen one after an unknown outcome, so a retry never records twice.
 */
export function useCommandSend(
  client: OperatorClient,
  session: Session,
  matches: (command: OperatorCommand, receipt: CommandReceipt) => boolean,
  /** Runs once each send settles, with how it ended. */
  onSettled?: (kind: SendOutcome["kind"]) => void,
) {
  const lifecycle = useRef(new CommandLifecycle<OperatorCommand>()).current;
  const [sending, setSending] = useState<OperatorCommand | null>(null),
    [outcome, setOutcome] = useState<SendOutcome | null>(null);
  const send = async (command?: OperatorCommand) => {
    if (command && !lifecycle.freeze(command)) return;
    const begun = lifecycle.begin();
    if (!begun) return;
    const currentAuthentication = client.captureAuthenticationScope();
    setSending(begun);
    const result = await client.command(begun, session.csrfToken);
    if (!currentAuthentication()) return;
    const disposition = lifecycle.settle(result, matches);
    const kind = disposition === "rejected" ? "failed" : disposition;
    setSending(null);
    setOutcome({
      kind,
      command: begun,
      code: result.state === "recorded" ? undefined : result.code,
    });
    onSettled?.(kind);
  };
  return {
    send,
    sending,
    outcome,
    /** The last send's outcome is unconfirmed; only `send()` may resolve it. */
    uncertain: lifecycle.uncertain,
    clear: () => setOutcome(null),
  };
}
