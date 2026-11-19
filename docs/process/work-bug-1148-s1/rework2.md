# Long-conversation decisions: second fix round

Date: 19 November 2026 UTC. Branch: `work/bug-1148-s1`.
This records the builder's own checks. No independent review result is claimed.
The PR remains a draft.

Receipt snapshot: 21:40 UTC. Local source checks: PASS. Live qualification: FAIL.
The first fresh run passed CORE at both widths but failed during long-chat setup.
The next fresh run is NOT RUN because the required free-slot and load interval
has not completed. Hosted CI results are recorded below and in the PR rollup.

## Rebase and retained fixes

Fetched origin and completed the rebase onto
`f316313f0265e5678c49fc1dcf2c03cbcc3d17d2`.
A later fetch confirmed main had not moved.
The fail-closed index, offline replay and 64-position lag bound from the
[first fix round](rework1.md) remain in place.

| Review finding | Work in this round |
| --- | --- |
| 1 — incomplete index | Retained the contiguous-prefix and independent coverage checks, and the deleted-stop, terminal-turn and conversation-close regressions. |
| 2 — replay cannot create the index | Retained shared table creation, old-install upgrade and repeated replay coverage. The release note still requires stopped readers and workers during offline replay. |
| 3 — unbounded lag and cost | Retained bounded catch-up. Reproduced the unchanged many-models failure and identified its failing confirmation read; see below. |
| 4 — missing live approval proof | Replaced the old loopback publication setup with the existing guarded TLS launcher, real discovery, exact review, the current publication command and matching acknowledgement. The first fresh CORE passed at both widths; the focused seed failed before publication. Another fresh run is pending. |
| 5 — moved whole-stream fallback | Kept the corrected baseline and the existing fallback in its owning approval module. `lint:reads` passes: 308 known reads and five rebuild reads. |
| 6 — insensitive guards | Retained isolated malformed/missing creation and turn cases. Corrected the child-origin interceptor and isolated conversation ownership in the foreign approval fixture. Individual requester, conversation and source-id removals fail their tests. |
| 7 — reply batching | Retained the shared inclusion rule and comparison of individually applied and batched reply events. |

The unchanged round-1 replay and integrity cases are not claimed as new runs here.
Their original evidence remains in the first receipt; hosted CI runs them again.

## Red CI approval and child-origin cases

The approval loader read conversation facts before the HTTP command checked the
saved approval's requester and conversation. The new fail-closed index correctly
rejected the missing foreign conversation, but that produced 503 before the route
could return the required indistinguishable 403 refusal.

The server now checks ownership in its existing first approval read, before loading
conversation facts or preparing cancellation. A test commit precedes the fix.
The foreign-chat fixture uses the authorised requester, so a requester mismatch cannot
hide a missing conversation check. The original response and unchanged-history
assertions remain intact; a new assertion also forbids foreign conversation reads.

The child-origin interceptor previously corrupted every parent read starting after
position one. Cached creation validation now also uses such a read. It was therefore
corrupting access evidence as well as the source message. The interceptor now selects
the exact saved source position and preserves all read arguments. It asserts that the
source was intercepted. Every original refusal, privacy and no-write assertion stays.

The original targeted run reproduced both approval failures and five source cases.
After the fix, all eight selected cases passed. The complete server files then passed:
101 tests passed and one existing real-provider case was skipped.
Both ownership cases passed twice after isolating conversation ownership.

Removing requester matching fails the missing/inaccessible refusal test. Removing
conversation matching fails the isolated foreign-chat test at 503 versus 403.
Removing the child source-id check fails at linked versus restricted. Normal guards
were restored; the ownership probes used test-only in-memory transforms.

## Rebase clock compatibility and dependency check

The summary-prefix fixture needed the clock required by main's event-store contract.
Its existing test first failed with an undefined clock. The fixture now supplies the
standard clock without changing an assertion.

A new background catch-up test first failed because the wait used wall time against
a selected manual clock. Catch-up now uses `store.clock.now()` and retains its original
ten-second bound. The caller's two-second decision limit stays unchanged.

The PostgreSQL adapter measures deadlines with `performance.now()`. The new reader
was passing a deadline from the store's clock unchanged. A deterministic regression
places the store clock ten seconds behind; it first failed with
`QueryDeadlineExceeded`. The reader now translates the remaining budget once at the
database boundary. All lookup queries share that deadline. Event reads keep the
original store-clock deadline. For the standard clock, the translated deadline is equal
or earlier. The five clock cases passed twice after this fix, including main's
unchanged manual decision admission and expiry assertions.

The first hosted `checks` job also reproduced a dependency cycle between the reader
and catch-up modules. The local dependency check failed for that same cycle.
Catch-up now receives only the conversation id and captured position; it no longer
imports the reader's request type. Both dependency graphs pass, with the same baseline.

## Many-models 503 evidence

The unchanged 28-case cost suite reproduced the earlier result: 27 passed and the
many-models case failed at its existing 200 assertion. Isolated diagnostics reproduced
503 for the first model too. Assertions and deadlines were unchanged.

Test-only instrumentation recorded these stages in one reproduction:

| Stage reached | Elapsed time |
| --- | ---: |
| Conversation facts checked | 176 ms |
| Model grants loaded | 243 ms |
| Access and budget work started | 262 ms |
| Refused with event-store timeout | 3,495 ms |

The timeout's captured caller is `managedProviderCallsEnabled` during
`decisionActivity.confirm`, reached through `confirmDecisionAccess`.
The selected conversation creation read returned one row; the warmed model-grant
read returned zero later rows. The request expired while waiting to confirm the
provider-enabled budget summary, after the conversation and grant reads finished.
The original two-second bound refused it. The probes establish the failing wait;
they do not establish why that host read was late.

The host's one-minute load was roughly 13–20 during the early reproductions.
One diagnostic also failed during the fixture's 18,000 concurrent seed publishes,
before any decision. A test-only batched-seed experiment still reproduced the decision
timeout, so no seed change was retained. No retry, sleep, catch or longer deadline was
added to product code or used to turn these failures into passes.

A later broad repeated run passed 108 cases, failed the existing concurrent
approval-use case, and skipped one existing case. That case had no 200 winner.
Its unchanged isolated diagnostic passed; that repeat does not explain the failed
broad run. Both results remain recorded. The final broad run then passed 110 tests and skipped
one existing real-provider case. The unchanged cost suite passed all 28 cases in
219.73 seconds, run sequentially after the broad group. The earlier failures are not
relabelled as passes.

## Additional CI regressions

Hosted CI reproduced a cached-creation incompatibility in takeover. The creation-only
reader rejected the second access read because main now starts it at the saved global
position. A new test first failed with `Unexpected history read`. The reader now accepts
position one or exactly the captured creation position, validates the upper position,
and still refuses other positions and close-inclusive reads.

The managed-process test started against an unrelated empty database. It now uses its
fixture's populated projection database. Its response, provider custody and reload
assertions are unchanged; the selected case passes.

The memory backend and gateway fixture shared one Query object. Backend no-query probes
therefore observed the new gateway index reads. Separate handles now match the real
process boundary. A new regression first observed the index queries. The original memory
assertions remain unchanged.

The projection fixture also shared the backend's EventStore object. New projection
position reads triggered the final-read removal mutation too early, during a full
member read. Test-only error diagnostics identified the original greater-than-one
assertion, followed by the safe memory refusal. A new regression reproduced the
cross-role global-position read. A separate projection store retains the same connection
and clock. The unchanged member-removal priority case now passes.

The last shard at `3ce51c263` still found three memory cases failing: two backend
no-query assertions saw a projection checkpoint query, and the original-capability
revocation case hit its unchanged 30-second timeout. The projection runner still
shared the backend's Query and lock object. Its injected append re-entered the mocked
backend lock through projection catch-up. Added query and lock assertions to the
boundary test; it and all three original cases failed locally before the fix. The
projection runner now uses a separate database handle, keeping the same pool and clock.
All five selected boundary and memory cases passed twice afterwards. No memory assertion
or timeout changed. The corrected source was pushed at `aed44a139`.

CI's explicit Node test list omitted the new raw-byte recorder test. The existing
coverage test failed for that missing path. Added the test to the command; the check
passed twice. No test exclusion was added.

All application and fixture test jobs then passed at `aed44a139`. The aggregate
file-coverage check refused the new seeded-history test because its imported browser
helper requires the browser fixture job. Added a regression that failed for that
missing assignment, then added the file to the existing job list. The classifier and
coverage checker remain unchanged. All 12 grouping checks passed twice afterwards.

Before that last fixture correction, all 175 tests in the expanded control,
managed-process, memory initial-delivery and boundary group passed. The 18 changed control, process and boundary cases then passed
again. The later driver cleanup also uses typed response guards and shared event and
policy schemas; all newly written driver files pass typed ESLint with the existing
rules, using the dev-stack TypeScript project for files normally ignored by root lint.

## Fresh-stack qualification

The [journey receipt](journey.md) records the attempts and remaining live conditions.
Before the first claim, both secondary slots were free, no package stack was up, and
one-minute load stayed below six for 328 seconds, sampled every 30 seconds.
Slot 1 was claimed and started with `up.sh --fresh` at 20:02 UTC, at source
`0e089c95aa1db43ca2f46a7c69c1b2c3a2d5f038`.

CORE passed at 390 and 1280 pixels, including browser chat, reload, Stop, uploads,
live-view access and revocation. The existing guarded TLS launcher then became ready.
The focused journey failed while waiting for seeded history to reach the conversation
projection, before discovery, publication or approval. The retained worker log shows
successful seed processing without a handler error, but lacks checkpoint values needed
to explain the wait. Added batch progress and expected/observed checkpoint diagnostics.
No deadline was increased and this failure is not claimed as fixed.

Startup and service logs and screenshots were copied before teardown. The final status
was free. No paid provider call was made. A later secondary claim first prevented another journey. Both slots became free
again, but load has repeatedly exceeded six before completing the five-minute interval.
The next attempt remains NOT RUN while that condition is unmet.

The prepared driver uses the existing free Stage B stub for a native browser prompt,
approval and returned tool result before the exact-byte checks. It registers the demo
tool through TLS, discovers its real
definitions, reviews them and waits for acknowledgement of the current publication.
It preserves exact forwarded bytes, one use, reload and denied-call checks. Independent
readback checks the demo's effect count. Each approval decision must succeed with one
submission. A normal browser chat turn then requests and approves a second exact tool call.
After browser Stop, sending those same approved bytes must return 403 with no
additional upstream effect. This prevents the Ask policy alone explaining the refusal.

The 3,000 earlier messages each have a matching completion event, keeping seeded history
out of the bridge's waiting work. A real-NATS regression first observed an unfinished
turn, then passed twice after this fixture correction. All state is seeded as events.

## Own gates so far

| Check | Result |
| --- | --- |
| Changed approval and source cases | Final broad group: 110 PASS, one existing skip; earlier failed repeat recorded above |
| Clock regressions and unchanged manual-clock decisions | PASS twice after the clock-origin fix |
| Guarded TLS and exact recorder tests | PASS twice, 12 cases per run |
| Full typecheck | PASS again after the additional CI fixes; affected driver typecheck repeated after cleanup |
| Events | PASS, 174 types |
| Knip | PASS, two existing configuration hints |
| Scoped ESLint, changelog, whole-stream reads and dependency check | PASS |
| Markdown and both privacy scans | PASS before the source push; repeat before the final push |
| Hosted CI | All checks and test jobs PASS at `aed44a139`; aggregate FAIL for missing fixture assignment, now fixed. See the PR rollup for the corrected head |
| Fresh browser approval and Stop journey | FAIL during seed setup; approval and long-chat Stop NOT RUN |
| Full root suite, paid-provider qualification and independent review pass two | NOT RUN |

Reused the saved tool-review helper and the existing TLS demo transport, shared the
computer-pass fixture helper, and removed the reverse dependency instead of adding a
new type module or dependency. No access, money or memory check, existing assertion,
event field rule or size limit was relaxed. No new dependency or product event/API
field was introduced.

Application/library source and read-baseline diff: 747 changed lines (608 added,
139 deleted). Development-stack journey fixtures: 647 changed lines. Tests and
documents are separate from those application/library counts. No size cap was raised.
