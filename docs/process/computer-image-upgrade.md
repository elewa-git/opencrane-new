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
