# Computer image update checks

8 October 2026. Source: `2236e1ed1cf28b3c3388f3cc123b4a6325070254` on `work/i275-build`.
The final PR commit adds this receipt and separates two admission-building steps.
The generated policy objects are identical before and after that readability change.

The tests used claimed secondary slot 1 (`opencrane-dev-1`), Node 22.23.3,
the existing k3d cluster and a separate disposable PostgreSQL 17 service.
Each live case created an empty computer namespace and removed it afterwards.
The rest of the slot was stopped. The owner stack was untouched.

The controller was agent-sandbox v1.0.4, image digest
`sha256:c241245d7ff0068784ec0423f35efeb77c70ab08592533ca5b0cd7c36f8b2020`.
The checked computer image was `k3d-ocn-registry:5000/opencrane/computer@sha256:94d4dbc8d3fb45f6dc0a23aac9a15dc5ade0cbfa49c8d2bef3015eba15db8032`.
The test built a second digest by adding a label to that image. It pushed only
`retained-opencrane-dev-1` through the registry's private Docker bridge.
Its loopback port reset connections; no registry setting or other tag was changed.

The live runs preceded the final rebase, which added unrelated model-access reads.
All eight checked lifecycle implementation and test files kept the same hashes.
The source gates and targeted tests were rerun after that rebase.

## Expected and observed

A Running computer keeps its old Pod until its next committed pause. A fully
paused Sandbox accepts one checked template update without changing ownership.
Resume starts a new Pod on the checked image and attaches the same home disk.

Both image cases passed: already paused, and Running until its next pause.
The Sandbox UID and PVC UID stayed the same. The Pod UID and actual image ID
changed. The saved home file still contained `yes` after resume.
The worker could preview and apply its allowed mode patch. Sandbox DELETE and
PVC PATCH were refused with its real service account credentials.

## Checks

All lint, typecheck, build and Vitest commands used `nice -n 10`.
No full root test suite or fleet batch was started.

| Check | Result |
| --- | --- |
| Rebase onto `origin/main` and ancestry check | PASS; final base `5f5b4117411963f506661e35c252d5bc9bca2e79` |
| `npm run lint` | PASS; nine existing size warnings outside this change |
| `npm run typecheck` | PASS |
| `npm run check:events` | PASS; 98 event types agree |
| `npx knip` | PASS |
| Targeted unit and credential tests, twice | PASS; 35 tests each |
| Complete lifecycle k3d file, twice | PASS; 11 tests each; 641.98 s and 661.52 s |
| Full root tests | NOT RUN; excluded by the task |
| Fresh full-stack browser journey | NOT RUN |
| Managed-cluster qualification | NOT RUN |
| Round 2 independent review | NOT RUN; belongs to the orchestrator |

The targeted files were `kubernetes`, `idle`, `upgrade`, `wake` and `credentials`
under `apps/ops/test`. Live runs used `DEV_STACK_ID=1`, `LIFECYCLE_K3D=1`, a
private `PG_TEST_URL` and `npx vitest run apps/ops/test/lifecycle-k3d.test.ts
--maxWorkers=1`. Only that slot's three named admission policies were removed.

## Failing-first checks

Removing the local guards made the tests fail for assistant/computer labels,
PVC ownership and labels, missing PVC, Running state, stale suspension status,
a remaining Pod, another claim name, the 100 ms wait, current/older open turns,
independent resumes, new-event retries and the back-off cap/reset.

Live mutations restored the reviewed delete/PVC patch rights and removed the
new update rule. The tests caught both destructive permissions and the missing
allowed update. Bypassing the worker field checks made the refusal tests fail
for labels, owners, annotations, finalisers, mode, other spec fields, image,
volumes, another home disk and Pod metadata. Removing the suspension check let
a Running update through and made its test fail. All mutations were restored.
Stale resource versions were refused by Kubernetes. Old-image CREATE/UPDATE
refusal is an existing regression check.

The first full run found an old assertion that the worker could not read
templates. The corrected test permits the required read and still refuses a
write. The final full runs passed afterwards.

The PR records findings 1 and 2 as confirmed, with the reviewed code and
[controller source](https://github.com/kubernetes-sigs/agent-sandbox/blob/v1.0.4/controllers/sandbox_controller.go).
The source handles PVCs before Pods and re-adopts a detached PVC that retains
its tracking label. Updating in place removes that detach/delete sequence.

## 13 October 2026 — computer image release

Source: `2b4d7358fc0729821766e866d6e23de5c193565b`, based on main `5b3e324c3830c8530004487424f56e365444000c`.
The final commit adds release records and splits unchanged test token setup into named steps.
The image is `k3d-ocn-registry:5000/opencrane/computer@sha256:2a0fe2d8c956f0b03d4267c476aa514239697d18ca7473dea6674f22c0e78be6`. The registry's `qualification` and `p2-1` tags
match that digest. The full build moved `p2-1` only after every probe passed.
The licence scan accepted all 385 packages and checked 92 installed notices.
The updated inventory, SBOM and results are in
[the image evidence](../../apps/computer/evidence.json).

Round 1 failed because the final change in #368 replaced the JavaScript wrapper
path with Codex's native ELF executable while keeping Node in front of it.
The protected wrapper launch added by #371 was valid. The exact startup lines were:

```text
/spike/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex:1
SyntaxError: Invalid or unexpected token
Node.js v22.23.1
```

Round 1 stopped after 116.76 s. The gate reproduced `Error: Codex connection closed`. This was a real startup
defect. Restoring `/usr/local/bin/codex` as the Node script fixed it without changing
capabilities, mounts or writable paths. Debugging stays disabled and inherited Node
options cannot enable it. The later private-turn fixture now uses the root-only
credential installer; its old `POST /credentials` call had also become obsolete.

The new image's bridge was checked for `--disable-sigusr1` and absent `NODE_OPTIONS`,
including startup with hostile inspector options. `POST /credentials` returned 404.
Credential rotation and a local stub turn passed. No real model calls were made.
Two early attempts at the added environment assertion hit `/proc` access restrictions;
the final assertion reads the bridge environment as its own user. All eight checks passed.

| Check | Result | Duration |
| --- | --- | --- |
| Original private-capabilities gate | FAIL before fix | 9.31 s |
| Failing-first launcher regression | FAIL before fix | 1.44 s |
| Corrected private-capabilities gate | PASS | 1.40 s |
| Launcher and private Codex unit tests (6 tests) | PASS | 1.95 s |
| Complete build.sh, every gate; 81 private-turn checks | PASS | 458.32 s |
| Credential and debugger tests against the new image (8 tests) | PASS | 45.01 s |
| Complete lifecycle file (11 cases, one worker) | PASS | 584.13 s |
| Full root suite (4,318 passed, 18 skipped; two workers) | PASS | 3160.29 s |
| Lint | PASS | 309.36 s |
| Typecheck | PASS | 187.78 s |
| Event catalogue (130 event types) | PASS | 0.83 s |
| Final Markdown, local links and changelog checks | PASS | 6.80 s |
| GitHub CI | NOT RUN at receipt; the PR checks report the pushed commit | — |
| Real model calls, managed cluster and full-stack browser journey | NOT RUN | — |

The lifecycle file ran once with `DEV_STACK_ID=1`, `LIFECYCLE_K3D=1`, a private
throwaway `PG_TEST_URL`, `--maxWorkers=1` and `nice -n 10`. All 11 cases passed.
The tests removed their namespaces and admission policies. Slot 1 was released and
the throwaway database was removed with its volume. The owner stack was untouched.
Local logs and command timings are in `/tmp/img-release-2/` on the builder host.

## 20 October 2026 — Stop image qualification

Source: `9ab903795c071e3d7ec43903837c296c6ffc70ac`, based on main
`9153c8dabf5eadceb86e242d02a1abb10189908c`. Only claimed secondary slot 1
was used, with the local stand-in model. No paid model call was made.
The released image is
`k3d-ocn-registry:5000/opencrane/computer@sha256:a30319e3744510ea38fa59928f0881444a51c61c33934e0458f87189413515bc`.
Both `qualification` and `p2-1` match it. The release tag moved only after every
build gate passed, including all 81 private-turn checks.

The previous image did not reproduce the paid-model Stop failure. On
`sha256:2a0fe2d8c956f0b03d4267c476aa514239697d18ca7473dea6674f22c0e78be6`,
two focused checks ended in 1.534 s and 1.487 s. Both saved the conversation and
computer end reports, left Stopping and kept `Hello` with its trailing space after reload.
The existing full startup journey also passed Stop at both viewport widths.
The [old-image records](demo-real-model-stop/old.json) include both screenshots.
The server and web chat code matches the earlier demo branch. No main-code
Stop defect was demonstrated. An image-only cause of the paid failure remains
NOT PROVEN.

The computer's saved report for the first focused check was:

```json
{"conversationId":"4645a9ea-ea96-4626-877a-204079dfaa65","assistantId":"personal-73d770dde01f8ce0aee9d9309ea3167d","turnId":"8ab0094b-b6bf-4aac-b065-a51b78a81c5d","type":"agent.turn_failed","previousSequence":57,"sequence":58,"requesterId":"zitadel-member"}
```

The server saved `agent.turn_failed` with `reason: "bridge_interrupted"` and
`computer.turn_closed` with `status: "failed"`. Computer and server logs contained
no bridge error message for these checks. Each stopped call kept its 16-cent hold.
The gateway recorded `effect.uncertain` with `reason: "missing_usage"`.
A dispatched call without final usage keeps its reservation under the existing
money rules; stopping its local work does not prove a zero cost.

On the new image, the focused checks ended in 2.056 s at 390px and 2.156 s
at 1280px. Both kept the partial reply after reload and left Stopping. Each
conversation saved `agent.turn_failed`; each computer saved `computer.turn_closed`.
Both terminal reports were also present in the computer's own journal. The running
Pod digest matched the released image. The [new-image records](demo-real-model-stop/new.json)
include both screenshots and the saved reports.

The settlement/release condition did not pass. A later event-store read still
showed both 16-cent holds and `effect.uncertain` with `reason: "missing_usage"`,
with no settlement. No money rule changed. Both old and new checks sent
`Say hello again.` to the stand-in and pressed Stop after its first text arrived.

The first complete build failed in the image probe:

```text
AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
+ 'failed'
- 'completed'
apps/computer/test/run.mjs:116:10
```

The probe's grant and removal requests omitted the turn id required by the newer
proxy. A failing-first assertion reported `actual: { error: 'bad input' }`,
`expected: { ok: true }`. Commit `8f7cc5387` records that test before the fix.
The fixture now supplies separate turn ids and checks successful replies.
Expiry and cross-thread refusals still run. No runtime access, money or
credential check changed.
The package's two computer-image references now match the released digest.
Its reviewed component inventory and checksum are unchanged. The package licence
checker and its refusal tests passed without a policy change.

| Check | Result | Duration |
| --- | --- | --- |
| Old-image fresh startup journey | PASS | approximately 686 s |
| Old-image focused Stop, twice | PASS for Stop; holds retained | 80.70 s |
| First complete build | FAIL: outdated grant fixture | 169.43 s |
| Failing-first grant assertion | FAIL before fixture fix | 28.70 s |
| Corrected complete image probe | PASS | 144.78 s |
| Complete build after fixture fix; second run of changed probe | PASS | 565.82 s |
| Complete lifecycle k3d file (11 cases, one worker) | PASS | 714.81 s |
| Fresh stand-in startup journey; existing approval check skipped | PASS | 765.86 s |
| New-image Stop, twice, and screenshots | PASS | 88.66 s |
| Stopped calls settle or release their holds | FAIL: both holds retained | 88.66 s |
| Credential and debugger checks (9 tests) | PASS | 63.29 s |
| Typecheck | PASS | 262.21 s |
| Event security rules | PASS | 5.09 s |
| Event catalogue | PASS | 0.87 s |
| Knip | PASS | 7.88 s |
| Changelog | PASS | 0.53 s |
| Package licence check; 14 checker tests | PASS | 0.45 s; 0.88 s |
| First lint | FAIL: receipt Markdown spacing | 580.64 s |
| Second lint | FAIL: package still named the old image | 610.96 s |
| Lint after updating the package image references | PASS | 687.19 s |
| Full root suite (6,619 passed, 64 skipped) | FAIL: 8 tests and one cleanup hook | 9203.27 s |
| Eight failed root cases, each alone | PARTIAL: 6 passed, 2 failed | 458.51 s total |
| Memory rebuild with its three preceding setup tests | PASS: 4 tests | 22.83 s |
| Separate web test suite | PASS | 91.21 s |
| Throwaway PostgreSQL and volume removal | PASS | 0.97 s |
| Secondary stack removal and slot release | PASS | 43.54 s |
| Final Markdown, local links and changelog checks, then confirmation | PASS | 13.04 s; 11.38 s |
| GitHub `ci-ok` | NOT RUN at receipt; the PR reports the pushed commit | — |

The full root suite remains FAIL. The provider-history case repeated its
30-second timeout alone. The isolated memory rebuild returned 404 because an
earlier test creates its member and binding; that four-test group passed.
The other six failed cases passed alone, including the saved-Stop case, which
had failed while starting its gateway fixture. No test timeout or access
deadline changed. Individual results and durations are in
[the image evidence](../../apps/computer/evidence.json).

All build, typecheck and test commands used `nice -n 10`.
Slot 1 was released, and its namespace was removed. The throwaway PostgreSQL container
and volume were removed. Only this task's test resources were removed; the
owner stack was untouched. The released image remains in the registry.
Local commands, timings and focused browser records are in
`/tmp/demo-real-model-stop/` on the builder host.
