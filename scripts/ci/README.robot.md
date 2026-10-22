# CI test contracts

`fixture-tests.mjs` owns the file list and the arguments passed to Vitest.
It includes 13 files. Approvals and live-view-k3d import Playwright behind
existing opt-in flags. The chat browser suite launches three scripts that use
Chromium. Those flags and skips are unchanged. No test retries are added.

`run-tests.mjs` calls `npm test`, preserving its pretest tool downloads.
`test-files.mjs record <group>` reads Vitest's JSON report and saves relative paths.
`test-files.mjs verify` reads the complete `vitest list --filesOnly --json` output
from the checks job and all downloaded file lists. The final gate needs only Node;
it does not repeat the npm install. Missing, duplicate and unexpected files fail.
Missing reports and failed jobs also fail `ci-ok`. No jobs are allowed to skip.
The check for missing fixture entries runs during every successful CI run,
including main pushes; it is not only a unit test. The guard follows literal
relative JavaScript/TypeScript paths and repository-root `scripts/` paths through
helpers and child scripts. It stops at repeated files so circular imports finish.
It does not evaluate computed paths or run the referenced code.

The JSON report includes files whose existing tests are skipped. This check proves
file selection, not execution of opt-in journeys. Angular tests and infrastructure
checks keep their separate steps in the checks job.

Each job writes `.tools/ci/report.json` and `.tools/ci/files-<group>.json`.
Only the file lists are uploaded on pull requests. Main pushes also retain full
reports for seven days. No timing estimates are changed by this PR.
The base image and computer image use separate GitHub cache scopes. Pull requests
only read these caches; main pushes may write them.

For a local fixture run, build with
`nice -n 10 docker buildx bake -f apps/computer/test/upload-bake.hcl --load`,
install the pinned Chromium with `npx playwright install chromium`, and set
`PG_TEST_URL` to a disposable PostgreSQL instance. See the root working rules
for database creation and cleanup. Run test commands under `nice -n 10`.

## Timing evidence and remaining work

The six earlier runs used 2-CPU runners. Their medians below are measured values,
not forecasts for today's 4-CPU runners. The owner reports about 23 minutes for a
full run after the runner change. Hosted times after this PR are NOT RUN here:
the builder stops after opening the draft PR and the CI watcher records results.

| Job or step | Before: earlier median | After: hosted measurement |
| --- | --- | --- |
| Shard 1 tests | 20.8 min | NOT RUN |
| Shard 2 tests | 27.7 min | NOT RUN |
| Shard 3 tests | 37.5 min | NOT RUN |
| Shard 4 tests | 23.1 min | NOT RUN |
| Upload image build per shard | 3.8 min, four builds | Removed from shards |
| Fixture tests | Included in shards | NOT RUN |

Duration-based assignment, the report-to-timings script and docs-only selection
remain follow-up work. Keep four shards until measured results show the next
limit. The earlier report estimates 26.2, 21.0 and 17.5 minutes of serial file
time for four, five and six balanced shards. Extra shards could help after
balancing; these figures exclude setup and are not measured hosted job times.
