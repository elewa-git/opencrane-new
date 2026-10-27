# CI test contracts

`fixture-tests.mjs` owns the file list and the arguments passed to Vitest.
It assigns eight files to `fixtures-image` and eight to `fixtures-browser`.
The image group includes screenshot-browser, which also needs Chromium, and the
offline demo read test, which uses packaged Codex and local services.
It also runs `codex-config.test.ts` with pinned native Codex, the generated private
configuration and the real MCP proxy inside a disposable container.
Approvals, live-view-k3d and screenshot-browser keep their existing opt-in flags.
Chat-browser launches three scripts that use Chromium. No test retries are added.

`run-tests.mjs` calls `npm test`, preserving its pretest tool downloads.
Before fixture tests, it builds apps/web in development mode to warm Angular's
compiler cache, which apps/web enables in CI as well as locally.
A failed build stops the job.
`test-files.mjs record <group>` reads Vitest's JSON report and saves relative paths.
`test-files.mjs verify` reads the complete `vitest list --filesOnly --json` output
from the checks job and all downloaded file lists. The final gate needs only Node;
it does not repeat the npm install. Missing, duplicate and unexpected files fail.
Missing reports and failed jobs also fail `ci-ok` during a full run.
The gate requires both fixture jobs, alongside checks and all four shards.
The check for missing fixture entries runs during every successful CI run,
including main pushes; it is not only a unit test. The guard follows literal
relative JavaScript/TypeScript paths and repository-root `scripts/` paths through
helpers and child scripts. It stops at repeated files so circular imports finish.
It does not evaluate computed paths or run the referenced code.

The JSON report includes files whose existing tests are skipped. This check proves
file selection, not execution of opt-in journeys. Angular tests and infrastructure
checks keep their separate steps in the checks job.

`dev-stack-tests.test.mjs` discovers every `.test.ts`, `.test.mjs` and `.test.js`
file under `infra/dev-stack/`, including subfolders. It checks literal file paths
in the workflow's Node test commands. Missing files fail with their paths.
Its `excludedTests` object holds any exclusions and their reasons; it is empty.
The check rejects empty reasons, removed files and exclusions that also run in CI.
Computed paths and shell globs are not counted as explicit test selection.

The checks job reuses its installed Chromium for `browser-budget-editor.test.ts`
and `browser-ownership.test.ts`, with `--test-concurrency=1`. The budget editor
test builds the website once for both of its tests. Other infrastructure tests
keep their existing concurrency. No extra job or browser installation is added.

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

The main runs below use the current 4-CPU layout. Times come from the GitHub
Actions jobs API and include setup and cleanup for whole jobs. After times are
NOT RUN here: the builder stops after opening the draft PR. The CI watcher
records the pushed head's results when its run finishes.

| Job or step | Run 39811688691 | Run 39825839854 | After |
| --- | --- | --- | --- |
| Checks job | 5m 57s | 5m 03s | NOT RUN |
| Shard 1 job | 9m 31s | 10m 12s | NOT RUN |
| Shard 2 job | 8m 39s | 9m 53s | NOT RUN |
| Shard 3 job | 9m 43s | 9m 03s | NOT RUN |
| Shard 4 job | 10m 15s | 8m 56s | NOT RUN |
| Combined fixture job | 21m 44s | 12m 26s | Replaced by two jobs |
| Image fixture job | Included above | Included above | NOT RUN |
| Browser fixture job | Included above | Included above | NOT RUN |
| Upload image build | 1m 47s | 1m 49s | NOT RUN |
| Chromium setup | 9m 52s | 19s | NOT RUN |
| Combined fixture build and tests | 9m 02s | 9m 23s | Split between jobs |

`install-chromium.sh` uses Playwright's read-only dependency check. A temporary
apt setting disables upgrades for this check, so an available upgrade does not
make an installed package appear absent. This setting applies only to the check.
When all packages are installed, setup downloads only the pinned browser files.
Otherwise it installs cached `.deb` files with `apt-get --no-download` and checks
again that all required packages are present. A missing, incomplete or unusable
cache falls back to Playwright's dependency installer. Both package installation
paths have a 180-second limit, followed by forced termination after 10 seconds.
An unsuccessful fallback or browser install fails the job.

The checks, image and browser jobs use `actions/cache@v4` for the downloaded
archives at `.tools/ci/chromium-debs/*.deb`. Their shared key includes the runner
operating system, architecture, `ImageVersion` and installed Playwright version.
There are no partial-key restores. The installer retains downloaded packages for
the cache; `CHROMIUM_DEB_CACHE` changes their directory for script tests.
The script tests cover offline cache installation, bounded downloads, incomplete
and unusable caches, and failure propagation. They use fake commands.
The script prints elapsed seconds; Actions also records step times.

Local apt smoke check on 22 October 2026: a fresh `node:22-bookworm-slim` container
downloaded and retained 111 dependency archives in 68 seconds. A second fresh
container installed those packages in 33 seconds with networking disabled, then
passed Playwright's dependency check. Both runs used the real script and apt;
shell wrappers skipped the browser download and replaced sudo because the
containers ran as root. These are Debian package setup times, not hosted Ubuntu
job times. Hosted cache transfer and Ubuntu runner installation remain NOT RUN.

Local measurement on Ubuntu 24.04, 22 October 2026: the dependency check took
3.7 seconds. Complete setup took 5.7 seconds with system packages and browser
files already present. These measurements do not predict cold hosted downloads.

## Duration estimates

`sequencer.mjs` supplies Vitest's `sequence.sequencer` class. It sorts by decreasing
saved duration, then by path, and assigns each file to the least-loaded shard.
Tied shard loads choose the lowest shard number. Unknown files cost 30,000 ms.

`test-timings.json` is generated compact JSON, sorted by path. Its initial values
are the medians of the six earlier runs' per-file millisecond samples, without
scaling for the newer runners. Rebuild it from all downloaded shard and fixture
JSON reports, supplying the original checkout path recorded in those reports:

```sh
node scripts/ci/refresh-timings.mjs <worktree> reports/*/report.json
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

The documentation step runs `lint:docs`, `lint:readmes`, `lint:links` and
`lint:changelog`. Full lint also runs `lint:readmes`. The README checker needs only
Node and Git, so the documentation path needs no additional installation.
`select.test.mjs` runs the workflow's documentation commands in a temporary Git
repository with a ticket reference in a folder guide. Only the README checker runs
for real; the other npm commands are replaced. The test requires the README error
and refuses any npm installation command.

## Fixture startup

The earlier local fixture run failed in audit-browser and integrations while
Angular still printed “Building…” at their existing 60-second deadlines. Both
files start `ng serve`; two workers could compile the same app at once.
Serial execution still failed cold startup: a development build took 66.13 seconds.
Both fixture jobs prepare that build before tests so their servers reuse the
compiler cache. They keep two Angular build workers. Image files use Vitest's
default: available CPUs minus one in run mode, so three workers on a 4-CPU runner.
Browser files keep one worker: a local three-worker run with four available CPUs
failed both chat browser scripts, audit-browser and integrations while Angular
still printed “Building…”, despite the prepared build. Test deadlines stay unchanged.

Local qualification on Ubuntu 24.04 with Node 22.23.3, 22 October 2026: image
fixtures with three workers passed 36 tests in 197.05 seconds. The existing
screenshot opt-in test was skipped. The three-worker browser experiment failed
four startup checks; 159 tests passed and three existing opt-in tests were skipped.
The retained one-worker browser group is NOT RUN locally after that experiment.
Hosted qualification and the separate image/browser job times remain NOT RUN.
