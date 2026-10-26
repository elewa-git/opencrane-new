# File recovery after interruption

Date: 26 October 2026. Base: `c0829cd0a`. Source: `6e080a6d2`.
Test-first commit: `83a2011d6`. Part of #15. Status: PARTIAL; verification: FAIL.
Merged prerequisites: #714 `a40ff12ef`, #728 `2607ab2e0`, #726 `548e8c8ad`,
object capture #733 `9e470b61e` and object restore #740 `c3e7ae2e2`.

The fixture acknowledges text and PNG uploads, exports, then interrupts a handler
upgrade after 256 events. Isolated restoration rebuilds files and rights twice,
compares full rows and bytes, and exercises existing HTTP list/view handlers.
Later activity/removal probes are outside the archived position. Effect guards
are exercised before resetting their counters. Uncertain restoration starts no
replay or read server. No restored budget actor or reaction worker starts.

## Checks

Environment: disposable NATS, MinIO and OpenFGA services, with PostgreSQL 17.6 in
`pgtest-p5-9-pr3` through its random loopback `PG_TEST_URL`. Checks use `nice -n 10`.
No full root suite, dev stack, model call or host-network change.
The initial missing module, duplicate fixture variable and missing human principal
were repaired. Removing comparison/checksum checks then caused ten expected assertion
failures; the implementation was restored. Tests corrupt real rows and stored bytes.

- PASS: `npm ci`, tool links, full `typecheck`, `check:events` (154 types) and changelog.
- PASS: first changed-case run, 15/15; file comparison cases passed repeatedly.
- FAIL: expanded run, 519/526: four handler test timeouts, two crash-barrier timeouts
  and one collection refusal. All 438 security cases and budget comparisons passed.
- FAIL: isolated repeat, 13/15: crash barrier and NATS read deadline. No further retry.
- PASS: full lint, including knip, documentation, links, licences and changelog.

The host nearly exhausted swap. This may contribute but does not erase failures.
Concurrent lint was stopped and restarted alone. No deadlines were relaxed.
The throwaway PostgreSQL container and volume were removed after testing.
The [commands](checks.txt) and [comparison output](fixture-proof.json) retain the
results. The earlier passing run had 279 events, two files, 92 bytes, checkpoints
279 on both rebuilds, zero effect calls, 210 held cents and 70 settled cents.

## Limits

PARTIAL: volumes, CNPG/WAL, coordinated backup, current key-deletion custody, pinned
package rollback, admission reopening and live recovery remain NOT RUN. Effect
guards observe application entry points, not real external services. No event/API,
dependency, product access, scanner, install or protected test changes. The security
field-name rule was inspected. Only synthetic bytes reach fixture HTTP replies.
