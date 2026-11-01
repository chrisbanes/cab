---
status: rejected
---

# Do not build ChatGPT operations or native Codex tasks

cab will not add an optional ChatGPT plugin with subscribed events, nor present its
tasks as native Codex tasks with human handover and return. The work was deferred
after the MVP and is now withdrawn; its delivery issues under
[epic #734](https://github.com/chrisbanes/cab/issues/734) are closed as not planned.

Native visibility and handover depend on a host API that does not exist: the
inspected App Server and SDK surfaces expose standalone threads, not linked native
workers, task navigation or an ownership handover
([native feasibility](../evidence/x01-native-feasibility.md)). cab now runs more
than one execution harness ([ADR-1008](1008-claude-code-execution-harness.md)), so a
Codex-only view would cover part of its work, and the
[task conversation view](1022-task-conversation-view.md) already makes worker
conversations inspectable in cab.

The ChatGPT plugin would require a public authenticated HTTPS endpoint, OAuth,
revocation and signed event delivery, widening ADR-1004's private transport, to add
a second daily-operations interface beside the web UI and the
[Mac app](1019-mac-app-channel.md).

A future need, such as remote notifications or chat control, starts from a new
decision rather than reviving this one.
