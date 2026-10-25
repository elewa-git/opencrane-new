# Quorum loss and recovery

Date: 25 October 2026. Source: `fe0f43f7c8dead2c34e3816bd2dc33f2c986adf0`,
based on `f85834091`. Test-first commit: `9ebff5028`. Branch: `work/p5-5-pr2`.
Part of #15. This receipt covers local test processes, not a packaged install.
Environment: Linux x86_64, Node 22.23.3, NATS 2.15.0. Each test starts fresh
fixture storage; the recovery step retains that storage.

The fixture starts three owned NATS processes with TLS routes, client certificates
and existing account permissions. It provisions EVENTS once with three replicas.
It stops the stream leader and another owned peer, then restarts those same peers
with the same storage. It never recreates EVENTS, changes replicas or resets
positions. No dev stack, model call, second daemon or host-network change is used.

The checker tests were committed first. Their initial run had three failures
because the quorum-outcome checker did not exist; the other 17 tests passed.
The added corruption cases isolate missing records, contiguous duplicates and
changed or missing acknowledgement metadata. Existing reordered-history cases
remain in place.

The integration test records acknowledged identities and positions before loss.
It starts a racing append, arranges to drop any saved reply and cancels retries,
retaining an unavailable result. With one peer running, a bounded append must
also return unavailable. Neither result is labelled absent. The surviving client's
check for three current copies must fail.

After recovery, acknowledged history and subject positions must agree. Both
uncertain requests are resolved with their original command identities and
expected positions. Repeating a request, including with a different event id,
must preserve the saved receipt and history. A stale expected position is refused.
A lost reply after recovery must also cause only one saved event. Both returning
peers must report the complete message count and sequence range from their own
monitors. Their client reads must match the final identities, order and positions.

Only fixture identities, positions, counts and statuses enter annotations.
No event or API fields are added. The exact `RISKY_FIELD_NAME` expression and its
approved `commandId` exception were checked. The security and authority test files
are unchanged. Cleanup removes only owned fixture resources and preserves the
original test failure if cleanup also fails.

| Check | Result |
| --- | --- |
| Clean `npm ci`; requested tool symlinks | PASS |
| Failing-first checker run, 3 expected failures / 17 passes | PASS |
| Final changed tests twice, 21 tests each | PASS |
| Extra existing leader-loss regression | FAIL — no leader within ten seconds |
| Event security rules, 438 cases | PASS |
| Full typecheck and final package typecheck | PASS |
| Final focused lint | PASS |
| Event catalogue, 154 event types | PASS |
| Full lint, knip, changelog | PASS |
| Owned processes and cluster directories removed | PASS — none remain |
| Zones and independent physical failure domains | NOT RUN |
| Kubernetes node loss and PVC recovery | NOT RUN — waits for p5-4-pr4/live1 |
| Backup survival | NOT RUN |
| Packaged recovery on a fresh install | NOT RUN — waits for p5-4-pr4/live1 |

The existing leader-loss test passed in two earlier 23-test batches. In the last
combined batch it failed because the stream reported no leader within its
ten-second wait. The other 22 tests passed, including all 21 changed tests. After
fixing the test fixtures' lint issues, two final runs selected only the changed
files. Each passed all 21 tests. The extra regression remains FAIL; it is not part
of a source-ready claim.

Checks run under `nice -n 10`. No full root suite is run. Test output stays in
temporary local files; [check results](checks.txt) retain counts and the failure.
Passing process tests do not establish packaged recovery or independent failure
domains.
