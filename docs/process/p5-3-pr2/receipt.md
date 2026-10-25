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

## Fixture copy repair

Date: 25 October 2026. Source: `43562254b247cfb4ae375acfbe0221d559324d7d`.
The failing-first test commit is `9d37696a6`.
Fetching and rebasing completed; `origin/main` at `35e7e10e9` was already included.
Both Git rebase state directories were absent afterwards.

The original fresh-install and NATS route tests reproduced the CI failure:
31 cases passed and 24 failed because the copied installer could not import
`cnpg.ts`. The test-first commit made both fixtures use one file list and checked
each copied module's local imports with the installed TypeScript parser. Without
`cnpg.ts` in that list, the same 24 cases failed with a message naming the missing
file. Adding it repaired both fixtures. Existing assertions, certificate checks
and product code are unchanged.

Environment: Node 22.23.3, real Helm rendering and the existing disposable test
fixtures, including the pinned NATS certificate check. No live development stack
or CNPG installation was started.

| Check | Observed result | Status |
| --- | --- | --- |
| Focused fresh-install and NATS route tests | 55 passed, none failed or skipped | PASS |
| All 48 infrastructure test files selected by CI, run 1 | 445 passed, none failed or skipped | PASS |
| The same 48 files, run 2 | 445 passed, none failed or skipped | PASS |
| `npm run lint`, including Knip and changelog | No errors; 25 existing code warnings | PASS |
| `npm run typecheck` | All workspaces, package and development-stack checks passed | PASS |
| `npm run check:events` | 154 event types agree | PASS |
| Separate `npm run lint:changelog` | No errors | PASS |
| Full root suite and live product journeys | Not exercised in this repair | NOT RUN |

Both full runs used the literal `infra/package` and `infra/dev-stack` test paths
from `.github/workflows/ci.yml`, including its separate budget and ownership
browser tests. They cover fresh-install, NATS route, chart and claim tests twice.
The command was `node --experimental-strip-types --test --test-concurrency=1`
with those 48 paths. All tests used the supplied `PG_TEST_URL`. Tests, lint and
typecheck ran under `nice -n 10`. The two full runs took 1,091 and 819 seconds.
The [check summary](checks.txt) records the counts alongside the earlier checks.

During verification, another worktree fetched a new `origin/main` commit,
`7235079d9`. A final rebase onto it completed without conflicts. The repair is now
`e4733c117`, with failing-first test commit `d443a4e90`. The infrastructure files,
CI workflow, dependency manifests, shared TypeScript settings and certificate
fixture are identical to the tested source above. The new main commit changes
server memory reports. The two full infrastructure runs above preceded this final
rebase; they do not claim checks of that new server behaviour.

After this final rebase, targeted ESLint for the three changed server code/test
files and `npm run typecheck -w apps/server` both passed. Documentation, local
links, Knip, changelog and event checks also passed again. These commands used
`nice -n 10`.
