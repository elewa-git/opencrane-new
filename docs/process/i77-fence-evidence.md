# Live view checks while chat activity arrives

**Status: PARTIAL.** Focused source checks passed on the earlier branch. The full
root checks were partial, and fresh-install live qualification was not run. The
review fixes and their checks are recorded below.

## What the change does

The server checks the member, conversation and desktop grant event streams before
it extends a live-view lease. A final check can find new chat activity after those
reads. That result is unconfirmed, so it earns no lease. The next check starts
250 ms later and reads the new events itself. A real access removal still closes
the view with 4003 and `access_changed`.

The server also checks team membership. IAM is the service that copies team changes
into OpenFGA, the permissions service. A team check that IAM has not applied is
unconfirmed when the event stream shows the member in the team. Another confirmed
team grant can still support the view. A removed silo member remains a denial.

A lease lasts at most 1,500 ms from the start of its successful check. A successful
check handled after 1,200 ms earns no lease. A check after a revocation denies it
only if the check finishes within 1,200 ms. If it finishes later or stays
unavailable, the lease still stops desktop bytes by R + 1,500 ms, where R is the
time the revocation was stored. The existing 4503 close follows ten seconds without
a lease.

## Measured source results

The earlier failing-first run on `38345bc` had 24 failures and 8 passes out of
32 activity cases, with product code unchanged. Twenty activity cases failed as
expected. Four final-read revocation cases also failed their new unavailable-record
assertion; their close code, reason, audit and two-second checks passed. The other
eight guards and message checks passed.

The earlier branch run passed all 32 activity cases three times in a row. Across
those runs, measured revocation closes were 11–281 ms. A separate parallel run
passed 53 tests across the activity, delays and unavailable suites. These results
belong to the earlier branch state; the review-fix checks are listed separately.

| Revocation | Main (ms) | Branch run 1 (ms) | Branch run 2 (ms) | Branch run 3 (ms) |
| --- | ---: | ---: | ---: | ---: |
| Alice leaves the team | 10 | 171 | 157 | 219 |
| `grant.revoked` at starting head | 11 | 11 | 16 | 18 |
| `grant.revoked` at last conversation read | 12 | 236 | 209 | 197 |
| `participant.removed` at starting head | 24 | 223 | 206 | 162 |
| `participant.removed` at last conversation read | 9 | 215 | 152 | 169 |
| `conversation.closed` at starting head | 18 | 241 | 207 | 187 |
| `conversation.closed` at last conversation read | 15 | 168 | 196 | 189 |
| `member.removed` at starting head | 29 | 244 | 219 | 247 |
| `member.removed` at last conversation read | 20 | 250 | 265 | 191 |
| Grant revoked during continuous activity | not measured | 218 | 140 | 281 |

The earlier root run on `38345bc` was PARTIAL: 1,637 tests passed and 15 were
skipped, while the gateway suite missed NATS heartbeats. Its single-worker retry
passed 80 tests and skipped one opt-in case. The later root run on `8b04883` was
also PARTIAL: 1,718 passed, one failed and 15 were skipped. The failure was a
Chromium status wait in `apps/server/test/integrations.test.ts`; its isolated
single-worker retry passed. Those retries do not change the root results.

## Review-fix checks

The rebase onto `origin/main` completed at `1c75567`. The updated activity suite
passed 35 tests in each of three consecutive runs. The four other requested suites
passed 75 tests. Lint, typecheck and the event catalogue check also passed; the
catalogue contains 95 matching event types.

The unapplied team join test waited two seconds, observed a paused notice, found no
valid notice after 1,500 ms, and found an unavailable `lease_check` at the
`authorisation` boundary. It then applied the join and observed a valid notice. The
plain-error freshness test closed with 4003 and `access_changed`. In a scratch copy,
MA made the team test fail because no paused notice arrived. MF made the plain-error
test fail because the view closed with 4503 instead of 4003. No full root suite or
fresh-install live qualification was run.

## Remaining scope

Model and MCP decisions still use their separate access checks, so their false
refusals remain possible. The shared freshness check still matches the exact
`Authority changed` message. The decision audit row is still written before the
last freshness check in `libs/models/src/decision.ts`. Screenshot capture during
a busy turn can still answer 503 Retry. Fresh-install live qualification was not
run; its results are recorded in [i77-live-view.md](i77-live-view.md).
