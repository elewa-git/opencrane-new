# Personal key assistant choices

Journey on a fresh dev stack: FAIL

Date: 15 November 2026. Tested source: `3876b11849572744b38d968d95b9fe9f9736e155`.
Base: `c3083b840`. Both browser journeys completed, but the final saved-event
verification failed in the collector. This receipt does not qualify the slice for merge.

## Fresh stack and scope

Claimed secondary slot 1 through `infra/dev-stack/claim.sh`. Ran
`infra/dev-stack/up.sh --fresh` and `infra/dev-stack/status.sh`; both passed.
Used the slot's real sign-in, server, models process, native computer, PostgreSQL,
NATS and OpenFGA. Used the existing guarded Stage B local TLS transport with
`apps/demo-mcp` in credential-checked mode and the free model stand-in.
No provider or supplier account was contacted. No product source, guard or deadline
was changed during qualification.

The admin installed the demo through the browser, allowed `read_fixture_quote` and
`who_am_i`, chose “Needs a personal key”, selected `who_am_i` as the identity tool,
granted the member and their personal assistant, and published the reviewed tools.
Original discovery and publication were confirmed through the normal status reads.
The write tool stayed blocked. Saved the unchanged catalogue and audience before publishing.

## Browser steps

Repeated the following through Playwright from the installed dependencies, at
1280 × 900 and 390 × 844. Used keyboard Space for the desktop consent changes and
clicks for the phone changes. Waited for each selection reply and confirmed checkbox value.

| Step | 1280 px | 390 px |
| --- | --- | --- |
| Save, verify and choose the member's synthetic key | PASS | PASS |
| See own assistant checked and an available shared assistant unchecked | PASS | PASS |
| Complete a live read as the verified synthetic account | PASS | PASS |
| Switch own assistant off and receive a successful selection reply | PASS | PASS |
| Complete the next turn with the plain refusal and working My tools link | PASS | PASS |
| See no account identifier or key in the refusal | PASS | PASS |
| Follow the link and switch own assistant back on | PASS | PASS |
| Complete another live read as the same synthetic account | PASS | PASS |
| Inspect saved records for no release or dispatch in refused turns | FAIL | FAIL |

The refused chat replies showed no completed tool call. This browser observation
does not substitute for the incomplete saved-event checks.
[Browser observations](observations.json) retain the conversation identifiers and
the four confirmed consent revisions: 500, 519, 589 and 609.

The profile-list refresh returned 503 after consent changes. My tools showed its
refresh warning and retained the last loaded profiles while the confirmed consent
value changed. The subsequent refusal and restored calls completed. The cause of
the refresh failures remains unassigned; this receipt does not claim they are harmless.

## Screenshots

Viewed every screenshot before publication. Password inputs were empty at capture;
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

## Failure and cleanup

After both browser sequences, the collector attempted to read
`connection-selection-*`. The event-store reader accepts category wildcards such as
`connection-*`, not that subject. A direct call to the existing `wireSubject`
reproduced `Invalid entity subject`. The collector retained no completed release
readback receipt. No claim is made here about the actual release or dispatch counts,
conditional append chain or release lifetime in this fresh run.

[Failure step and response statuses](failure.json) and the
[last browser state](failure-390.png) preserve the failure. The earlier fresh attempt
also failed, during a phone checkbox assertion; its
[separate receipt](first-attempt/receipt.md) explains the collector correction.
That attempt's incomplete conditions remain NOT RUN.

Stopped after the two rework rounds. A corrected collector, a complete fresh journey
and investigation of the profile-list 503 responses remain for the owner to authorise.
The cleanup trap ran `infra/dev-stack/down.sh` after each attempt, both with status 0.
Both slots subsequently reported `free`. No stack remains claimed for this work.

## Source checks

All test, lint, typecheck and build commands ran under `nice -n 10`.
Backend runs used the shared disposable PostgreSQL fixture and at most two workers.
No full root suite or other test batch ran during the live qualification.

| Check on tested source | Result |
| --- | --- |
| Changed backend suites, first run | PASS: 12 files, 358 tests, 220.31 s |
| Changed backend suites, repeat | PASS: 12 files, 358 tests, 176.31 s |
| Full web suite | PASS: 84 files, 1,585 tests, 123.57 s |
| Directly affected web suites, repeat | PASS: 4 files, 21 tests, 6.58 s |
| Workspace, package and dev-stack typecheck | PASS |
| Event catalogue check | PASS: 174 event types |
| Knip | PASS; existing configuration hints only |
| ESLint on changed code | PASS: no warnings |
| Changelog lint | PASS |
| Markdown lint | PASS: 520 files, including both receipts |
| Web production build | PASS; existing Mermaid, CSS budget and CommonJS warnings |
| Lint debt check | PASS; six parameter suppressions removed |

The backend checks cover refusal at tool preparation and final release, old-event
defaults without rewriting events, an old-revision pass after a consent change,
owner-only writes including admin refusal, and one conditional selection append.
Web checks cover defaults, off/on saves, stale-profile conflicts, definite rejection,
unknown-save recovery and refreshing a previously failed list.

The first test commit, `6f881e605`, was seen failing because another assistant could
release a key when an old selection had no list. After implementation, deliberately
disabled the consent condition in the final release path by hand. The same broker
test failed because the promise resolved instead of refusing release. Restored the
original bytes, then ran the successful checks above.

An earlier broader test run reported 345 passes and one NATS “heartbeats missed”
fixture failure. Its cause remains unassigned. No retry, longer deadline or product
workaround was added; the final two backend runs above both passed.

Shared the consent decision between preparation and the existing final release path,
and shared the strict selection schema between protocol, server and model code.
Split tool-budget handling and related request values to keep functions at five
parameters or fewer. Reused and moved release fixture helpers instead of copying them.
Removed six obsolete parameter suppressions; raised no size limits and added no dependency.
Shipped code changed by 470 lines: 408 added and 62 deleted, excluding tests and documents.
