# S04c authenticated operator foundation

This document covers the operator login, session and request boundary. The React
operator is served at `/app` with a public shell at `/login` and same-origin JSON
APIs. The validated web bundle is mandatory: operator startup checks it before
service construction/start and reports `operator web UI not built; run npm run build:web`
on missing or invalid input. Other service commands are unchanged. There is no
server-rendered fallback. This is the authentication contract, not release or
private-access acceptance; see [`SPEC.md`](../SPEC.md),
[`acceptance.md`](../acceptance.md) and [`ui02-foundation.md`](ui02-foundation.md).

## Login and session lifecycle

cab operator credentials are independent of the Codex App Server login.
`npm run operator-auth -- init ABSOLUTE_AUTH_FILE` prompts for the password
without echoing it or putting it in argv. Initialization writes a salted scrypt
verifier, not the password, into a new same-user regular file with mode `0600`.
The auth file must be an absolute path; opening rejects symlinks, an exposed or
foreign-owned file, an oversized file, and an unsupported format. Configuration
and initialization failures are generic and do not include credential material.

The `operator` command requires `CAB_OPERATOR_AUTH_FILE` and
`CAB_OPERATOR_ORIGIN`. The configured origin is canonical: loopback HTTP
is limited to `127.0.0.1`, and remote origins must use HTTPS. Sessions are
process-local, so service restart invalidates them. Login rotates the anonymous
session ID and CSRF token; logout deletes the session. Idle and absolute expiry,
bounded session storage and failed-login throttling are enforced in memory. Each
session is bound to its trusted browser origin; a request in another origin cannot
use, refresh or delete it or access its review drafts. Password verification,
throttling and session limits remain shared.
There is one operator password, not account or role administration.

## HTTP boundary

The server binds to `127.0.0.1` by default. An explicitly configured IPv4
address adds a listener on the same port. That listener accepts only its configured
HTTP Host; loopback accepts its numeric Host and an existing HTTPS proxy Host.
A proxy Host that equals the loopback Host is ambiguous: use a distinct HTTPS
proxy Host or disable LAN access. LAN-enabled contexts use distinct cookie names
so browsers can retain sessions on the same hostname across ports. It does not trust
`X-Forwarded-Host`, `X-Forwarded-Proto`
or other forwarded headers. Remote TLS termination and private routing are
provided by a separately managed transport such as a narrowly configured
Tailscale Serve route. The configured LAN HTTP listener carries passwords, cookies
and bearer tokens without TLS; enabling it requires explicit configuration.
Session-authenticated API POSTs, including `/api/operator/login`, require the exact
browser context's Origin and that session's CSRF token. Login uses the pre-login session;
other writes require authentication. JSON bodies and command-specific envelopes
are bounded and runtime validated. Bearer access retains its explicit route and
scope policy; it neither reads nor upgrades cookie sessions.

Responses use `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, frame/CSP
restrictions and `Referrer-Policy: same-origin`. The host-only session cookie is
`HttpOnly`, `SameSite=Strict` and `Secure` with HTTPS. The public shell loads no
private data. `/api/operator/session` creates the pre-login session; shell GETs and
unknown/retired paths do not mint cookies. Login rotates both ID and CSRF token;
logout and expiry purge private state. Failures disclose no exception, password,
credential reference or submitted value, and the adapter logs no request data.

## Routes and command ownership

`/` redirects to `/app` without reading or creating a session. `/runtime`,
`/profile/:id`, legacy POST `/login` and `/logout`, `/command`, capacity forms and
all recovery form POSTs return ordinary not-found without redirects or session
creation. The app remains at `/app`; moving it is separate scope. No route
registry, server HTML wrapper or form allowlist remains. Shared URL decoding still
rejects separators, dot segments and control characters.

React settings and task views submit the existing domain and coordination commands
through `/api/operator/commands`; CLI recovery remains supported. Original keys and
payloads recorded through retired forms still replay their immutable receipts
through JSON with no additional effect. Bound-turn Recovery retains review,
confirmation, cancellation, original-receipt GET readback and independent holds;
archived projects permit evidence/receipt GETs while disabling new sends/retries.

## Verification boundary

Service/auth and route tests use the real SQLite domain store and ephemeral
loopback and explicit non-loopback listeners. Chromium and WebKit exercise the LAN
login, comment, keyboard, notification and session-restart paths on the fixture
host; a disposable HTTPS proxy checks independent cookies on the same hostname.
Other journeys cover exact Origin, CSRF, cookie attributes, rotation/logout/expiry
and React controls. Browser engines are test-only dependencies. Full discovery
excludes stale compiled tests and runs each remaining source test exactly once.

Same-host LAN and loopback tests do not prove private remote access from another device. A separate bounded
Serve proof must record the installed Tailscale version, exact disposable node
and peer identities, actual `Host` behavior, private reachability, absence of
public exposure and exact cleanup. Do not claim Serve access as live-verified if
an approved disposable node/peer or safe cleanup path is unavailable. This
proof does not authorize deployment, route replacement, persistent Serve
configuration or a cutover.

The opt-in second-peer browser proof is
[`test/operations/private-access-qualification/private-access.mjs`](../../test/operations/private-access-qualification/private-access.mjs). Current
automated and unproved live evidence is recorded in
[`docs/evidence/s04c-operator-ui-2026-09-29.md`](../evidence/s04c-operator-ui-2026-09-29.md).
