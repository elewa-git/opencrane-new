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
