# Single-use egress relay receipt

Date: 14 October 2026. Base: `837a3ce4`. Test-first commit: `640446e2`.
The first registry run failed because the relay module did not exist.
Implementation followed that commit. Environment: Linux x86_64, Node 22,
clean `npm ci`, symlinked NATS, Lychee and the existing pinned gateway binary.

The registry owns one loopback listener and both sockets for each permit.
Used listeners refuse further connections and keep their ports until expiry.
Closure cancels work during the hello read, DNS lookup and connection attempt.
A late socket is destroyed without forwarding bytes. One callback reports the
checked IP, counts including the hello, times and reason. It stores no tunnel data.
The real gateway/NATS fixture now registers a relay after each allowed guarded
CONNECT decision. Previous route, guard and credential-canary assertions remain.

| Own check | Result |
| --- | --- |
| Clean install and tool symlinks | PASS |
| Registry, guard and real gateway tests, twice | PASS; 111 tests each |
| Event security field checks | PASS; 419 tests |
| Lint including knip; typecheck; event catalogue; changelog | PASS |
| Full root suite and fresh-install journey | NOT RUN |

Checks use `nice -n 10`, at most two test workers and
`PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres`.
These focused fixtures use disposable NATS and loopback sockets, not projections.
Logs are in `/tmp/p3-20-pr2c-*.log` on the builder host.

This is PARTIAL for governed egress. Capabilities, admission, automatic closure
on access/turn/budget/outage changes, durable receipts, watchdogs, startup wiring
and address fallback remain NOT BUILT. Networking stays off at startup.
No authority checks, dependencies, network policy or Docker settings changed.
