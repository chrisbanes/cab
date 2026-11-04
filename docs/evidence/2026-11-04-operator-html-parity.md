# Remaining operator HTML parity packet

Status: T1/T2 qualified; rendered captures inspected; controller approval pending. This record does not authorize removal. No legacy route has
been removed in this candidate. `/app` remains the application location.

Base: `cee8e2a428b4e0bbfece51ef493c117333d62d65`, tree
`20b873ea8837b2c2a6e6a7cf3a1b5b5cc3ae8a5c`.
Source: cab#1420 Agent Brief, comment 6560600203. Approved implementation plan:
comment 6630596149, v2 revision 1, payload SHA-256
`763bd333af4c4ecd96fae03f0d4c601f5785e3abb410a43f93b9e1d4eef74022`.
Candidate file hashes and qualification logs belong to the controller delivery
record `/tmp/cab-project-drain-20261103/1420-delivery.md`.

## Fact and control dispositions

These mappings are supported by the qualified suites and inspected captures below.

| Legacy fact/control | Replacement or disposition | Source/test ownership |
| --- | --- | --- |
| Home project names and links | Settings projects, project Settings | `web/src/app.tsx`, project configuration browser suites |
| Home project paused/active state | Project Settings and project/task views | `web/src/project-config.tsx`, project general browser suite |
| Create project name | Settings → Create project | project configuration and setup suites |
| Create project lead, including unconfigured | Project creation/settings lead selection | `web/src/project-config.tsx`, project general browser suite |
| Exclude revoked profiles from lead selection | Current workspace/profile choices and server validation | project configuration/API tests |
| Home profile names, active/revoked | Settings profiles and profile Settings | `web/src/profile-config.tsx`, profile browser suite |
| Create profile name | Settings → Create profile | `operator-profile-config-browser.test.ts` Create profile |
| Create profile instructions | Create profile instructions | same suite; fixture-only private text masked in captures |
| Create profile capabilities | Create profile capabilities | same suite |
| Profile name | In-place Profile Settings | profile browser suite edit/restore/revoke |
| Profile instructions | Kept/Reveal and version-bound editing | profile browser suite reveal, navigation, conflicts |
| Profile capabilities | Profile Settings capabilities | profile browser suite |
| Profile revision | Current revision in Profile Settings | `profile-config.tsx` current revision |
| Profile active/revoked; restore | Profile Settings state and revoke/restore | profile browser suite edit/restore/revoke |
| Profile execution runtime | Profile Settings runtime selector and captured revision | profile browser suite Codex/Claude revisions |
| Empty projects/profiles | Settings empty lists/create entry points | Settings application; inspect empty-state captures |
| Unknown profile/errors | API/resource error display and retry | profile configuration/resource tests |
| Runtime unavailable alerts | Global application alert and Runtime settings status | `app.tsx`, `recovery.tsx`, runtime browser suite |
| Runtime available/not enabled states | Runtime settings runtime cards | runtime enablement tests |
| Effective execution policy lines and limits | RuntimePolicy for each runtime in Runtime settings; PolicyDisclosure in profile Settings | `recovery.tsx`, `execution-notice.tsx` |
| Policy not yet available | Explicit unavailable-policy explanation | `execution-notice.tsx` |
| Global capacity limit and current usage | Runtime settings introduction and capacity form | runtime recovery browser suite |
| Default per-project capacity | Runtime settings introduction | runtime recovery browser suite |
| Per-project effective limit and usage | Runtime settings project capacity rows | runtime recovery browser suite |
| Set global capacity | Receipted `capacity.configure` | runtime recovery browser suite; API/CLI capacity tests |
| Set/remove project override | Runtime settings override switch and limit | runtime recovery browser suite |
| Cross-project task/admission summary, project state and empty project task lists | Deliberately dropped as a separate summary; List/Board per-task waiting reasons and project views replace it | approved Agent Brief; task views |
| Sign in | Shell GET `/login`, API POST `/api/operator/login` | `operator-web-http.test.ts`, authentication browser suites |
| Sign out | App sign out, API POST `/api/operator/logout` | same session/API tests |
| Pre-login CSRF/session issuance | Shell/API session boundary only after removal | HTTP tests; removed-path no-cookie matrix belongs to T3 |
| Historical pre-turn adoption | `recovery.pre-turn.adopt`, CLI recovery | recovery options and CLI recovery tests |
| Pre-turn reconciliation | `recovery.pre-turn.recover`, CLI recovery | same tests |
| Historical no-turn adoption | `recovery.no-turn.adopt`, CLI recovery | same tests |
| No-turn reconciliation | `recovery.no-turn.recover`, CLI recovery | same tests |
| Conversation replacement | `recovery.conversation.replace`, CLI recovery | same tests |
| Bound-turn eligibility and exact proof | Assignment Recovery, linked from task Execution and Runtime settings | `recovery.tsx`, `operator-runtime-recovery-browser.test.ts` |
| Bound-turn review/confirmation | React reconciliation dialog, exact identity and assertions | Chromium/WebKit bound-turn review test |
| Bound-turn cancellation and focus | Cancel keeps proof; dialog focus handling | same test |
| Bound-turn refusal | Frozen original request and receipt readback before retry | same test |
| Bound-turn lost reply | GET original operation by assignment/type/key, receipt match, no automatic resubmission | same test |
| Bound-turn stale/redacted/missing identity | Blocks proof transfer/submission; retains original evidence | runtime recovery browser identity test; recovery-options tests |
| Bound-turn archived project | GET evidence/original receipt retained; retry/write disabled | `operator-archived-recovery-browser.test.ts` |
| Independent Stop, pause, approval, delivery and execution holds | Recovery hold display and unchanged service enforcement | runtime recovery browser five-holds test; execution recovery tests |
| Legacy nav, advanced profile link, wrapper and styling | Remove after approval; normal app navigation owns destinations | T3; no removal yet |
| Legacy `/command` transport | Existing JSON commands/CLI; same domain keys and original receipts | T3 must seed old form payloads and prove replay; no compatibility policy change |

## Qualification and inspected evidence

Node 26.13.0 and npm 12.2.1; npm ci, typecheck, lint, format check and build
passed. Operator/execution all profiles: 2,589 passed, one skipped, zero failed
(374.26 seconds). Operations/operator service profile: 1,329 passed, 723 browser
cases skipped, zero failed (115.11 seconds). The skipped all-profile case is the
existing explicitly skipped test, not a replacement for required WebKit evidence.
Focused capture renewal ran four cases, all passing, with explicit
CAB_TEST_BROWSER_ENGINE=all (8.61 seconds). Final startup-order renewal ran all
five startup cases, passing. Final static checks also pass.

The production bundle is validated before service construction or start. Missing
and invalid bundle process tests exit nonzero, name npm run build:web and emit no
service-construction marker. The valid-bundle test asserts validation → construction
→ service-start order. Existing background-service cases start the real operator
listener with a valid production bundle and preserve signal/fatal-shutdown rules;
serve and other service behavior remain qualified by the service suite.

All browser evidence uses disposable local fixtures, synthetic names/identities and
fake runtimes. Settings capture helpers mask private textareas, paths, queries and
private-marked values. The implementation owner inspected the selected captures:
project/profile create/edit, revoked profile/revision, Codex policy and Claude
policy-unavailable state, capacity and expanded policy limits on desktop/phone,
empty navigation, login failure, signout pending, runtime unavailable, exact
bound-turn review in Chromium/WebKit, blocked/redacted proof, frozen lost-reply
original request, and archived GET-only original receipt absent/recorded in both
engines. No real private value was observed in the selected images. Synthetic
UUIDs, loopback origins and process proof labels are intentional fixture data.
No replacement gap was found. Existing advanced JSON/CLI recovery and original
receipt service tests passed in the affected suite; T3 will separately prove old
form command-key replay after transport removal.

The exact inspected capture manifest is
`/tmp/cab-project-drain-20261103/1420-qualification/parity-captures.json`.
Its SHA-256 is `cf126b567989bc197d6d9a793c1bf1c90879383d3d312f765ee13ee0ae7ddcdd`.
It records 29 exact PNG paths, per-file hashes, owning tests and inspection scope.
The following selected images resolve within the dedicated qualification directory;
full paths and hashes are in that manifest.

| Capture | Demonstrates |
| --- | --- |
| 1366-settings.png | Project/profile lists, paused and revoked states, create/edit entry points |
| 1366-profile-create.png; 390-profile-create-runtime.png | Creation fields, runtime and policy boundaries |
| 1366-profile-revoked.png; 390-profile.png | Version, revoke/restore and editable fields |
| 1366-project-general.png; 390-project.png | Name, lead and pause controls |
| 1366-setup-repository-free.png; 390-setup.png | Project creation and unconfigured lead |
| 390-empty.png | Empty project navigation with create destination |
| 1366-runtime-policy-limits.png; 390-runtime-policy-limits.png | Capacity usage/default/overrides, policy lines/limits and unavailable policy |
| 1366-runtime-unavailable.png | Runtime failure alert |
| desktop-signin.png; phone-signin-failed.png | Shell login and error state |
| desktop-account-menu-signing-out.png; phone-account-drawer.png | Logout entry points and pending outcome |
| 1366-bound-review-chromium.png; 390-bound-review-chromium.png | Exact review, Cancel/Confirm and preserved holds |
| 1366-bound-review-webkit.png; 390-bound-review-webkit.png | Same interaction on WebKit |
| 1366-bound-recovery-chromium.png; 390-bound-blocked.png | Unknown reply frozen request; refusal without proof transfer |
| 1366-archived-original-{absent,recorded}-{chromium,webkit}.png | GET receipt readback with writes/retries disabled |

Preserved failure logs record sandbox-denied loopback/process/cache access before
exact outside-sandbox retries. Ordinary fixture repairs changed localhost to the
supported 127.0.0.1 origin and migrated the obsolete post-start bundle-load timing
case to explicit pre-start ordering coverage; no production assertion was weakened.
An initial focused command used the wrong engine environment name and skipped
WebKit; the corrected four-case renewal above supersedes it. Full logs and source
identity accounting are in the delivery record. No full npm run check was run at
this pre-removal stage.

Fixture limits: fake runtimes and disposable SQLite cannot qualify actual model,
provider, installed service, host interruption, private access or final human
visual acceptance. No such effects are authorized here. Baseline CI run
41825516107 passed on tree-equivalent PR1504 head fd1f0d02859023abeed167c981f60577580c13ce;
it is neither an exact-base-SHA run nor new-candidate/WebKit evidence.

Approval: pending controller decision on this qualified and inspected packet. T3/T4 remain blocked; every legacy route and HTML helper is retained.
