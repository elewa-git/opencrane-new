# PostgreSQL primary and standby render checks

Date: 25 October 2026. Part of #15, P5-3 PR 1.
Base source: `4b72856ac`. Failing-test commit: `875987b90`.
The implementation is the commit containing this receipt.
Environment: isolated development worktree; Helm rendering only, no Kubernetes install.
Chart: `opencrane-local` 0.1.0. Images: made-up immutable digests for render/preflight
fixtures; no runtime image was promoted or installed. The CNPG render pin was
`example.invalid/cnpg-postgres:17.6@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb`.
No chart archive was built.

| Check | Status | Result |
| --- | --- | --- |
| Failing-first tests | PASS | 15 passed, 20 failed before implementation; test commit came first. |
| Render/preflight and package tests, first run | PASS | 44 passed under `nice -n 10` with the final CNPG 1.30 contract. |
| Render/preflight and package tests, second run | PASS | 44 passed under `nice -n 10` with the final CNPG 1.30 contract. |
| Event security rules | PASS | 438 passed with the requested `PG_TEST_URL`, under `nice -n 10`. |
| Event catalogue, knip and changelog | PASS | 153 event types agree; no unused-code or changelog failures. |
| Typecheck | PASS | All workspaces and both infrastructure projects passed under `nice -n 10`. |
| Lint | PASS | Full command passed, including dependency, documentation, link, fixture and image licence checks. Existing code warnings remain. |
| Live CNPG primary/standby, storage and node placement | NOT RUN | Needs operator, reviewed compatible image and prepared CNPG credentials. |
| Backup/WAL, all-database restore and storage denial | NOT RUN | Remain under #15. |

CI now includes the preflight and existing package checks beside the Helm render checks.
The tests run real `helm template` and parse rendered resources. They check one
StatefulSet by default, one two-instance Cluster when selected, fixed per-instance
storage and required node separation, bounded resources and credential references.
The writer Service selector matches a primary and excludes standby and foreign
cluster labels. Public exposure, mutable pins and incomplete settings refuse.
Preflight also refuses a missing or mismatched CNPG compatibility review. Both
Helm and preflight reject the retired 1.28 operator contract. The accepted contract
is CNPG 1.30; operator installation and its exact image review remain later work.
These are offline checks. They do not prove live storage allocation, routing,
failover, backup or recovery. The shipped image review still refuses CNPG installs.

Commands: `nice -n 10 node --test infra/package/chart-render.test.mjs
infra/package/preflight.test.mjs infra/package/chart.test.mjs`.

Other commands: `nice -n 10 npm run lint`, `nice -n 10 npm run typecheck`,
`nice -n 10 npm run check:events`, `nice -n 10 npm run lint:unused`,
`nice -n 10 npm run lint:changelog` and
`nice -n 10 npx vitest run libs/events/test/security-rules.test.ts --maxWorkers=2`.
The event security test used the requested local PostgreSQL fixture URL; it
performs schema checks and starts no database or live install.
