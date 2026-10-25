# Private NATS route preparation receipt

Date: 25 October 2026. Source base: `3b1f43b5f`. Failing-first test commit:
`5fb619452`. The implementation is the commit containing this receipt.

The separate preparation command checks the package owner, reviewed pins and chart
references. It creates a route-only issuer and three distinct private peer identities.
Kubernetes receives only public trust and each peer's certificate and key. Successful
retries check the same references, object UIDs and bytes. Foreign objects, changes and
incomplete attempts refuse without replacement. Failures print a fixed message.

| Check | Observed result | Status |
| --- | --- | --- |
| Failing-first tests | All 14 original cases fail before the entry point exists | PASS |
| Final preparation and package tests, twice | 75 package checks pass twice; final privacy assertions pass in two further 17-test runs | PASS |
| Security field rules | 438 tests pass; the rules and risky-field expression are unchanged | PASS |
| Event catalogue, Knip and changelog | All pass; 153 event types agree | PASS |
| Lint and typecheck | All requested gates pass; ESLint reports zero errors | PASS |
| Live rotation and three-node proof | No live install or certificate replacement attempted | NOT RUN |
| R3 bootstrap and runtime wiring | Left for PR 4; ordinary installation still refuses cluster mode | NOT RUN |

The fixtures use real disposable certificates, a Kubernetes command substitute and
pinned NATS 2.15.0 configuration parsing. They inspect exact DNS names, separate issuer
trust, per-peer Secret contents, expiry, owner refusals and retry behaviour. Captured
credential output is withheld from test errors. These checks do not prove live mutual
TLS handshakes or Kubernetes behaviour. No stack, model call or full root suite ran.

All tests, lint and typecheck run under `nice -n 10`. The security suite uses the
requested `PG_TEST_URL` setting and needs no database connection. The package tests run
with `node --experimental-strip-types --test` against `prepare-nats-routes.test.mjs`,
`chart-render.test.mjs`, `preflight.test.mjs` and `chart.test.mjs` in `infra/package`.
P5-4 qualification remains PARTIAL. CI is not awaited by this builder.
