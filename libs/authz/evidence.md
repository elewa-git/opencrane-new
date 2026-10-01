# OpenFGA projection evidence

Receipt: 1 October 2026, branch `work/openfga`, base `3da3869` plus this change.
Environment: Linux x86-64, Node 22.23.3, Docker; fresh OpenFGA stores, disposable
pg-boss databases, real pinned NATS. This is local integration qualification,
not a fresh installed silo. Safe logs are under `/tmp/openfga-evidence/` on the
builder host; web logs are `/tmp/openfga-web-{build,test}.log`.

The fixture pins OpenFGA **v1.21.0** to image digest
`sha256:2113c664a486b5da8d7a2cdab479e0d4e30639c80fd2c000540f645c1dbc1e55`.
The PostgreSQL persistence test ran against database `openfga_dev` on `pg-test`
(port 55432). `PG_TEST_URL` selected fresh database `openfga_gate_20261001`;
each runtime fixture created and removed its own database below that connection.

## Behaviour proved

| Test | Real-service outcome | Result |
| --- | --- | --- |
| DSL/model agreement | Official transformer produces exactly the model installed by provisioning | PASS |
| Member lifecycle and isolation | Owner implies admin; owner → admin → member removes former roles; removal denies; other people/silos deny; bad data/subject and unsupported events reject | PASS |
| Lost write response | HTTP proxy commits a real OpenFGA write then drops its response; retry converges; replaying old events after removal cannot restore roles | PASS |
| Dispatcher, retry and rebuild | NATS append → dispatcher → pg-boss → OpenFGA; joins allow and role changes take effect; removal denies; outage retries exhaust and hold the stream; repair replays the head before its successor; local receipt deletion/full replay and fresh-store rebuild preserve the exact tuple set, including event receipts | PASS |
| PostgreSQL persistence | Model, tuples and receipts survive an OpenFGA container restart; redelivery does not duplicate or restore removed permissions | PASS |

Full-suite removal latency, measured immediately before append until a successful
higher-consistency check returned denied: **534.0 ms** (target **< 2,000 ms**).
A focused run measured **477.7 ms**. These are single local observations, not a
percentile, load-test result or production SLA. During the outage, checks returned
`allowed: false, status: unavailable`; those responses are excluded from the
removal-latency assertion. The real-service latency test uses the memory datastore;
PostgreSQL persistence and removal are separately proved without a latency claim.

## Gates

| Command | Result |
| --- | --- |
| `npm ci` | PASS, clean install |
| `npm audit --omit=dev` | PASS, zero vulnerabilities after scoped Axios override |
| `npm run lint` | PASS, five checks; 134 modules / 319 dependencies; 32 Markdown files; 98 local links |
| `npm run typecheck` | PASS, 10 workspaces |
| `npm run check:events` | PASS, 70 event types |
| `PG_TEST_URL=… OPENFGA_TEST_PG_URL=… npm test -- --silent=false` | PASS, 38 files / 756 tests |
| `npm run build -w apps/web` | PASS |
| `npm run test -w apps/web` | PASS, 2 files / 27 tests |
| Authz tests without either PostgreSQL URL | PASS, 1 file / 5 tests; fixture starts/stops its own PostgreSQL |

## Dependency inventory and remaining qualification

Verified OpenFGA server, SDK and dev-only DSL transformer licences as Apache-2.0;
Axios 1.20.0 is MIT. Clean installation and tests exercise the patched HTTP client.
Inspected the actual image's Go build information: all **141** dependency
name/version pairs match the upstream v1.21.0 Linux amd64 release SBOM. Retained
inventory and SBOM beside the logs. Base inventory: `wolfi-baselayout` MIT,
`ca-certificates-bundle` MPL-2.0/MIT, and `tzdata` CC-PDDC public-domain time-zone
data. The SBOM's go-digest CC-BY-SA entry covers documentation; its code licence
is Apache-2.0. The SBOM also includes unresolved `LicenseRef` entries; a complete
file-level redistribution audit is **NOT RUN**. This change uses the image as a
test fixture and does not approve or deploy a customer-silo runtime image.

**NOT RUN:** independent adversarial review (reserved for the orchestrator),
hosted CI, server command wiring, fresh-install sign-in/member journey, production
`openfga` database deployment, HA/failover, load/percentile revocation bounds,
backup/restore drill and runtime-image redistribution qualification. Teams,
assistants, conversations, participants and grants are deferred and fail
explicitly if delivered. This receipt does not claim Phase 1 capability completion.
