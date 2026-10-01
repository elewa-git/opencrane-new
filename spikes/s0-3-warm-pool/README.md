# S0.3: warm claims and suspension by disk

Issue #14, parent #7; decision in [ADR 0006](../../docs/adr/0006-computer-disk-and-live-view.md).
This spike uses the [S0.1b computer](../s0-1b-proxy-gvisor/README.md), real Agent
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

Receipt: base `36b1ca5` plus the sources in this commit, fresh namespace/PVC/Pods
on the existing k3d cluster, local-path storage on one node. [evidence.json](evidence.json)
contains safe receipts, source hashes, runtime digest and all latency samples.
Raw local logs are in `.state/`; no tokens or browser profile are committed.

| Point | Result | Proof from the runner |
| --- | --- | --- |
| Neutral warm claim, then computer binding | PASS | Ten claims adopt exactly the pre-existing Pod UID, add the computer label at claim, then delete the bound Pod. |
| Warm Pod mounts an existing disk on resume | PARTIAL | Kubernetes rejects the attempted volume change. A claim with `volumeClaimTemplates` starts another Pod while a ready neutral Pod remains unclaimed. |
| Suspend retains disk and frees Pod | PASS | Each Sandbox deletion is followed by asserted Pod absence and an unchanged standalone PVC UID. |
| Files and browser login survive | PASS | Ten fresh Pods read the original workspace file and launch real Chromium with the same profile; the local site recognises its persistent HttpOnly cookie on `/account`, without revisiting `/login`. |
| Codex thread survives | PASS | Ten app-server processes call `thread/resume` with the same thread ID, recover earlier turns and complete another turn through the gateway. |
| Both grants refreshed; old grants refused | PASS | Each resume rotates the computer and turn grants. Old computer + fresh turn and fresh computer + old turn each return 403; the real resumed turn succeeds. |
| S0.1b isolation retained | PASS | CRI reports `io.containerd.runsc.v1`; the extended image's model-requested tool returns `ISOLATION_PASS`. |

Latency uses `performance.now()` and nearest-rank percentiles over ten runs.
Claim spans API apply to Ready plus the computer label on the same warm Pod;
it excludes replenishment. Resume spans creation of the new PVC-mounted Sandbox
through Ready, Codex thread recovery/completed turn, file check and Chromium login
verification. It is **cold PVC resume**, not warm attachment or merely scheduling.
All image layers were cached. No latency SLA is inferred from this single box.

| Measurement | p50 | p95 | Runs |
| --- | --- | --- | --- |
| Warm claim | 385 ms | 530 ms | 10 |
| Cold PVC resume, full checks | 9,737 ms | 13,516 ms | 10 |

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

`npm run lint`, `npm run typecheck`, `npm run check:events` (70 matching event
types) and `PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres npm test`
passed; the final normal test run passed **43 files / 853 tests** in 105.60 s.
Two earlier test attempts had timing failures under concurrent shared-box work:
four failures in append/shutdown in the first run, and one realtime timeout in
a single-worker run. No application code or test deadlines were changed.
S0.1b's own real-service runner was rerun after its fixture changes and passed.
The only changes there add loopback-only issuer rotation and a scripted
`AFTER_RELEASE` continuation; its computer, executor and isolation policy are unchanged.
Web build and web tests also passed (**2 files / 27 tests**). Spike Markdown
checks passed, and a final cluster query found no spike namespaces or retained PVs.
