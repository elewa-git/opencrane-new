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
