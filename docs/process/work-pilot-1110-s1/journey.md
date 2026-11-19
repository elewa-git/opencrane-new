# Packaged connected-provider journey

Journey on a fresh dev stack: NOT RUN

Date: 19 November 2026 UTC. Runtime source: `7e50c97a9`.
Reviewed helper record: `7c2745ba0`. Later receipt edits change no runtime source.
Environment: Linux, Node 22.23.3; source checks use disposable NATS, PostgreSQL,
OpenFGA and the pinned gateway. These fixtures are not a fresh packaged install.

The task carries `OPENCRANE_FLEET_TASK`. The existing
[`requireFleetStandInProvider` guard](../../../infra/dev-stack/journey-guard.ts)
refuses real-provider journeys with that marker. Invoking the unchanged guard with
a secondary stack id and real-provider mode returned exit 1:
`Fleet tasks require the stand-in model`. [Guard output](guard.txt).
The task explicitly forbids unsetting the marker or bypassing this guard.
No slot was claimed, no package was installed and no startup was attempted.
There are no live startup logs or screenshots to copy, and no slot to tear down.

## Required live steps

All steps below remain NOT RUN:

1. Wait for the one-journey load and free-slot conditions, then claim a spare slot.
2. Prepare fresh provider-mode package values with CI-approved images for the source.
3. Run `package-prepare`, private secret preparation, `package-up` and `package-check`.
4. Sign in as the owner, open Settings and connect OpenAI through the product routes.
   Save the key from a private file, pass reachability and the quoted test, choose the
   chat model and default, drain and switch on.
5. Sign in as a member and receive a real chat answer at 1280 px and 390 px.
6. Show the product's refusal with a wrong key, without revealing it.
7. Check that the key is absent from values, manifests, events, logs and receipts.
8. Copy safe logs and screenshots before `package-down` and `down.sh`.

Use the existing [provider setup](../../../infra/dev-stack/provider-setup.ts) and
[real reply journey](../../../infra/dev-stack/real-model-journey.ts). Builders cannot
approve images. A local candidate image check does not satisfy these live steps.

Paid calls: **0**. Total charged by this task: **0 cents**. No provider key was loaded for setup or a call.
Monthly-budget qualification, key-volume restart qualification and backup remain
outside this slice's claimed live evidence. No independent review was run.

## Source checks

No fixture result is claimed as live qualification. Tests, lint, typecheck and the
local image build ran under `nice -n 10`. Vitest used at most two workers and the
shared disposable PostgreSQL service. Node's package tests used concurrency two.
No full root suite ran.

- PASS: changed runtime tests twice: 36 tests, then 48 tests including the unchanged
  models-startup suite. These use real disposable NATS, PostgreSQL, OpenFGA and the
  pinned gateway. Before switch-on, a managed request is refused. Afterwards the
  same process uses stored custody. A missing saved key returns 403 before any
  provider request or reservation.
- PASS: workspace, package and dev-stack typecheck; event catalogue (174 types);
  Knip (two existing configuration hints); changelog; scoped ESLint; Markdown; README, whole-stream-read, lint-debt and
  offline-link checks. Infrastructure files remain excluded by the repository's
  ESLint configuration; their TypeScript is checked by the package/dev-stack gates.
- PASS: all 82 existing licence tests, plus the package licence check with the three
  added Debian main packages. No third-party binary or licence-review hash changed.
- PASS: local Docker build, including web compilation. The local candidate is
  `sha256:e616c55f03f47b2363a5aaa82534126bdc4437c8a3c3581afa5f3f5d2fd818b6`,
  labelled with runtime source `7e50c97a9`. It grants no installation approval.
- PASS: saved-image checks twice, 17 tests each (329.37 s and 326.00 s). They check
  certificate parsing, runtime imports, native helper bytes, private/test file
  exclusions, file permissions and synthetic bootstrap inside the image.
- PASS: affected Node suites repeated by file. The final combined run passed all
  615 cases in 1,129.20 s. The corrected preflight suite also passed all 51 cases
  separately in 66.87 s, giving that suite two successful runs after its fix.
  The other four affected Node suites passed in both combined runs.
- NOT RUN: separate web tests; no web source changed. Independent review and hosted
  CI are left to the orchestrator.

## Failing-first evidence

`3f7a71af0` records the render, preparation, preflight, installer and launcher
regressions. Provider mode was absent, preparation still wrote a stand-in key,
preflight refused the new setting and the launcher tried to forward an absent
stand-in port. The default render digest was captured from the unchanged base.

`c2a5e839c` records the next complete-path failures: the gateway exited before
switch-on without a static key; the model-selection projection was absent; backup
neither waited for nor paused it. The runtime and chart checks passed after fixing
those causes.

The first combined Node run passed 614 of 615 cases. The preflight wrapper had
started its licence tests before the initial inventory ordering was corrected:
new OS entries had been placed before the application entries, invalidating an
existing fixture's first-application assumption. Restoring the original inventory
grouping kept the licence assertions unchanged. All 82 licence tests then passed;
the preflight suite and complete package repeat run against that corrected source.

The saved-image check then found the old Codex configuration-helper hash. The image
contained the current repository file, changed by the merged session-default
refactor. `c1474e820` adds a fast source check that failed on that exact mismatch;
`7c2745ba0` refreshes only that AGPL repository helper's hash. Codex executable,
launcher, dependency reviews and image approval checks stay exact.

## Test strength and cleanup

A temporary Node loader removed the switch-on refusal in the spawned test process:
the new assertion failed (503 instead of 403). Bypassing credential reading made the
missing-key test fail (200 instead of 403). The loader changed no repository file.
Both tests passed again without it. No real provider was involved.

Moved gateway route selection into one 17-line function. Shared package runtime
settings and model-secret admission in one module. Split private file preparation
from settings and replaced the touched inline mapping with a clear loop. Removed
the old nested route and in-place settings builder. Changed preparation functions
are at most 66 physical lines and four parameters; new helpers have at most three
parameters. No limit was raised and no new error catch discards a cause.

Shipped code: **279 lines changed**, 214 added and 65 deleted, excluding tests,
documents and receipts.
