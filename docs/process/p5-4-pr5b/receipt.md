# Checked three-node package admission

Date: 26 October 2026. Part of #15. Source: the commit containing this receipt.
PR 5a merged as `5557c51ba707bbcfb96b2e510193f9fe44c7519a` and is the branch base.
Its report, review reports and the #724 receipt were read before implementation.
Environment: Linux, Node 22.23.3, fresh `npm ci`, linked NATS and Lychee tools.
Tests use temporary private files, synthetic Kubernetes replies and real Helm.
No fresh installation, development stack, registry repair or model call was made.
Image pins, dependencies and licence inventories are unchanged.

Overall: PARTIAL. Source admission is implemented; the shipped image has no R3
compatibility approval and still refuses. Promotion and live qualification follow.

| Check | Result | Observation |
| --- | --- | --- |
| Dependency setup | PASS | `npm ci` completed. Both requested tool links resolve. npm reported seven high advisories; no image clearance is claimed. |
| Failing-first tests | PASS | Commit `1633735ea` records the tests. Prepared R3 stopped at preflight and private preparation refused the installation choice. Both failed before implementation. |
| Focused changed tests twice | PASS | All 213 installer, preflight and route cases passed in both runs. After fixture repairs, all 48 chart cases passed twice. The final R3-only recheck passed 29 cases. |
| Initial wider runs | FAIL | 333/337 and 259/261 passed. Two chart fixture assumptions needed repair; the first run also had two claim failures. |
| Typecheck, event catalogue, Knip and changelog | PASS | All workspaces and package/dev-stack tooling passed; 154 event names agree. |
| Lint | PASS | All stages passed, with zero errors and 26 existing size warnings. Final documentation checks also passed. |
| Event security rules | PASS | All 438 tests passed. |
| Live R3 and fresh install | NOT RUN | No target or package was started. Fixtures cannot qualify live placement or bootstrap. |
| Image promotion, registry and controller/storage prerequisites | NOT RUN | Separate follow-up work. |
| Full root suite | NOT RUN | Excluded by the task. |

The focused Node set covers `chart`, `chart-render`, `preflight`, `cnpg-install`,
`prepare-nats-routes`, `fresh-twice` and dev-stack `claim` tests. Commands use
`PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres`, `nice -n 10`,
`node --experimental-strip-types --test --test-concurrency=1` and explicit files.
The security check uses Vitest with two workers and the same environment.
Logs are `/tmp/p5-4-pr5b-*.log`, including both final chart runs and the final R3 recheck.

The first implementation run exposed a fixture that reused the client CA and a
fixture expectation that missed the existing CNPG error sanitisation. The separate
route issuer and expected fixed error were corrected. These failures are retained
in the local logs; only completed final runs count as passing evidence.
The live-client-CA refusal failed before its fix and then passed. Chart fixtures
now expect preview refusal and pass the original owner through gateway setup.
Two claim fixtures failed twice while claim commands shared host lock files.
Both passed separately after the wider claim run finished. The failed attempts
remain FAIL; the separate two-case run is PASS.

No event or API fields change. The exact `RISKY_FIELD_NAME` rule was checked.
Authority checks and protected tests are unchanged. No credentials or private
certificate bytes are added to output. Preparation remains create-only; route
validation cannot generate or replace identities. Cleanup and private exposure
checks remain required. CI is not awaited after the draft PR is opened.

## Expired certificate fixture repair

Date: 26 October 2026. Source: the commit containing this update.
The branch was rebased onto `9e470b61e83b96db48a07675bf6b196c7fbfd846`.
The rebase finished, and that main commit is an ancestor of the branch.
Environment: Linux, Node 22.23.3 and OpenSSL 3.0.13. Existing dependencies were reused.

The CI failure came from signing a certificate with `-days -1`. Some OpenSSL
versions refuse this; the local version instead creates an end date before its
start date. The new interval assertion failed first in test commit `6a97f4f71`.
The installer and route-preparation tests now share the existing signing approach
with explicit dates: 1 January 2020 through 2 January 2020. They check that the
start precedes the end and that the end is in the past before validation runs.
The scan of this PR and `infra/package` found no other negative-days fixture.

The product checks are unchanged. A temporary check removed the JavaScript date
assertion and disabled OpenSSL time checking. Installation then returned success,
and the expired-identity refusal test failed as required. Both product checks
were restored before the full requested test runs.

| Check | Result | Observation |
| --- | --- | --- |
| Failing-first fixture assertion | PASS | The original fixture failed because its end date preceded its start date. The explicit-date fixture passes. |
| Expiry guard check | PASS | Bypassing both date checks made installation succeed and the refusal test fail. Product code was restored unchanged. |
| Negative-days scan | PASS | The installer fixture was the only occurrence in this PR and `infra/package`. Route preparation now uses the same shared signer. |
| Package tests twice | PASS | All 337 Node tests passed in each run, with no skips. This includes installer, preparation and packaged ownership checks. |
| Bootstrap twice | PASS | All 15 tests passed in each run, including real disposable NATS peers. |
| Lint | PASS | All stages passed, with zero errors and 26 existing size warnings. |
| Typecheck | PASS | All workspaces and package/dev-stack tooling passed. |
| Event catalogue | PASS | All 154 event names agree. |
| Knip and changelog | PASS | Both explicit commands passed. Knip reported two configuration hints. |
| Fresh installation and live R3 | NOT RUN | No development stack was claimed or started. |
| Full root suite | NOT RUN | Excluded by the task. |

The Node test set covers `cnpg-install`, `prepare-nats-routes`, `chart`,
`chart-render`, `preflight`, `fresh-twice` and dev-stack `claim`. The latter tests
use temporary homes and simulated services. They do not claim a real stack.
The bootstrap test runs separately with Vitest and at most two workers.
All test runs use `PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres`
and `nice -n 10`. Node tests use `--test-concurrency=1`.
Safe local logs are `/tmp/p5-4-pr5b-fix-*.log`.
