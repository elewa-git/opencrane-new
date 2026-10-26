# Authenticated upload scans over HTTPS

Part of #15. Checked on 25–26 October 2026 in `<worktree>`,
using Node 22.23.3. Implementation: `04a1b15ec`; failing test commit: `263948a63`.
The final fixture edit separates two promise statements without changing behaviour.
This is local fixture evidence, not a fresh installation or live ClamAV qualification.

The wrapper now reserves one of two request places before metadata checks, pass
verification or body collection. It refuses excess requests immediately with the
fixed 503 response and no clean verdict. Node admits at most eight TCP connections,
including unfinished TLS handshakes, and closes excess connections before TLS starts.
Reservations are released after success, error, timeout and client abort. Cancelled
scans still wait for cleanup and retire the scanner; capacity release cannot renew it.
Timeout, expiry and refusal fixtures now use braces and separate statements.
The saturation tests stay in this PR even though the complete diff exceeds 650 lines.

- PASS — fetched origin and rebased onto `origin/main` at `2fed5714f`.
  Verified ancestry and the absence of unfinished rebase directories.
- PASS — failing-first proof: all seven new capacity cases failed before the fix,
  while all 32 existing service cases passed. The test commit preceded the fix.
  Expected failures showed excess work accepted and a ninth TCP connection left open.
- PASS — service and launcher/owned-scan suites passed 104 tests twice.
  The first run also passed all 438 unchanged event security-rules cases: 542 total.
- PASS — after the final fixture formatting edit, all 39 service cases passed twice.
  Tests cover transfer/scan saturation, early bytes without body collection,
  recovery after success, authentication error, transfer abort and transfer timeout,
  and TCP refusal/recovery before TLS. Existing scan retirement assertions remain.
- PASS — event catalogue: all 154 event types agree. Standalone changelog lint passed.
- PASS — workspace and infrastructure typecheck.
- PASS — all lint stages: code, dependencies, Knip, docs, READMEs, links, fixtures,
  licences and changelog. Code lint reported 25 warnings in unchanged files.
  The initial aggregate run stopped at a home path in this receipt. After replacing
  it with a placeholder, documentation and all remaining stages passed.
- NOT RUN — full root suite, production issuance, upload/image consumers, fresh
  clean/EICAR and two-silo deployment. This admits no production upload.

Commands used `nice -n 10`. Vitest used `--maxWorkers=1` and
`PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres`.
The tests use real local TLS and ES256 with process fixtures for scanner replies.
No projection tests, dev stack, model calls or owner services were needed.
No event fields, dependencies, access checks, money checks or memory checks changed.

Local logs are `/tmp/p5-6a-pr6-fix-red.log`, `-green.log`, `-tests-1.log`,
`-tests-2.log`, `-final-service-1.log`, `-final-service-2.log`, `-lint.log`,
`-typecheck.log`, `-events.log` and `-changelog.log`, all with the same
`/tmp/p5-6a-pr6-fix` prefix.
