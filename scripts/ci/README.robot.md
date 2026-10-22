# CI test contracts

`fixture-tests.mjs` owns the file list and the arguments passed to Vitest.
It includes 13 files: the ten image/browser files from the timing report,
approvals and live-view-k3d, which import Playwright behind existing opt-in
flags, and chat-browser, which launches three scripts that use Chromium. Those
flags and skips are unchanged. No test retries are added.

`run-tests.mjs` calls `npm test`, preserving its pretest tool downloads.
Before fixture tests, it builds apps/web in development mode to warm Angular's
compiler cache, which apps/web enables in CI as well as locally.
A failed build stops the job.
`test-files.mjs record <group>` reads Vitest's JSON report and saves relative paths.
`test-files.mjs verify` reads the complete `vitest list --filesOnly --json` output
from the checks job and all downloaded file lists. The final gate needs only Node;
it does not repeat the npm install. Missing, duplicate and unexpected files fail.
Missing reports and failed jobs also fail `ci-ok` during a full run.
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
reports for seven days. The refresh command below rebuilds timing estimates from these reports.
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

## Duration estimates

`sequencer.mjs` supplies Vitest's `sequence.sequencer` class. It sorts by decreasing
saved duration, then by path, and assigns each file to the least-loaded shard.
Tied shard loads choose the lowest shard number. Unknown files cost 30,000 ms.

`test-timings.json` is generated compact JSON, sorted by path. Its initial values
are the medians of the six earlier runs' per-file millisecond samples, without
scaling for the newer runners. Rebuild it from all downloaded shard and fixture
JSON reports, supplying the original checkout path recorded in those reports:

```sh
node scripts/ci/refresh-timings.mjs /home/runner/work/opencrane-new/opencrane-new reports/*/report.json
```

Refresh from complete, successful runs in a separate small PR.

Estimated sums: 23.66 minutes for four shards, 18.93 for five and 15.77 for six.
These include defaults, exclude setup and do not predict parallel worker speed.
Keep four until hosted times show whether setup or fixtures become the limit.

## Documentation-only decisions

The first job runs the base commit's standalone `select.mjs`, using both commits'
file names from `git diff --no-renames`. This includes deleted and renamed code.
Only pull requests with at least one changed file can select `docs`. Allowed paths
are `docs/**`, `changes/**`, and files ending in `.md` or `.png`.
`docs/process/evidence/**`, `.github/**`, the decision script, sequencer and timing
data always need a full run. Pushes and manual runs always need a full run.

Only the exact output `docs` skips shards, fixtures and full checks. Empty or
unknown output, or a failed decision job, runs everything. The first rollout
also runs everything when the base commit has no decision script. The gate allows
skipped shards and fixtures only for `docs`, with successful documentation checks.

## Fixture startup

The earlier local fixture run failed in audit-browser and integrations while
Angular still printed “Building…” at their existing 60-second deadlines. Both
files start `ng serve`; two workers could compile the same app at once.
The fixture job now uses one Vitest worker and two Angular build workers.
Serial execution still failed cold startup: a development build took 66.13 seconds.
The runner prepares that build before tests so their servers reuse the compiler
cache. Test deadlines stay unchanged and no retries are added.
