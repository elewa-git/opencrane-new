# Startup integration rows

22 October 2026. Part of #584.

Source: `30c2d43b827daa423d2f248867caa64642e54e19`, based on
`4fb9a34b2a23316f29e0e34ee55ae91848b794f1`. The failing-first test is committed as
`7c177d149`. This record covers the startup journey's typed integration list check.
The later `b0c10e397` commit changes test cleanup only; it does not change the running journey.

## Cause and failing-first proof

The old fixture registered an unreachable remote URL, then supplied discovery,
review and publication events itself. The remote catalogue watcher correctly
selected that row. On its first check it saved a failed check before attempting
remote discovery. The failed discovery saved another failed check. These events
cleared the catalogue expiry, so the list could no longer report Ready.

PASS: the regression uses real disposable NATS and PostgreSQL services. It records
registration → discovery → review → publication → failed check → failed check.
The row is Ready before monitoring and disabled afterwards; its saved expiry is
null. The test forces the network failure, without depending on DNS timing.
This proves an interleaving that causes the timeout; the earlier image-refresh
log did not retain enough events to establish that run's exact order.

FAIL as expected at the test commit: the current-fixture assertion requires Ready
after the real watcher runs, but receives disabled. With the fix, it also requires
zero remote connection attempts and an accepted startup credential contract.

## Change

The list-only fixture now uses the existing hosted registration kind and a
per-call credential contract. It requests no installation and makes no tool calls.
The remote watcher already selects only remote registrations. No product code,
watcher rule, timeout, event contract, access check or dependency changes.
Discovery, the Owner review API and the Ready assertion remain in the journey.
On failure, the journey saves the last typed row and event types, positions and
times without copying tool definitions or upstream errors.

## Source checks

| Check | Result |
| --- | --- |
| Clean `npm ci`; NATS and Lychee links | PASS; 934 packages installed |
| Changed regression, twice after the final code change | PASS; two tests each run |
| Existing remote watcher tests | PASS; 13 tests |
| Event security rules | PASS; 438 tests |
| CI fixture grouping tests | PASS; 10 tests |
| Knip | PASS |
| Event catalogue | PASS; 149 event types |
| Changelog | PASS |
| Full lint | PASS; all code, dependency, docs, link, fixture and licence checks |
| Full typecheck | PASS |

An early test edit used a schema that the package does not export. An early
typecheck also found an unexported type and a resolver return type inferred as
void. These test-only mistakes were corrected before the final two regression runs.
The final focused server typecheck passes. The first lint run found two unbound
cleanup methods in the test; named functions now call those methods. The final
two regression runs include that correction. The throwaway PostgreSQL container and
its volume have been removed. All lint, typechecks and tests use `nice -n 10`.
The full root suite is NOT RUN, as requested. No authority test was edited.

## Fresh startup

PASS: the live typed row matches every requested field. The
[retained row and events](journey-integration-rows.json) show Journey MCP 1.0.0,
two tools, one allowed and Ready. Events 300–303 record hosted registration,
discovery, the Owner review and publication. The complete fresh startup also passes:
one run, exit status zero, 1,044.80 seconds
on claimed secondary slot 1. The [sanitised startup log](journey-integration-rows-startup.txt)
records the integration API assertion and the remaining startup checks.
The command is `infra/dev-stack/up.sh --id 1 --fresh`, under `nice -n 10`, with the
free local model stand-in. The owner stack and port 44200 are outside this run.
The existing approval journey remains skipped by startup. Remote tool calls,
hosted image installation, paid models, the optional group journey and the final
demo rehearsal are NOT RUN by this check.

PASS: `infra/dev-stack/down.sh --id 1` completed in 53.31 seconds and removed
the slot directory and claim. The owner stack was untouched. Generated browser
artefacts outside this change were restored.

GitHub CI is NOT RUN here; the task stops after pushing and opening a draft PR.
Private command logs are under `/tmp/demo-journey-integration-rows/`.
