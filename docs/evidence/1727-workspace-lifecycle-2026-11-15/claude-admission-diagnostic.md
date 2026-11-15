# Claude turn admission diagnostic

Date: 2026-11-15. Grant `1727-claude-admission-diag-20261115-a`: model-free, at most two
runs, zero model turns. It follows the refused Claude turn in
[attempt 1](t1-runtime-qualification.md).

## Method

Each run used the qualification harness's production setup (`initializeProduction`) and
cab's own `ClaudeRuntime.startTurn` for the Claude A turn, with the installed Claude Code
2.1.325 and SDK 0.3.319. The SDK was wrapped so that every query's prompt became a
generator that never yields, so no prompt could reach the model. The wrapper recorded only
these value-free facts:

- from `accountInfo()`: `apiProvider`, `apiKeySource` and whether `subscriptionType` was
  present;
- from `mcpServerStatus()`: each row's `status` and `source`, with every name other than
  `cab` replaced;
- any rejected call;
- child exit codes and signals;
- stderr, with credential-like lines redacted.

The wrapper polled MCP status every 500 ms and aborted after 3.5 s. cab's own refusal
aborted the turn first, so each run got one status read.

- Run 1: the same environment as attempt 1. `CLAUDE_CONFIG_DIR` was a disposable
  directory and `CLAUDE_SECURESTORAGE_CONFIG_DIR` was empty.
- Run 2: identical, but with both variables unset, so the CLI used the service user's
  native configuration.

## Results

| Fact | Run 1 (disposable config) | Run 2 (native config) |
| --- | --- | --- |
| Settings read, `accountInfo()` | `firstParty`, subscription present | `firstParty`, subscription present |
| Turn query options | sandboxed, default `settingSources`, default `persistSession`, `cab` server type `sdk` | the same |
| Turn `accountInfo()` | `firstParty`, subscription present, no rejection | `firstParty`, subscription present, no rejection |
| Turn `mcpServerStatus()`, about 0.8 s after spawn | `[]`: no rows at all | nine rows, all the user's own (`user` or `claudeai`, pending or failed); **no `cab` row** |
| Rejections | none | none |
| CLI exits | settings read 0; turn 0 after the abort | settings read 0; turn 0 after the abort |
| stderr | empty | empty |
| Outcome | the same refusal as attempt 1 | the same refusal |

No model turn ran and no session transcript was written.

## Conclusion

- The failing condition is cab's MCP check. `accountInfo()` passes in the turn process, so
  the account candidate is ruled out. No call rejected and the CLI exited only when
  aborted, so the early-exit candidate is ruled out.
- The disposable configuration directory is ruled out too. With the native configuration,
  the CLI listed the user's servers but still no `cab` row.
- Claude Code 2.1.325 builds its `mcp_status` reply from its live MCP client list. cab's
  SDK-type server was absent from that list, rather than listed as `pending`, when cab read
  it. Whether the row appears later, or only once a prompt flows, is **untested**: cab
  refuses on the first read, so the poll could not observe a later state. Earlier records
  ran Claude Code up to 2.1.322; cab's SDK qualification targets 0.3.319.
- The smallest fix this implies is in the product, in `startTurn`'s admission check in
  `src/standalone/claude.ts`. That check cannot pass on this CLI as written. A harness-only
  change cannot fix it, because the harness runs that production path. The same refusal
  may affect production Claude turns on 2.1.325; these runs did not test that.

## Cleanup

Both disposable roots and their per-workspace Claude temporary bases were removed. The
roots held no links. No processes remained. No credential contents were read, copied,
hashed or printed, and no session transcript was left in the native configuration. The
diagnostic script was not committed.
