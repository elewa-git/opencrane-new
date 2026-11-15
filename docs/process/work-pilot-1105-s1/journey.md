# Personal key assistant choices

Journey on a fresh dev stack: PASS

Date: 15 November 2026. Tested source: `49a387171`.
Base: `0a8bda6e8`. Slice 1 of 1 of #1105; board rework round 1 of 2.
The earlier receipt confused two attempts inside the build task with delivery-rule
rework rounds. The delivery allowance was not exhausted.

## Fresh stack and scope

Claimed secondary slot 1 through `infra/dev-stack/claim.sh`, then ran
`infra/dev-stack/up.sh --fresh` and `infra/dev-stack/status.sh`.
Used the real sign-in, server, models process, native computer, PostgreSQL,
NATS and OpenFGA. The guarded Stage B local TLS transport used `apps/demo-mcp`
in credential-checked mode with the free model stand-in. No provider or supplier
account was contacted. Secret files were referenced by path only.
Waited while the one-minute load was above 10 before claiming a stack, starting
the browser phases and taking each recorded browser action.
No test batch ran during live qualification. Cleanup always used `down.sh`.

The admin installed the demo in the browser, allowed `read_fixture_quote` and
`who_am_i`, chose “Needs a personal key”, selected `who_am_i` as the identity tool,
granted the member and their personal assistant and published the reviewed tools.
Discovery and publication were confirmed through normal status reads. The write
tool stayed blocked. The unchanged catalogue and audience were saved before publication.

## Browser steps

Repeated the full journey through Playwright at 1280 × 900 and 390 × 844.
Used keyboard Space for desktop consent changes and clicks for phone changes.
Confirmed each selection reply and the resulting checkbox value.

| Step | 1280 px | 390 px |
| --- | --- | --- |
| Save, verify and choose the member’s synthetic key | PASS | PASS |
| See own assistant checked and shared assistant unchecked | PASS | PASS |
| Complete a live read as the verified synthetic account | PASS | PASS |
| Switch own assistant off through one selection append | PASS | PASS |
| Complete the refused turn with a working My tools link | PASS | PASS |
| See neither account identifier nor key in the refusal | PASS | PASS |
| Follow the link and switch own assistant back on | PASS | PASS |
| Complete a live read again as the same synthetic account | PASS | PASS |
| Read saved choices, releases and dispatch records | PASS | PASS |

## Saved records

The [collector](collect-choices.mjs) reads `connection-*` and filters
`connection.selected` by integration. It uses a supported category wildcard.
The regression test reproduced `Invalid entity subject` with the earlier
`connection-selection-*` query before the collector was fixed.

[Saved-event readback](release-readback.json) contains the choices, releases,
off-period counts and observed profile-list statuses. The browser
[observations](observations.json) retain the conversation references.

| Width | Releases while off | Dispatches while off | Restored releases | Lifetime |
| --- | --- | --- | --- | --- |
| 1280 px | 0 | 0 | 1 | 30000 ms |
| 390 px | 0 | 0 | 1 | 30000 ms |

The off interval runs from the saved off selection to the saved on selection.
The refused conversations also have zero matching releases and dispatches.
Each restored release uses the enabled selection revision exactly.

| Choice | Conditional expected position | Saved position | Allowed assistants |
| --- | --- | --- | --- |
| 1280 px: Select key | 0 | 460 | Own assistant by default |
| 1280 px: Assistant off | 460 | 503 | None |
| 1280 px: Assistant on | 503 | 522 | Own assistant |
| 390 px: Select key | 522 | 550 | Own assistant |
| 390 px: Assistant off | 550 | 592 | None |
| 390 px: Assistant on | 592 | 611 | Own assistant |

All 10 observed profile-list replies were HTTP 200.
Confirmed consent screens showed no refresh warning.
The largest recorded pre-action load was 9.37.

## Cleanup

The cleanup trap saved diagnostic records and private logs, then ran
`infra/dev-stack/down.sh`, status 0. The claimed secondary slot subsequently
reported `free`. No stack remains claimed for this work.

## Screenshots

Viewed all 16 captures before publication. Password inputs were empty at capture;
email text was masked. Both widths fitted without horizontal document overflow.
The phone My tools page scrolls vertically through the two saved profiles.

| State | 1280 px | 390 px |
| --- | --- | --- |
| Admin review | [Review](review-1280.png) | [Review](review-390.png) |
| Publication confirmed | [Published](published-1280.png) | [Published](published-390.png) |
| Defaults in My tools | [Defaults](my-tools-default-1280.png) | [Defaults](my-tools-default-390.png) |
| Live tool before disabling | [Tool](tool-before-1280.png) | [Tool](tool-before-390.png) |
| Own assistant off | [Off](my-tools-off-1280.png) | [Off](my-tools-off-390.png) |
| Chat refusal and My tools link | [Refusal](chat-refusal-1280.png) | [Refusal](chat-refusal-390.png) |
| Own assistant restored | [On](my-tools-on-1280.png) | [On](my-tools-on-390.png) |
| Live tool restored | [Tool](tool-restored-1280.png) | [Tool](tool-restored-390.png) |

## Source checks

All tests, lint, typecheck and builds ran under `nice -n 10`. Backend tests used
the shared disposable PostgreSQL fixture and at most two workers. No full root
suite or competing test batch ran during live qualification.

| Check | Result |
| --- | --- |
| Affected backend suites, first run | PASS: 13 files, 360 tests, 214.38 s |
| Affected backend suites, repeat | PASS: 13 files, 360 tests, 172.69 s |
| Final critical backend suites, first run | PASS: 5 files, 52 tests, 67.05 s |
| Final critical backend suites, repeat | PASS: 5 files, 52 tests, 63.39 s |
| Affected web suites, first final run | PASS: 4 files, 25 tests, 8.64 s |
| Affected web suites, final repeat | PASS: 4 files, 25 tests, 7.76 s |
| Workspace, package and dev-stack typecheck | PASS |
| Event catalogue check | PASS: 174 event types |
| Knip | PASS; two existing configuration hints |
| ESLint on changed code | PASS: no warnings |
| Changelog lint | PASS |
| Markdown lint | PASS |
| Web production build | PASS; existing Mermaid, CSS budget and CommonJS warnings |
| Lint debt check | PASS |
| Dependency direction, cycles and baseline | PASS; no new violations |

The backend batches include credential-broker, connection-selection, selection-fold,
OAuth-selection, company-selection, MCP-personal-concurrency, personal-key-consent,
personal-key-dispatch, personal-key-turn, personal-key-notice,
connection-selection-HTTP, turn-tools and the journey collector suites.
The web batch includes key-assistants, My tools, personal-key and
personal-connection-notice suites. These are focused checks, not a full root suite.

### Test-first and refusal evidence

- `163c527d0` reproduced the profile refresh warning with the inventory fixture
  paused after its initial page. The fix saves off/on at revisions 8 and 9,
  retains editable confirmed choices and performs only the initial profile GET.
- `4307a02e2` reproduced the server’s 503 after selection alone with its profile
  already indexed and its projection paused. The reader now checks pending
  records for profile creation. A separate test still requires 503 for a missing
  indexed creation; current access checks are unchanged.
- `d2c32a918` reproduced `Invalid entity subject` in the real event store with
  the old collector wildcard. The supported category read now passes and filters
  out other integrations and non-selection records.
- `b30b500ba` pins current-revision call preparation and actual signed-turn
  selections before extraction. Removed the `personalToolContext` consent guard
  by hand: preparation resolved and its refusal test failed. Restored it.
  Separately removed the turn-credential consent filter: its own token assertion
  failed because the denied selection remained signed. Restored it. Both pass.
- `0f837097e` injected network, receipt-identity and schema failures in load,
  save and status checks. Each failed for its missing diagnostic. The handlers
  now emit fixed operation and cause categories before the public message.
  Assertions cover the complete diagnostic object and exclude private-data canaries.
- Preparation behaviour passed before extraction. After extraction, the same
  tests and real personal-key authorisation/dispatch test passed. `startDecision`
  is 292 counted lines against 307 before the PR; `decision.ts` is 533 against
  549. The reviewed version was 308 / 550. No size limit changed.

The unchanged 1,502-event history/list/socket probe passed twice with its
1,500 ms readiness assertion. A temporary stream-reader trace during the second
run asserted zero `connection-*` reads before readiness. Restored the probe
byte-for-byte afterwards. The added consent history reads therefore did not run
on that readiness path. The review's 1,601 ms observation was not reproduced;
its earlier timing cause remains unassigned. No timing workaround was added.

Shared the existing consent decision and strict selection schema, removed no
access, budget or memory check, and added no dependency. Confirmed consent now
updates locally; original receipt recovery reloads consent independently of the
inventory. Browser diagnostics never include exception messages, account fields
or response bodies. Moved personal-call preparation into its existing module.
Kept its shared type with personal account facts to avoid a dependency cycle; all three affected modules
emit identical JavaScript before and after that type-only move.
Shipped application/library code changed by 548 lines, excluding tests and documents.

## Earlier attempts and scope

The [earlier failed receipt](https://github.com/elewa-git/opencrane-new/blob/845af59eb767cb1cbf45b1bba35ffbd1aea14c11/docs/process/work-pilot-1105-s1/journey.md)
and [first-attempt receipt](first-attempt/receipt.md) retain the build-task failures.
The [first fresh rework attempt](rework-attempt-1.md) records the profile-list
failure before the reader fix. The [second attempt](rework-attempt-2.md) records
a completed phone turn without a quote, with host load above the required ceiling.
That turn remains failed and its exact cause remains unassigned. The final run
checks load before phases and actions, fails immediately on a completed wrong
answer and retains whitelisted saved records and private logs before teardown.
Those attempts did not exhaust the delivery-rule rework count. This repair is
board rework round 1 of 2. Their incomplete conditions remain failures in those
historical receipts; only the fresh run above qualifies the slice.

Shared-session execution, company-key changes and external supplier qualification
are outside this slice. CI results are reported on the draft PR after the push.
