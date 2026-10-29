# Private memory evidence collector

For people, read [README.md](README.md) first.

## Scope and invocation

Part of #97, P4-15 PR 5c, first part. Import `collectEvidence` from `collect.ts`:
`await collectEvidence(bundlePath, expectedRun, observeDeployment)`.
There is no deployment launcher, production writer or admission caller in this part.
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

A future deployment-owned launcher must create the run binding on a fresh install,
record exact source/image/environment measurements, run both complete qualifications,
and collect safe receipts before calling the function above. Existing PASS receipts,
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
checks them directly. Settings: none. Dependencies: existing MIT Zod and Node built-ins.
No events or public API fields are added. All JSON field names were checked against
the unchanged `RISKY_FIELD_NAME` rule. Receipt digests contain no private text hashes.
Own results and outstanding live work: [receipt](../../docs/process/p4-15-pr5c/receipt.md).
