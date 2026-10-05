# P4-4 direct chat backend evidence

5 October 2026. Branch `work/p4-4-direct-chats`, based on main
`d4b62b26fbaf9faa1db392326ce1f91833b0e1da`. This implements the non-visual
contract of [#86](https://github.com/elewa-git/opencrane-new/issues/86), D06 and
[THR API binding](../api/direct-chats.md). Environment: Linux, Node 22.23.3,
clean `npm ci`, disposable service fixtures rather than an installed silo.
No dependency was added.

Confirmed seams: chat command, authenticated HTTP, position-based WebSocket,
conversation replay, OpenFGA replay and bridge admission/dispatch. Tests use
normal disposable NATS, PostgreSQL and OpenFGA fixtures. Red/green runs exposed
missing direct creation, socket removal checking, protocol mode validation and
projection immutability before implementing those behaviours.

Independent review: **PARTIAL** for the final diff. Two passes using a different
model returned **PASS** on the earlier diff. Pass one
found lifecycle assumptions about mandatory assistants, false access refusals
when a colleague posts during a read, and a list-response revocation race. All
three have red/green regressions and passed fix verification. Subsequent builder
regressions found that accepting message posts in work-authority fences could
forward cancelled approved work, that content lag could report a computer
starting for a direct chat, and that a creation retry failed after the colleague
left the silo. All three were red before their fixes and green after. Creation
retries check the active caller and original payload; colleague admission still
precedes every new append. Post-append reconciliation retains the same deadline.
Message tolerance now belongs only to `conversationAccessFence`; work authority
keeps its strict fence. HTTP and realtime use the mode already read from the
event store. All six targeted late/race regressions pass. These final changes
await owner verification under the two-pass limit in
[the engineering standard](standards.md#work-and-review); no third independent
pass was started. Existing browser/unit fixtures supply valid legacy creation
records; production validation is unchanged.

Full root suite uses
`PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres` and
`nice -n 10 npm test -- --maxWorkers=2`. Every full root run starts after integer
load falls below 16. The initial root run started at load 8 and was **PARTIAL**:
stopped after an obsolete direct-with-assistant upload fixture, a gateway revocation failure and
three race regressions loaded against the earlier overlay. The fixture now
records two people; focused upload, gateway and final-overlay race reruns pass.
The first complete rerun started at integer load 11 and was **FAIL**: 98 files /
1,534 tests passed, four files / 15 tests skipped, and two Chromium tests failed.
Both used an empty creation fixture rejected by the new mode validation.
After supplying valid legacy creation records, Chromium passes all three tests
and Angular passes 16 files / 109 tests. The final all-workspace typecheck passes.
The next full rerun started at integer load 15 and was **FAIL**: 98 files /
1,535 tests passed, four files / 15 tests skipped, and one existing slow-authority
desktop test observed a closed socket instead of an open socket. That test
passes in isolation with its injected delays and production deadlines unchanged.
The following run started at integer load 10 and was **FAIL**: 98 files /
1,535 tests passed, four files / 15 tests skipped, and the existing approval-card
test received 403 during a concurrent decision read. It passes in isolation.
The following full rerun, including the fence and mode regressions, started at
integer load 9 and was **FAIL**: 94 files / 1,532 tests passed, four files /
15 tests skipped, and six tests failed. Failures were a direct-history cleanup
error, NATS fixture setup timeout, two real-process startup failures, an IAM
receipt check in the volume benchmark and the pinned-model matrix test timeout.
The history cleanup tried to resume OpenFGA before it had paused, masking an
earlier failure; it now tracks the pause and always closes its fixture. A focused
rerun revealed a 503 during one of 101 HTTP setup sends under load, before paging
ran. The paging fixture now uses the confirmed command seam to seed its history;
HTTP send admission has separate coverage. Paging and unavailable-IAM assertions
remain unchanged. This run does not establish a green root gate. Lint, typecheck
and the event catalogue passed for the fence/mode fixes. Final focused verification
passes all four direct/legacy chat files and 20 tests, including the creation
retry, paging and unavailable-IAM cases. Final lint, all-workspace typecheck and
`check:events` are **PASS**; all 86 catalogue types agree. The final root run
started at integer load 14 and was **FAIL**: 96 files / 1,534 tests passed,
four files / 15 tests skipped, three files / four tests failed, in 2,092 seconds.
All direct-chat tests passed in this run. Failures were the authority-volume
timing margin, a model-grant migration subprocess failure, a fixture append
conflict during gateway revocation and the existing slow-authority desktop
socket check. The volume benchmark's unseeded model p95 was 1,156 ms against a
1,000 ms margin; seeded authority event counts remained constant. Timing
assertions are unchanged. The targeted rerun is **PASS**: three files / all
four cases passed, with 93 other cases filtered out, in 82 seconds. No
production or test timing bounds were changed.
The full gate remains **FAIL** regardless of isolated results; this branch is
not source ready and its PR remains draft.

Fresh-install live qualification, Claude Design desktop/390px screens and UI
foundation integration: **NOT RUN**, deferred as requested. No owner stack,
Docker daemon settings or secondary dev stack was changed. This receipt makes
no complete capability, final independent-review or recipient-read/delivery claim.
