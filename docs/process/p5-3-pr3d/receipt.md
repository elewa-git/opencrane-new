# Backup endpoint TLS checks

Date: 5 November 2026. Part of #15, P5-3 PR 3d.
Base: `6217c8718`. Failing-first test commit: `b2e858299`.

The internal backup check now verifies the endpoint certificate against the named
CA and the exact checked Service hostname. It sends no credentials or storage
requests. Object reads, TLS and final UID/resourceVersion checks share the original
30-second deadline and cancellation. The installer gate stays closed.

The fixtures use real local TLS peers and synthetic owned Kubernetes objects.
Only the test fixture maps the Service DNS name to loopback. Production uses the
checked hostname and port with Node's normal certificate verification.
No development stack, model call or live CNPG journey ran.
GitHub CI for the pushed commit is reported separately in the draft PR and build report.

| Check | Result | Status |
| --- | --- | --- |
| Worktree setup | `npm ci` completed; both requested tool links created | PASS |
| Failing-first run | 26 expected failures and 103 passes before implementation | PASS |
| Focused TLS/reference tests | 129 passed after implementation | PASS |
| Changed TLS/reference and ownership tests, twice | 155 passed in each final run | PASS |
| Installer and rendering regressions | 539 passed in the wider run | PASS |
| Security rules | 460 passed with the requested database URL | PASS |
| Typecheck | Workspaces and package passed; development-stack check passed after the test type fix | PASS |
| Event catalogue | 158 event types agree | PASS |
| Knip and separate changelog lint | Passed | PASS |
| Lint | Passed with the CI heap limit; 37 existing code warnings, no errors | PASS |
| Storage ownership/permissions, images/helpers and standby | Outside this change | NOT RUN |
| Real backup/WAL and restore of projections, handlers and openfga | Outside this change | NOT RUN |

All test and check commands use `nice -n 10`. The repeated test command is:

```sh
nice -n 10 node --experimental-strip-types --test --test-concurrency=1 \
  infra/dev-stack/cnpg-backup.test.ts infra/package/chart.test.mjs
```

The TLS tests check matching CA/SAN, foreign CA, wrong hostname, expired and future
leaves, non-TLS peers, unavailable endpoints and stalled handshakes. They check
socket destruction, no later work after cancellation or expiry, and final rejection
when Namespace, Service or CA identity changes during the handshake. Caller-supplied
success, alternate endpoints and disabled verification refuse. Parser and nested
network errors expose only the fixed refusal.

Installer tests retain refusal before Helm for every backup/recovery property,
including disabled and null settings and synthetic image approval. No event/API
names, access checks, database names or runtime dependencies changed. The protected
authority and security test files remain unchanged. No full root suite ran.

The first wider run cancelled the ownership tests because their fake clock was not
passed to the reused deadline helper. The fixture now gives both modules the same
clock. The five targeted ownership tests and both complete changed-suite runs pass.
That initial run had 682 passes and 12 cancellations, with no failed assertions.
No ownership assertion was removed or relaxed. Typecheck also found that Node's TLS
options type omits the signal field; the test now states that field explicitly.

The wider run also included `infra/package/chart-render.test.mjs`,
`infra/package/preflight.test.mjs` and `infra/package/cnpg-install.test.mjs`.
Security used `npx vitest run libs/events/test/security-rules.test.ts --maxWorkers=2`
with `PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres`.
The initial lint run was stopped near its default heap limit and restarted with
`NODE_OPTIONS=--max-old-space-size=8192`, matching CI.
