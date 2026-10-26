# Packaged bootstrap replica settings

Date: 26 October 2026. Part of #15. Rebased base: `7fb730399`.
The rebase completed and `origin/main` is an ancestor of this branch.
Main advanced during validation. A final rebase added the operator guide and
qualification checker. The tested package source and tests are unchanged byte for
byte after that rebase; the affected documentation and tooling checks ran again.

Overall: PARTIAL. Preparation and bootstrap source carry the same choice of
one or three event copies. Installation now checks that choice before Helm runs.
Ordinary R3 installation remains refused. This receipt records source checks only.
No development stack was started or claimed. Command fixtures use temporary homes
and fake cluster commands; bootstrap tests use disposable NATS processes.
No owner service or host network setting was changed.

## What changed

The private settings writer derives the count from `natsCluster` and writes matching
`NATS_REPLICAS` and `COMMAND_NATS_REPLICAS`. The ordinary entry point still runs
preflight and refuses R3. There is no environment bypass.
Bootstrap requires both settings to be present, supported and equal before setup
writes. It uses that count for `EVENTS` and the owner's private command file.
The dispatcher consumer inherits the count. An incompatible existing stream refuses
without changing its configuration or data or adding a consumer.

The installer requires both runtime settings to match the chart's replica choice.
Any bootstrap override must also match. Bootstrap cannot supply a missing runtime
setting. All these checks run before any Helm command, including rendering.
Executed-command tests cover `1/3`, `3/3` on a one-peer chart, missing settings,
unsupported settings and bootstrap overrides. Matching R1 inputs still reach real
Helm rendering and the existing-release check.

The rebase includes the child-environment kubeconfig transport from main.
Preparation and browser forwarding now use it too. The six runtime Secret creations
use `--from-file=.` from a private temporary directory. Tests inspect every spawned
argument for these Secret commands and for package ownership, forwarding and cleanup.
They also check the child environment, delivered file bytes and private file modes.

No event or API field, dependency, image pin, access, money or memory rule changes.
The Helm preview keeps its complete setup Job and private file mounts.

## Checks

All lint, typecheck and test commands use `nice -n 10`. Node runs one test file at a
time; Vitest uses at most two workers. Test commands use
`PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres` as requested.
These selected tests do not use a projection database.

| Check | Result | Observation |
| --- | --- | --- |
| Replica tests before implementation | PASS | All 13 invalid-setting cases failed because Helm ran. Test commit: `2180c5677`; the implementation follows in `0a57b0905`. All 16 focused cases then passed. |
| Private-path tests before implementation | PASS | Preparation exposed its private folder and connection filename; forwarding exposed its connection filename. All three focused cases failed. Test commit: `179af68de`; the implementation follows in `fff43db0d`. All three then passed. |
| Targeted Node tests, twice | PASS | Both runs passed all 358 tests: chart, preparation, installer refusal, placement, fresh-install and claim fixtures. |
| Bootstrap, twice | PASS | All 15 tests passed on both runs, including disposable TLS NATS peers, R1/R3 counts, dispatcher inheritance and unchanged incompatible streams. |
| Lint | PASS | Zero errors and 26 existing size warnings; dependency, documentation, README, link, fixture, licence and changelog checks passed. |
| Typecheck | PASS | All workspaces, package tooling and dev-stack tooling passed. |
| Event catalogue | PASS | All 154 event names agree. |
| Knip | PASS | The explicit `lint:unused` run passed. |
| Changelog | PASS | The branch uses its unreleased fragment. |
| Final rebase checks | PASS | Package source and tests stayed unchanged. Documentation, README, links, Knip and changelog checks passed again. The added qualification checker passed ESLint and all 40 tests. |
| Images, controller and storage prerequisites | NOT RUN | No image build, image qualification or live cluster inspection. |
| Fresh Kubernetes installation and product journeys | NOT RUN | Fixture tests do not qualify a live install. |
| Rotation and node loss/rejoin | NOT RUN | No live target was started. |
| Full root suite | NOT RUN | Excluded by the task. |

The targeted Node set ran twice:

```sh
PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres \
  nice -n 10 node --experimental-strip-types --test --test-concurrency=1 \
  infra/package/chart.test.mjs infra/package/chart-render.test.mjs \
  infra/package/preflight.test.mjs infra/package/cnpg-install.test.mjs \
  infra/package/prepare-nats-routes.test.mjs infra/package/nats-placement.test.ts \
  infra/package/nats-placement-collect.test.ts infra/package/fresh-twice.test.ts \
  infra/dev-stack/claim.test.ts
```

Vitest ran `infra/package/bootstrap.test.ts` twice with `--maxWorkers=2` and the
same database environment setting. The remaining checks are `npm run lint`,
`npm run typecheck`, `npm run check:events`, `npm run lint:unused` and
`npm run lint:changelog`.

## Remaining work

R3 installation stays refused until compatible images and controller/storage
prerequisites are checked. Fresh Kubernetes placement and the inherited product
journeys still need live evidence. CI is not awaited after pushing this branch.
