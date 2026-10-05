# S0.3: warm claims and suspension by disk

For people, read [README.md](README.md) first.

Issue #14, parent #7; decision in [ADR 0006](../../docs/adr/0006-computer-disk-and-live-view.md).
This spike uses the [S0.1b computer](../s0-1b-proxy-gvisor/README.robot.md), real Agent
Sandbox 1.0.4, gVisor, Chromium and Codex 0.159.2. The provider is S0.1b's scripted
Responses server behind agentgateway, not a paid model. It uses only this box.

## Run

From the repository root on the [developer box](../../infra/devbox/README.md),
with Node 22, Docker, kubectl, the existing pinned S0.1b registry image and `npm ci`:

```sh
./spikes/s0-5-live-view/build.sh
node spikes/s0-3-warm-pool/run.mjs
```

The runner requires context `k3d-ocn`, refuses an existing `s03-warm` namespace,
and deletes its fresh namespace, Pods and PVCs in `finally`. An externally killed
runner may need `kubectl delete ns s03-warm`. Images/cache in the local registry
remain for reuse; no other namespace is removed. No keys are read.

## Results — 1 October 2026

Receipt: rebased branch plus the sources in this commit, fresh namespace/PVC/Pods
on the existing k3d cluster, local-path storage on one node. [evidence.json](evidence.json)
contains safe receipts, source hashes, runtime digest and all latency samples.
Raw local logs are in `.state/`; no tokens or browser profile are committed.

| Point | Result | Proof from the runner |
| --- | --- | --- |
| Neutral warm claim, then computer binding | PASS | Ten claims adopt exactly the pre-existing Pod UID, add the computer label at claim, then delete the bound Pod. |
| Warm Pod mounts an existing disk on resume | PARTIAL | Kubernetes rejects the attempted volume change. A claim with `volumeClaimTemplates` starts another Pod while a ready neutral Pod remains unclaimed. |
| Suspend retains disk and frees Pod | PASS | Ten native `operatingMode: Suspended` transitions assert Pod absence, the Suspended condition, and unchanged Sandbox and standalone PVC UIDs; `Running` creates a new Pod. |
| Files and browser login survive | PASS | Ten fresh Pods read the original workspace file and launch real Chromium with the same profile; the local site recognises its persistent HttpOnly cookie on `/account`, without revisiting `/login`. |
| Codex thread survives | PASS | Ten app-server processes call `thread/resume` with the same thread ID, recover earlier turns and complete another turn through the gateway. |
| Both grants refreshed; old grants refused | PASS | Each resume rotates the computer and turn grants. Old computer + fresh turn and fresh computer + old turn each return 403; the real resumed turn succeeds. |
| S0.1b isolation retained | PASS | CRI reports `io.containerd.runsc.v1`; the extended image's model-requested tool returns `ISOLATION_PASS`. |

Latency uses `performance.now()` and nearest-rank percentiles over ten runs.
Claim spans API apply to Ready plus the computer label on the same warm Pod;
it excludes replenishment. Resume spans the patch to `operatingMode: Running`
through Ready, Codex thread recovery/completed turn, file check and Chromium login
verification. It is **cold PVC resume**, not warm attachment or merely scheduling.
All image layers were cached. No latency SLA is inferred from this single box.

| Measurement | p50 | p95 | Runs |
| --- | --- | --- | --- |
| Warm claim | 384 ms | 495 ms | 10 |
| Native suspension to Pod absence/condition | 1,381 ms | 2,786 ms | 10 |
| Cold PVC resume, full checks | 10,242 ms | 13,994 ms | 10 |

Milestones below are cumulative from the Running patch. Stage durations are
measured separately for each run, not calculated by subtracting percentiles.
`checksReady` covers revoked-token probes, a completed turn and the file read;
`browserReady` includes launching Chromium, checking its account and closing it.
These are sequential qualification timings, not a product readiness SLA.

| Resume milestone | Cumulative p50 / p95 | Stage p50 / p95 |
| --- | --- | --- |
| Pod ready | 2,450 / 2,542 ms | 2,450 / 2,542 ms |
| Codex ready | 3,348 / 4,135 ms | 1,036 / 1,709 ms |
| Thread ready | 4,145 / 5,348 ms | 804 / 1,426 ms |
| Grant/turn/file checks complete | 6,717 / 8,741 ms | 2,362 / 3,393 ms |
| Browser verified and closed | 10,242 / 13,994 ms | 3,500 / 5,253 ms |

Adopt native Suspended/Running: it retains the Sandbox identity and lets the
controller stop/recreate its Pod without a custom delete/recreate lifecycle.
Files, login, thread and rotated grants pass all ten cycles. This is still a
cold Pod; the literal warm-Pod resume criterion remains **PARTIAL**.

## Storage and credentials

The PVC has `/home/agent/workspace` (UID 1001), `codex` (1000, mode 0700), and
`profile` (1002, mode 0700). Existing harness paths link to these directories.
The proxy caller capability, token canary and desktop passwords remain in the
new Pod's ephemeral homes. Browser/Codex processes stop; unsaved forms, open tabs
and running jobs do not survive. Browser shutdown is graceful before suspension.
The local browser route requires its own fresh 60-second capability, passed over
stdin to CDP and stripped by the gateway before the site; an unauthenticated
request returns 403. It is never a Codex computer/turn token. The trusted desktop launcher uses `no_new_privs`; the tool executor retains its
unchanged deny-all-sockets seccomp filter. [Licences and image pins](../s0-5-live-view/LICENCES.md).

Plain reattach of an existing PVC needs **no CSI snapshots**. Local-path is
node-local and unencrypted. Snapshot-based backup/rollback/clone to another PVC
needs a snapshot-capable CSI driver and quiescing; snapshots do not solve Pod
volume immutability. Cross-node reattachment depends on the storage backend.

**NOT RUN:** GKE/cloud, CSI snapshot/restore, encrypted volumes, multi-node or
node-loss recovery, Pod/process checkpoints, paid-model semantics, production
IAM/event-backed lifecycle, full fresh-silo journey. The literal warm-PVC-resume
criterion remains unmet; the cold path is a proposed plan adjustment, not a PASS
for that criterion. No independent review was run by this task.

## Repository gates

After the review fixes, `npm run lint`, `npm run typecheck`,
`npm run check:events` (70 matching event types) and
`PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres npm test` passed.
The full test suite passed **43 files / 853 tests** in 101.70 s. Both spike runners
passed their implemented checks; S0.3 remains **PARTIAL** against warm-Pod resume.
Spike Markdown checks passed. Both namespaces and their PVs were removed.
No review pass or push was performed. Web build/tests and the separate S0.1b
runner were not repeated for these fixes; their earlier evidence remains in the
preceding receipt. Neither local spike is a fresh-silo qualification.
