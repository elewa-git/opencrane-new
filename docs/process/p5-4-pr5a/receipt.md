# Packaged bootstrap replica settings

Date: 26 October 2026. Part of #15. Base: `690c2e44c`.
Failing-first test commit: `d4cf20117`. Implementation is the commit containing this receipt.

Overall: PARTIAL. Preparation and bootstrap source now carry the same choice of
one or three event copies. The cluster preview includes the complete setup Job.
Ordinary R3 installation remains refused. This receipt records source checks only.
No dev stack, model call, owner service or host network setting was used or changed.

## What changed

The existing private settings writer derives the count from `natsCluster` and writes
matching `NATS_REPLICAS` and `COMMAND_NATS_REPLICAS`. The ordinary entry point still
runs the unchanged preflight and refuses R3. There is no environment bypass.
Bootstrap requires the two settings to be present, supported and equal before
setup writes. It uses that count for `EVENTS` and the owner's private command file.
The dispatcher consumer inherits the stream count. Existing incompatible streams
refuse without a configuration change, data change or new consumer.

The Helm preview retains the complete existing Job and private file mounts.
No event or API name, image pin, dependency, access check or installer rule changes.
The exact `RISKY_FIELD_NAME` rule was read; no new event/API field needs an exception.

## Checks

All lint, typecheck and test commands use `nice -n 10`. Tests use at most two Vitest
workers or one Node test file at a time. The security suite receives the requested
fixture `PG_TEST_URL`; these selected tests do not need a projection database.

| Check | Result | Observation |
| --- | --- | --- |
| Dependencies and tools | PASS | `npm ci` completed; the requested NATS and Lychee links resolve. |
| Failing-first tests | PASS | Before implementation, 8 of 47 chart/preparation cases and 13 of 15 bootstrap cases failed on the missing behaviour. Both R1 bootstrap cases passed. |
| Initial fixture corrections | FAIL, corrected | Early bootstrap test attempts used an unavailable fixture helper and an unauthorised stream-list request. The tests now use the existing fixture's connection fields and permitted account information. The confirmed failing-first run reached the intended assertions before the test commit. |
| Chart, preparation and installer refusal | PASS | First run: 69 tests. Real Helm rendering and private settings are inspected; cluster installation remains refused. |
| Bootstrap and disposable NATS | PASS | First run: 15 tests. R1/R3 stream counts, inherited consumers, executed owner settings, invalid inputs and unchanged existing R1 stream are checked. |
| Changed tests, second run | PASS | All 69 chart/preparation/refusal cases and 15 bootstrap cases passed again. The final bootstrap tests also passed twice after removing the direct test-only dependency import. |
| Security rules | PASS | All 438 cases passed once, alongside the second bootstrap run. |
| Event catalogue, Knip and changelog | PASS | All 154 event names agree. Knip and changelog pass. The first Knip run found an unlisted test-only NATS import; direct protocol reads removed that import without adding a dependency. |
| Typecheck | PASS | All workspaces, package tooling and dev-stack tooling passed. |
| Full lint | PASS | Zero errors; 25 existing size warnings. Dependency, documentation, README, offline link, fixture, existing image-inventory and changelog checks passed. |
| Images | NOT RUN | Existing pins remain unchanged. No current-source image build or compatible image review. |
| Controller and storage prerequisites | NOT RUN | No isolated Kubernetes target was created or inspected. |
| Live placement and bootstrap | NOT RUN | Disposable NATS processes and Helm rendering do not qualify a fresh Kubernetes installation. |
| Live rotation, node loss/rejoin and product journeys | NOT RUN | Outside this source-only change. |
| Full root suite | NOT RUN | Excluded by the task. |

The focused Node command was run twice:

```sh
nice -n 10 node --experimental-strip-types --test --test-concurrency=1 \
  infra/package/chart.test.mjs infra/package/chart-render.test.mjs \
  infra/package/preflight.test.mjs
```

Vitest ran `infra/package/bootstrap.test.ts` twice with `--maxWorkers=2`.
One run also included `libs/events/test/security-rules.test.ts`. After the test-only
import correction, both final bootstrap runs passed all 15 cases again.
The remaining commands are `npm run lint`, `npm run typecheck`,
`npm run check:events`, `npm run lint:unused` and `npm run lint:changelog`.

## Remaining work

PR 5b must validate the ordinary R3 installation path. A compatible image needs
review before installation is enabled. Fresh placement, controller/storage checks
and the inherited product journeys still need live evidence.
