// Observes one real Claude turn query for the live escalation run (#1682 T4): wraps the
// PreToolUse and post-tool hooks and canUseTool, and returns a handler for the stream's
// messages. Records go to `turn.events` by tool_use_id, with times from `now()`; no command
// output is recorded. The live run and its offline contract use this same code.

const short = (value, size = 200) =>
  typeof value === "string" ? value.slice(0, size) : null;

/** The real turn query, observed: hooks, canUseTool and stream messages by tool_use_id. */
export function observeTurn(options, turn, now) {
  // Returns the stored record, so a later field (a hook's decision) lands on it, not a copy.
  const push = (event) => {
    const stored = { t: now(), ...event };
    turn.events.push(stored);
    return stored;
  };
  const pre = options.hooks.PreToolUse[0];
  const preHook = pre.hooks[0];
  pre.hooks = [
    async (input, id, context) => {
      const flag = input.tool_input?.dangerouslyDisableSandbox;
      const event = push({
        kind: "pre",
        toolUseId: input.tool_use_id,
        tool: input.tool_name,
        command: short(input.tool_input?.command),
        flagged: flag !== undefined && flag !== false,
      });
      const output = await preHook(input, id, context);
      event.decision = output?.hookSpecificOutput?.permissionDecision ?? "pass";
      event.returnedAt = now();
      return output;
    },
  ];
  for (const name of ["PostToolUse", "PostToolUseFailure"]) {
    const matcher = options.hooks[name][0];
    const hook = matcher.hooks[0];
    matcher.hooks = [
      async (input, id, context) => {
        push({
          kind: "post",
          event: input.hook_event_name,
          toolUseId: input.tool_use_id,
        });
        return hook(input, id, context);
      },
    ];
  }
  const canUseTool = options.canUseTool;
  options.canUseTool = async (tool, input, context) => {
    const id = context.toolUseID;
    push({ kind: "ask", toolUseId: id, tool, command: short(input?.command) });
    // A cancellation counts only while the ask is unanswered.
    const aborted = () => push({ kind: "askAborted", toolUseId: id });
    if (context.signal?.aborted) aborted();
    else context.signal?.addEventListener("abort", aborted, { once: true });
    try {
      const answer = await canUseTool(tool, input, context);
      push({ kind: "askResult", toolUseId: id, behavior: answer.behavior });
      return answer;
    } finally {
      context.signal?.removeEventListener("abort", aborted);
    }
  };
  return (message) => {
    if (message.type === "system" && message.subtype === "init")
      turn.init = { permissionMode: message.permissionMode ?? null };
    else if (
      message.type === "system" &&
      message.subtype === "permission_denied"
    )
      push({
        kind: "denied",
        toolUseId: message.tool_use_id,
        reasonType: message.decision_reason_type ?? null,
      });
    else if (message.type === "system")
      push({ kind: "system", subtype: message.subtype ?? null });
    else if (message.type === "result")
      turn.result = {
        subtype: message.subtype,
        isError: message.is_error === true,
      };
    else if (message.type === "assistant")
      for (const part of message.message?.content ?? [])
        if (part.type === "tool_use")
          push({
            kind: "toolUse",
            toolUseId: part.id,
            tool: part.name,
            command: short(part.input?.command),
          });
    if (message.type === "user" && Array.isArray(message.message?.content))
      for (const part of message.message.content)
        if (part.type === "tool_result")
          push({
            kind: "toolResult",
            toolUseId: part.tool_use_id,
            isError: part.is_error === true,
          });
  };
}
