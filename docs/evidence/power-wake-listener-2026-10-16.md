# Sleep/wake listener bounded live check

**Result: the listener subscribed, stopped cleanly and exited after its parent
died. No real system sleep or wake was triggered, so this is not physical R03
qualification ([#732](https://github.com/chrisbanes/ensemble/issues/732)).**
This record covers [#1070](https://github.com/chrisbanes/ensemble/issues/1070)
at source commit `c10413558f3f9b2494d441179d359fa883316478`, following the
[published plan](https://github.com/chrisbanes/ensemble/issues/1070#issuecomment-6220484562).

## Environment

macOS 27.0.1 (26A434) on the development Mac, Node `v24.21.0`, built `dist`
output. The listener is `/usr/bin/osascript -l JavaScript` observing
`NSWorkspaceWillSleepNotification` and `NSWorkspaceDidWakeNotification`; no native
addon or compiled helper is involved.

## Observed

- **Cross-process delivery (planning proof).** A probe running the same JXA
  observer pattern received a system-originated `NSWorkspace` notification
  (`NSWorkspaceDidLaunchApplicationNotification`, triggered by launching
  Calculator) 409 ms after `ready`, then stopped with no `osascript` child left.
  An earlier display-sleep trigger (`pmset displaysleepnow`) did not turn the
  display off, because a `delayDisplayOff` assertion was active. That run was
  inconclusive, not a failed delivery.
- **Subscribe and stop.** `new MacPowerEventSource().start(...)` resolved after
  73 ms with one `osascript` child. No signals arrived in a 3 s idle window.
  `stop()` returned after 18 ms, and `pgrep -P <node pid> osascript` then found no
  child.
- **Parent death.** After the Node process started a listener and SIGKILLed
  itself, the listener process was gone within 1 s.

## Not exercised

Real `NSWorkspaceWillSleepNotification` or `NSWorkspaceDidWakeNotification`
delivery was not exercised: triggering it would sleep the Mac. Delivery ordering
relative to sleep and to Node's timers after wake was therefore not observed
live. The deterministic tests in `test/operations/power.test.ts` and
`test/operations/power-service.test.ts` cover the invalidation, failure, recovery
and cleanup behaviour.

## Remaining freshness limit

A will-sleep notification closes the window only if Node reads the listener's
line before the system suspends. After wake, the listener's wake line races
Node's own timers. An admission that runs in that interval, with an observation
younger than 15 s, still depends on the next poll's `pmset` history and kernel
sleep/wake check to reconcile.
