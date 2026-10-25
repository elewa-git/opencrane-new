# CNPG installer refusal checks

Date: 25 October 2026. Part of #15.

Source: `a0c33c81aa7e2f2474518ae3c6eec6553266a66f`, based on `35e7e10e9`.
The failing-first test commit is `182dbfb80`.

Environment: Node 22, this isolated worktree, synthetic Kubernetes replies and
real local Helm rendering. No cluster, development stack or model was started.
The fixtures use made-up images and credentials. They are not live CNPG proof.
`npm ci` passed; both requested tool links point to the existing shared binaries.

| Check | Expected and observed result | Status |
| --- | --- | --- |
| Failing-first installer baseline | 26 of 30 cases failed before implementation; four controls passed | PASS |
| Package tests, twice | All 93 cases passed in each final run | PASS |
| Ownership tests | All 35 cases passed | PASS |
| Event security test | All 438 cases passed with the requested `PG_TEST_URL` | PASS |
| `npm run typecheck` | All workspace, package and development-stack checks passed | PASS |
| `npm run check:events` | 154 event types agree | PASS |
| `npm run lint`, including Knip and changelog | Completed with no errors; 25 existing code warnings | PASS |
| Live standby, promotion, backup/WAL, restore and storage denial | Not exercised | NOT RUN |

The [local check summary](checks.txt) retains the final counts.

The first combined run had 127 passing cases and one failure. An existing test
resolved installer imports from the test directory and could not load the new
helper. It now resolves them from the source file. Both final package runs passed.

Commands used `nice -n 10`. The repeated package run was:

```sh
node --experimental-strip-types --test --test-concurrency=1 \
  infra/package/cnpg-install.test.mjs infra/package/chart.test.mjs \
  infra/package/chart-render.test.mjs infra/package/preflight.test.mjs
```

The ownership run added `infra/dev-stack/claim.test.ts`. Security used
`npx vitest run libs/events/test/security-rules.test.ts --maxWorkers=2`, with
`PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres`.
No root test suite ran. The security test did not need a database.

The shipped image review still refuses CNPG. Operator and image promotion,
credential preparation and bootstrap changes remain later work. The operator
check reads the declared manager image version; it does not qualify the running
binary or its licence. No database or role boundary changed.
