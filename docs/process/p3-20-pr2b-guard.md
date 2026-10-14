# Egress socket check receipt

Date: 13 October 2026. Base: `986b9f19`. Test-first commit: `a3153e9d`.
The first run failed to load the absent guard module. Implementation followed that
commit. Final source is the accompanying branch diff. Environment: Linux x86_64,
Node 22, clean `npm ci`, requested NATS and Lychee symlinks, disposable NATS and
loopback fixtures. No customer silo, deployment or image build was used.

This is the first part of the socket guard; the full guard exceeds 600 lines.
It checks TLS names and all DNS answers before connecting to a checked IP.
SNI is the hostname in the TLS opening message. TLS is not decrypted.
The address checker moved unchanged from server integrations into models.

The gateway fixture checks agentgateway v1.5.0 SHA-256
`daca5cda76e8c5ab0c1a75912fecf2d6365095403f810db72029c49d14a37e7b`.
Its connector maps a checked IP/port to a recording loopback upstream.
All previous gateway assertions remain. No production address exception was added.

| Own check | Result |
| --- | --- |
| Clean install and tool symlinks | PASS |
| Changed guard and gateway tests, twice | PASS; 82 tests each |
| Remote MCP discovery regression | PASS; included in the 550-test focused run |
| Event security field checks | PASS; included in the same focused run |
| Lint including knip; typecheck; event catalogue; changelog | PASS; 132 event types agree |
| Full root suite and fresh-install journey | NOT RUN; outside this split |

Checks run under `nice -n 10` with at most two test workers. Focused integration commands set
`PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres`; these focused tests
use disposable NATS and loopback sockets, not PostgreSQL projections.
The final fragmented-input test also passed twice with all 56 guard tests.
Local check output is in `/tmp/p3-20-pr2b-*.log`; no tunnel bytes are logged.

Still NOT BUILT: one-use permit registration, expiry, close by permit/host/all,
close records and checked-set fallback. Capability admission, durable receipts,
watchdogs and startup wiring remain outside this work. No access checks, network
policy, Docker configuration, command worker or browser settings changed.
Networking remains off at startup. This is PARTIAL for the requested socket guard,
not completed governed egress or fresh-install qualification.
