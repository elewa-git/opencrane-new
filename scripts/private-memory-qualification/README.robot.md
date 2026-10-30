# Private memory evidence collector

For people, read [README.md](README.md) first.

## Deployment collection

P4-15 PR 5e adds `await collectDeployment()` and `run.mjs`. The older file
parser below remains refusal-only. The disabled initial-load command reads only the
collector-owned result described below. No admission switch is added.

The collector uses `/usr/bin/docker` and the local `/var/run/docker.sock` only.
The deployment owner controls Docker, the image build and the collector process.
Browser, model and application users must have no access to these. Infrastructure
operators remain outside the application privacy promise. The collector accepts no arguments. Any supplied argument refuses before Docker runs.
The fixed `/etc/opencrane/private-memory-qualification.json` file contains exactly
`containerId` (64 lowercase hex characters) and `siloId` (the expected raw `SILO_ID`).
It must be a root-owned regular file, at most 1 KiB, with no group or world write
permission. Final symlinks are refused. Root must also own and protect its parent
directories. The deployment owner installs this file; neither its path nor target
can be selected through command-line arguments or environment variables. The
measured container id and silo must match it. Replacement requires the owner to
update the configured container id. No evidence bundle or caller observation is accepted.

Docker supplies the full container id, running image content digest, image revision
label, daemon identity, start time and `SILO_ID`. The source label must be a full
40-character revision. The host and silo form a hashed `environmentId`; the silo
and container/start/event-stream identity are also hashed. Raw names and environment settings
are not returned. The image must have a read-only root filesystem. Mounts outside
`/run/` and `/var/` refuse, so code and interpreter overrides cannot qualify.
Node runs from its absolute image path, with a fixed working directory and cleared
`NODE_OPTIONS`, `NODE_PATH` and `LD_PRELOAD`. No caller selects the child command.

Before journeys, a fixed Node probe uses the deployment's existing TLS/NKey NATS
connection to inspect `EVENTS`. Both message count and last sequence must be zero;
a purged stream with previous events refuses. The stream must have been created
after the container, and the container within five minutes. This is the measured
fresh event-store condition, before owner bootstrap. It does not replace the full
private-process and persistence journeys. Restarts and identity changes refuse.

Each of the nine checks and both complete qualifications executes the fixed
`/app/scripts/private-memory-qualification/journey.mjs` inside that container.
The runner receives one JSON object on stdin: measured binding, `name`, fresh
`runId` and fresh per-check `challengeId`. It must perform that named journey,
then return only the same fields plus `observedAt` (epoch milliseconds),
`result: PASS` and `complete: true`. Partial, missing, extra, stale or mismatched
results refuse. Every process has a two-minute timeout and a combined stdout/stderr
limit of 64 KiB. The collector injects `supervisor.mjs` into each Docker exec. This
supervisor starts the fixed command in a new Linux process group and keeps stdin
open as a connection to the collector. EOF, including collector SIGTERM or SIGKILL,
cancels the group. The supervisor also enforces the timeout and output limit inside
the container, independent of the Docker client. Normal completion kills any
remaining children before returning output.

The supervisor holds `/run/opencrane-memory-qualification.lock` until all running
group members have stopped. A concurrent run refuses; it cannot remove another
run's lock. The runner must keep its children in that group. The image needs a
writable `/run` and Linux `/proc`. A failed cleanup keeps the lock and refuses
retries; the deployment owner must resolve the failure before retrying. The host
also bounds Docker attachment to 130 seconds, allowing ten seconds for cleanup.
The collector measures identity and event-stream creation before and after every child. A copied response
cannot match the new challenge. It does not accept detached receipts or signatures.

Only validated metadata is hashed into `receiptDigests`; no memory text is hashed.
All child output and errors stay in process memory. Failures expose only
`FAIL / collection_failed`. Success reports measured identity, the nine checks,
both qualifications and receipt digests. This output is not an admission token.
The collector atomically writes its own result to
`/etc/opencrane/private-memory-qualification-result.json`, using a new file with mode 0600.
A new collection first replaces the prior result with FAIL. Only its own complete run
can replace that with PASS. The owner runs the collector as root and protects the parent
directories. No event is appended and no admission setting changes. Saved JSON cannot
be fed back into this collector. The older file parser still cannot return PASS.

`readDeploymentQualification(silo)` reads that fixed file with no symlink following.
It requires a root-owned regular file, no group or world writes, and at most 8 KiB.
It parses the collector's complete output shape and requires nine PASS checks, both
complete qualifications and eleven distinct receipt digests. It independently measures
the current deployment and event-stream creation, checks the silo, and rechecks the
configuration and result after the measurements. It returns the collector run id and a
synchronous check that those protected files still match. The initial-load command
retains that id, rechecks access after deployment reads, then checks the files without
another wait before each append. It repeats the checks after saving.
This reader requires local Docker access on the deployment host; no HTTP route exposes it.
Delivery and production admission remain disabled.

**Live qualification: NOT RUN.** The image-owned journey runner is deliberately
left to P4-15 PR 5d, with its claimed dev stack and enable-and-journey work. It must
bootstrap the empty silo and implement the complete journeys listed below, including
the private-memory cleanup required by those journeys. The collector owns process cancellation. A missing runner refuses today. Simulated Docker responses prove collection and refusals. Disposable Node containers
prove process cancellation on timeout, output overflow and collector exit. These
tests do not qualify an actual application image or host. Kubernetes collection is outside this first part.

## File parser scope and invocation

Part of #97, P4-15 PR 5c, first part. Import `collectEvidence` from `collect.ts`:
`await collectEvidence(bundlePath, expectedRun, observeDeployment)`.
This file parser has no deployment launcher, production writer or admission caller.
Every valid bundle returns `NOT RUN / live_launch_unavailable`; invalid input returns
`FAIL` with a fixed reason. No result can satisfy `personalRecallQualified`.

The deployment owner must supply `expectedRun` from its own current measurements,
never from the bundle, a browser, computer, model or command-line JSON claim.
`observeDeployment` returns the current binding before and after collection. A child
failure must reject its promise; the collector returns only `collection_failed`.
The observer must bound child execution and keep its output private. No child is
started here. These tests inject observations and failures, without a live process.

## Exact contract

The binding contains `sourceSha`, `imageDigest`, `environmentId`, `runId`,
`installationId` and `freshInstall: true`. Reuse the server's `personalRecallQualified`
format checks: full 40-character source SHA, immutable `sha256:` image digest and
bounded environment identity. The deployment owner creates a fresh UUID `runId`
for each run and a different UUID `installationId` whenever the deployment is replaced.
The expected run adds `evidenceDigest`, a SHA-256 digest of the exact manifest bytes.
All receipt digests are covered by that manifest digest. Digests detect changes;
they do not authenticate a test or prove that it ran.

`private-memory.json` is at most 65,536 bytes. It contains the binding,
`result: PASS`, `checks` and `qualifications`. Each array row contains only
`name`, `result: PASS` and `receiptDigest`. Checks must appear exactly once:
`privateTurns`, `nativeRecall`, `requesterIsolation`, `sessionIsolation`, `invalidation`,
`unrelatedActivity`, `stopReconnect`, `replacementReload`, `persistence`.
Qualifications must contain exactly `P4-14` and `P4-15`.

Each receipt lives beside the manifest as `<64 lowercase hex digest characters>.json`.
It is at most 16,384 bytes and contains only the same binding, its row's `name`,
`result: PASS` and `complete: true`. All files must be non-empty regular files;
final symlinks are refused. Extra fields, repeated/unknown checks, absent receipts,
non-PASS results and old run identities refuse collection. Parent directory custody
belongs to the deployment owner. No paths or private content belong in the JSON.

## Live invocation requirements

The deployment-owned journey runner must run both complete qualifications on the
measured fresh install through `collectDeployment`. Existing PASS receipts,
protocol fixtures and hand-written JSON cannot replace that invocation. Replacement
invalidates the old candidate, even when the image and host names stay the same.

The live journey needs simultaneous requester A/B canaries, the same requester in
two sessions, and a later requester. It must use saved facts through real native
recall, gateway, OpenFGA and current grants; answers must be absent from the request.
Revoke, Correct and Forget must stop affected work and reject late output. Unrelated
messages, uploads and memory activity must preserve unaffected turns and readers.
Stop, connection loss, reconnect, replacement and browser reload must clear old
output/grants without repeating work. Live and fault-time scans must inspect PVCs,
rollouts, caches, outbox, logs and dumps while canaries are present and persistence
is attempted. Shell/file/browser tools stay off; RAM, swap, crash dump and pinned
Codex/gVisor checks must pass. Missing launch leaves these journeys NOT RUN.

## Validation and ownership

Run the commands in README.md. The root Vitest include list does not discover this
folder, so the explicit config is required; no CI fixture list is changed.
The root lint and Knip projects include these files. The local TypeScript command
checks them directly. The only setting is the protected target file described above. Dependencies: existing MIT Zod and Node built-ins.
No events or public API fields are added. All JSON field names were checked against
the unchanged `RISKY_FIELD_NAME` rule. Receipt digests contain no private text hashes.
Own results and outstanding live work: [receipt](../../docs/process/p4-15-pr5c/receipt.md).
