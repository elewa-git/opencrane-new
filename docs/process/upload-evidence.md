# P2-6 upload evidence

2 October 2026, `work/upload`, based on main `1138544`. Local source evidence;
this is not a fresh-silo capability PASS. No shared dev-stack process, container,
Pod, database, credential or signature was changed.

## Acceptance evidence

`PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres npx vitest run apps/server/test/upload.test.ts`
passes against disposable MinIO and ClamAV, real NATS JetStream, an isolated
PostgreSQL database and disposable OpenFGA. The computer test uses the existing
`ocn-computer-runtime` image with this branch's sources mounted read-only, a
private saved-disk volume and the loopback stub provider. All fixtures are removed.

| Claim | Result / evidence |
| --- | --- |
| Authentication and origin | PASS: no cookie gives 401; wrong origin gives 403; other-owner participant, direct and closed conversation GET/POST refused; current membership and permissions checked in OpenFGA |
| Content and size | PASS: disguised executable/archive, encoded Excel macro declarations, macro sheets and encrypted/macro legacy workbooks refused; over 20 MiB gives 413; real PDF accepted |
| Quarantine before visibility | PASS: a blocked scanner leaves only a quarantine object, absent from the HTTP file list; an unavailable scanner returns 503 and removes quarantine |
| Infected upload | PASS: EICAR gives 422 with a clear refusal, records one `file.rejected`, removes quarantine and never promotes or lists the infected bytes |
| Replay and retry | PASS: projection rebuild produces the same HTTP list; same key/body succeeds once; changed body gives 409, including a concurrent race with one committed upload |
| Bridge delivery | PASS: authenticated bridge sends a file larger than one frame; real computer verifies, saves and acknowledges; server records `file.delivered` |
| Reconnect and saved disk | PASS: resend after disconnect and replacement of a disposable computer with its saved volume preserves original-file mtime; process pause/unpause also succeeds |
| PDF reading | PASS: real Codex requests `exec_command` to read MarkItDown's adjacent text; stub only answers Willow-47 after seeing that fact in tool output |
| Invalid acknowledgement | PASS: malformed JSON refuses delivery without an uncaught socket-handler error |
| Storage credentials | PASS: real upload path uses bucket-scoped STS; independent check refuses expired and overlong leases before storage I/O |
| FreshClam dev-box refresh | PASS: pinned engine updated a scratch candidate from daily 28046 to 28141; main 63 and bytecode 339 unchanged. Candidate is not deployed |
| Offline scanner | PASS: cleaned runtime scans a file with `--network none` and bundled signatures; neither UnRAR library exists in that runtime |

The scanner source is copied from OpenCrane 1 commit `10abd0ef6`, including its
AGPL licence. The pinned daemon source contains offline main 63, daily 28046 and
bytecode 339; no network update runs at daemon startup. See
[scanner notes](../../infra/clamav/README.md). The FreshClam candidate lives in
`/tmp/upload-signatures`; its updater log is `/tmp/upload-freshclam.log`.
The scanner runtime is flattened from that pinned source with both non-OSI
UnRAR libraries removed; its [licence review](../../infra/clamav/LICENCES.md)
records the bundled notices and Debian main boundary.

## Gates and remaining qualification

Fresh dev-stack upload/PDF journey, actual Kubernetes suspend/wake with this
change, hosted CI, real provider call and rendered Office previews are NOT RUN.
The shared stack is owned by another builder. Compose and journey code include
ClamAV, the files worker, PDF/stub proof, EICAR refusal and saved-PDF verification
after Pod replacement for a later fresh run. Issue #31 remains the live
qualification tracker; source readiness does not close it.

Local checks use this branch's source tree on main `1138544`; the final commit is
reported with the handoff. Clean `npm ci`, root lint/typecheck, infra TypeScript,
`check:events` (76 types), the web build and all 41 web tests passed. Lint has five
function-length warnings; the web build retains its existing CSS-budget warning.
Two independent review passes completed, and all three blocking findings were
fixed with regression or refused-credential evidence. Image licence inspection
also removed the upstream UnRAR plug-ins before qualification.

The initial concurrent full-suite runs hit five-second timeouts under host load,
and one provider-status fixture exceeded its internal timeout. The final suite
uses two workers and a 20-second default test deadline; production deadlines are
unchanged. PASS: `PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres npm test -- --maxWorkers=2 --testTimeout=20000 --reporter=verbose`
finished with 63 passing files and 1,029 passing tests. Two live Kubernetes files
and the real-provider test were skipped (three tests); those conditions are NOT RUN.
Safe local logs: `/tmp/upload-final-tests-limited.log`,
`/tmp/upload-final-lint-retry.log`, `/tmp/upload-final-typecheck-retry.log`,
`/tmp/upload-final-web-build.log`, `/tmp/upload-final-web-tests.log`,
`/tmp/upload-clamav-build.log` and `/tmp/upload-offline-scan.log`.

## Dependency assessment

`npm audit --omit=dev` reports four moderate entries through MinIO: two affected
packages and their dependants. The
[URI-decoding advisory](https://github.com/advisories/GHSA-vcc3-ghjq-m6fr)
requires decoding attacker-controlled input; this adapter uses the SDK's query
encoding calls, never its parsing API. The
[stream-json advisory](https://github.com/advisories/GHSA-528h-pc64-c93x)
affects nested-input filters; MinIO imports its JSON-line parser for bucket
notifications, which this adapter never invokes. Reviewed installed SDK sources:
`dist/esm/internal/client.mjs`, `helpers.mjs` and `notification.mjs`. These findings
are assessed as unreachable from uploaded bytes on the shipped path, not fixed
upstream. No runtime high/critical finding is reported. The full audit additionally
reports the existing Angular build/Piscina critical findings; this change does
not alter those build-only dependencies.
