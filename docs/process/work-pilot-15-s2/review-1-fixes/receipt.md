# Scheduled backup review fixes

Historical review-fix attempt. The [current receipt](../ci-application-2026-11-16/receipt.md)
records CI application approval and the final fresh packaged journey **PASS**.
The observations below describe the earlier attempt only.

Date: 16 November 2026. Fresh packaged journey: **PARTIAL**.
Application-image approval: **NOT RUN**, pending the owner's decision on #15.
The pull request remains a draft. This receipt records the builder's own checks.

Qualification head and candidate source:
`85173744c3139f3eb00e3a6fe903b14daaf769ec`.
The final cleanup imports the shared digest under the older local names, keeping
the existing large capture functions at their original size. The receipt commit adds evidence;
it does not change the runtime. Earlier live results do not qualify this repair.

## Findings

| Finding | Verdict | Evidence |
| --- | --- | --- |
| 1: require ready services before publication | PASS | Test commit `98529bc3d` reproduced accepted scales with unavailable replacements through the actual restart method, during both successful capture and failed-part recovery. Every stopped deployment receives a bounded rollout check. Failure retains maintenance and the lock, publishes nothing and reports maintenance. |
| 1: allow the readiness watch | PASS | Test commit `b515fcc9a` first failed because the named deployment rule allowed only get. The rule now permits get/list/watch for the same ten deployments. Its names and verbs have exact assertions. |
| 3: exercise the real adapter's guards | PASS | Real pause, checkpoint reader, verify, event capture and restart methods are exercised with disposable NATS and controlled Kubernetes/database boundaries. Every listed violation refuses publication and recovers. All 14 required projections have individual cases. |
| 3: break each guard by hand | PASS | Removed each of ten guards individually: initial replica count, Pods gone, projection catch-up, deployment at zero, stream creation, first sequence, last sequence, message count, database clients and descriptor sequence. Every selected test failed. Restored every guard. The projection test checks stop ordering; the descriptor test checks failure during parts rather than a later verification. |
| 4: share the byte-digest rule and name call values | PASS | Scheduled, component and object capture import `backup-bytes.ts`; the storage adapter uses it too. Manifest input, storage options and archived/serialised objects are named before their calls. Known abc/empty-byte checksums and independent object checksum assertions pass. |
| 4: failing runtime test for equivalent duplicate implementations | NOT RUN | Equivalent digest copies have the same observable result. Known-byte vectors were committed before extraction; no artificial source-text assertion was added. |
| 2: independent application-image approval | NOT RUN | Left every approval pin and review binding unchanged in this round. The new runtime needs a new approved application image. A candidate build or passing scanner workflow does not approve that image. |

Each scale request has a five-second limit. After all scale attempts, every saved
deployment receives a concurrent rollout wait with a 60-second Kubernetes limit
and 65-second process limit. Recovery is independent of the capture deadline and
is bounded at 115 seconds for the ten services. The recovery tests include an
expired capture deadline as well as a failed part. The earlier large capture
functions retain their original size; digest extraction removes their local
implementations without rewriting their bodies.

## Gates

| Check | Verdict | Evidence |
| --- | --- | --- |
| Final focused tests twice | PASS | 113 tests per run, in 181.35 and 148.79 seconds. Used one worker and waited for load below 10 before each run. Includes scheduled adapter, publication, component capture and object capture tests. |
| Chart tests twice | PASS | All 251 cases in 43.46 and 48.38 seconds. |
| Saved-image tests twice | PASS | All 15 cases in 235.93 and 197.63 seconds. |
| Typecheck | PASS | Every workspace, package and dev-stack project. |
| Changed-file ESLint | PASS | Used the repository rules with the package TypeScript project because root ESLint excludes infrastructure. No warnings remained. |
| Event catalogue | PASS | All 174 registered event types agree with the catalogue. |
| Knip | PASS | Retains its two existing configuration hints. |
| Changelog, Markdown and package READMEs | PASS | Used the branch release note; did not edit CHANGELOG.md. Markdown ran without file arguments. |
| Fetch and rebase | PASS | Rebased onto `9e7579b50`; rebase completed. |
| Public privacy and secret scans | PASS | Ran before every source push. |
| Qualification-head scanner | PASS | [Run 43846555934](https://github.com/elewa-git/opencrane-new/actions/runs/43846555934) approved the exact qualification head before the packaged claim. |
| Qualification-head CI | PARTIAL | [Run 43846561310](https://github.com/elewa-git/opencrane-new/actions/runs/43846561310) was running when this receipt was saved. Final results are recorded in the PR checks. |

All tests, builds, lint and typecheck ran under `nice -n 10`. No full local root
suite ran. Normal disposable test fixtures and the shared PostgreSQL test URL
were used. No dependency was added.

Typecheck first found incorrect metadata shapes in the new fixture; its database
and file substitutes now return their actual adapter contracts. A loaded run also
failed the existing deadline test before its home reader opened: it controlled
performance time but left abort expiry on real time. The fixture now controls
both. No deadline, guard or assertion was loosened. The final repeated runs above
include both corrections.

## Fresh-stack attempt

| Step | Verdict | Observation |
| --- | --- | --- |
| Fresh secondary Compose claim | PASS | Claimed slot 1 at load 6.53 for runtime head `08a450e1f`; supplied the sign-in key by `ZITADEL_KEY_FILE` path only and retained the fleet marker. |
| `up.sh --fresh` | FAIL | Owner bootstrap, managed-call setup and website readiness completed; website readiness took 58.50 seconds. The subsequent journey failed. The private step diagnostic was not retained through cleanup, so the failed step is not established. This is supplementary startup evidence only. |
| Compose `package-down` and `down.sh` | PASS | Both exited zero and released the slot. |
| Fresh packaged claim | PASS | Claimed slot 1 again at load 9.17 after the final-source scanner approval passed. |
| `package-prepare` | PASS | Downloaded the exact-head CI scanner approval and prepared the owned namespace. |
| Private package settings | PASS | Used `PACKAGE_SKIP_PROVIDER_SETUP=1` and checked the existing test sign-in setup in read-only mode. |
| `package-check` | PASS | Checked namespace ownership only. No application was installed. |
| `package-up` | NOT RUN | The unchanged approved application source is `8601e8b4351d65f324d07bcb04cedcf8441f4354`. It does not contain the repair. Independent approval of the new application image is pending; installing the older image would not qualify this runtime. |
| Person uploads and chats at 1280 and 390 px | NOT RUN | Requires the repaired application image. |
| Operator completes a backup, lists it and reads its manifest | NOT RUN | Requires the repaired application image. |
| Broken part fails visibly without publication | NOT RUN | Requires the repaired application image. |
| Packaged screenshots at 1280 and 390 px | NOT RUN | No repaired packaged application was installed. No earlier screenshot is counted. |
| Save operator output before cleanup | PASS | [Operator output](operator-output.txt) was written as commands ran, before teardown. |
| Packaged `package-down` and `down.sh` | PASS | Both exited zero and released the slot. The owner stack was not touched. |

## Unapproved candidate image

Built from runtime source `85173744c3139f3eb00e3a6fe903b14daaf769ec` using the
package Dockerfile and its source-revision label. The new shared helper is included
in the Docker context and the package-file allowlist; missing it refuses import
validation. No image was published, installed or promoted.

OCI index: `sha256:2bff7cd0c9b6105a5f50e6177e8487bce59497b6c4eaabcd9acc71c425739b55`.
Configuration: `sha256:24c37ab33aa7b564afb69fa368eaeb0c111ad8e7e99e0c5c7cd0546f4f083e2a`.
All-layer Syft scan: **PASS**, 580 components. Scan SHA-256:
`1ab1bb3cf95fe255255ffc8210f87a30468b7c906da31826a99aa7020a6120ab`.
The unchanged promotion checker refused this candidate against the existing
approval bindings with exit one. This is an expected refusal, not approval.
The candidate archive, inspection and scan remain private review inputs.

Independent approval and a fresh packaged journey remain required. Restore,
computer homes, three event-log copies and off-machine durability are outside
this slice.
