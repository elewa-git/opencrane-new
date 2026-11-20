# Pilot VM sizing and bootstrap receipt

Date: 20 November 2026. Branch: `work/pilot-1162-s1`. Source installed:
`9ff04e9da075f687472a6754359fb19ace7b9a41`.

Journey on a fresh dev stack: PARTIAL

## Approval, ownership and fresh installation

PASS: rebase onto `origin/main` `ed3662d85` finished. A later fetch confirmed that main had not
moved. [CI](https://github.com/elewa-git/opencrane-new/actions/runs/44748477178), [application
approval](https://github.com/elewa-git/opencrane-new/actions/runs/44748505866) and [scanner
approval](https://github.com/elewa-git/opencrane-new/actions/runs/44748510712) passed on the
installed source before this attempt. The real approval consumers accepted both records; no
approval or runtime allowlist was substituted. [Exact
images](logs/fix-1/qualified-approvals.json).

Before claiming, checked both secondary ids every 30 seconds, required both to report free,
required no package stack and load below 6 continuously for five minutes. Another journey
repeatedly reset that window. The [observations](logs/fix-1/resource-window.jsonl) include those
resets and the qualifying interval. Never installed beside another secondary journey.

Fresh namespace `opencrane-package-1`, UID `c102af31-6444-41c3-9bf1-b3751d499869`; install id
`61be9127-a20d-434f-a65b-78d0b30ea1d9`. [Saved ownership and host
checks](logs/fix-1/install-record.json). These identities differ from the earlier attempts.

Used the PACKAGED procedure, with a new namespace, Helm install identity and PVCs. `up.sh
--fresh` is the Compose procedure; this attempt installed the approved Helm package instead. Ran
these commands with the claimed secondary id (1 or 2):

```sh
DEV_STACK_ID=$(infra/dev-stack/claim.sh)
export DEV_STACK_ID
nice -n 10 infra/dev-stack/run.sh package-prepare --id "$DEV_STACK_ID"
# Set and export PACKAGE_VALUES_FILE and ZITADEL_KEY_FILE by path only.
nice -n 10 node --experimental-strip-types infra/package/prepare.ts
OPENCRANE_ACCEPT_DEV_HOST_RISK=accepted-dev-box-366 \
  nice -n 10 infra/dev-stack/run.sh package-up --id "$DEV_STACK_ID" \
  --values "$PACKAGE_VALUES_FILE"
nice -n 10 infra/dev-stack/run.sh package-check --id "$DEV_STACK_ID"
DEV_STACK_ID="$DEV_STACK_ID" infra/package/forward.sh
# Run Chromium against the secondary loopback forward at both viewport widths.
# Save owned startup/service logs and measurements before teardown.
nice -n 10 infra/dev-stack/run.sh package-down --id "$DEV_STACK_ID"
nice -n 10 infra/dev-stack/down.sh --id "$DEV_STACK_ID"
```

Used the existing owner-approved local exception documented in [the package
contract](../../../infra/package/README.robot.md#accepted-local-exception). The saved preflight
still records F1 swap and F2 crash-reporting failures on this host. This is not a production
host-protection PASS. Changed no host setting. The owner stack was untouched. No paid model or
paid VM was used.

## Browser outcome

Used real SSO in the development organisation, Chromium at 1280 and 390 pixels, and the
package's scripted model provider. Reused the sign-in, PDF upload, message-completion and
anonymous-history refusal helpers. The three-person procedure invites and joins two additional
people through public commands, provisioning one assistant each. It sends three chat turns and
opens three desktops concurrently when setup succeeds. The desktop fixture uses normal
`grant.given` events and waits for their access projection, following the existing screenshot
journey; it changes no access guard. A visible xmessage window distinguishes decoded frames from
an empty canvas. Budget checks parse the real API response through the shared budget schema.

| People | Width | Sign-in / chat / history refusal | PDF answer | Desktop | Budget |
| --- | --- | --- | --- | --- | --- |
| 1 | 1280 | PASS | PASS | FAIL | PASS |
| 1 | 390 | PASS | PASS | FAIL | PASS |
| 3 | 1280 | NOT RUN | NOT RUN | NOT RUN | NOT RUN |
| 3 | 390 | NOT RUN | NOT RUN | NOT RUN | NOT RUN |

[Desktop timing observations](logs/fix-1/desktop-disconnect.json). Both upgrades succeeded, then
disconnected while the server lease was valid. No decoded desktop frame passed.

[Recorded assertions](logs/fix-1/browser-result.json). The invitation step returned 409 because
the collector supplied a non-UUID member id. The command correctly refused it. The collector now
creates UUIDs; a fresh three-person rerun could not obtain the exclusive resource window before
the task limit. The final window reset when load exceeded 6 again. Stopped new claims with time
left for logs, teardown and reporting; the two-hour resource wait did not expire. No fourth slot
was claimed.

PASS: the website retained zero restarts after both desktop disconnects. The viewer itself
remains FAIL. No failed or skipped condition is assembled into a passing journey. Full startup
and sanitised service logs were copied into the private task receipt before teardown, including
previous-container logs after any restart. Masked screenshots and selected observations are
retained alongside the public receipt: [chat at 1280](screenshots/one-person-chat-1280.png),
[chat at 390](screenshots/one-person-chat-390.png), [PDF answer at
1280](screenshots/upload-0-1280.png), [PDF answer at 390](screenshots/upload-0-390.png),
[desktop failure at 1280](screenshots/failed-extra-1-0-1280.png) and [desktop failure at
390](screenshots/failed-extra-1-0-390.png).

PASS: copied startup and sanitised service logs before teardown. Both `package-down` and `down`
exited 0; the secondary claim was released. [Exit results](logs/fix-1/final-status).

## Measured demand and machine recommendation

Measured on the existing 8-logical-CPU, nominal 16 GiB development box through its single shared
k3d node. Browsers run outside the measured node, as remote clients would. No second runtime was
started. These are local package measurements, not a proof that a smaller real VM meets every
latency or storage condition.

Sampled kubelet CPU, working-set memory and swap approximately every two seconds; the underlying
CPU counters refresh less often, so short bursts can be missed. The
[CSV](logs/fix-1/measurements.csv) and [summary](logs/fix-1/summary.json) retain sample
timestamps and phases. Package totals sum only the owned namespace. Whole-node demand also
includes Kubernetes services, the shared development gateway and runtime overhead. It excludes
the owner stack outside k3d. Added no pod and node totals together. For each CPU, working-set
and swap counter, use the greater of the node value and owned-pod sum to allow for different
refresh times. Then add working-set and swap bytes for the memory total. Memory sizing includes
observed swap use; it does not treat swapped pages as free.

Occupied disk uses read-only `du -sk` on only the bound PVC paths after matching namespace,
claim name and UID. Image-cache sizes are separate CRI image counters; they are not occupied PVC
bytes or block-I/O traffic. The host OS and long-term retained data still need reserve beyond
this short test.

| Observation | Package CPU / working-set RAM | Whole node CPU / RAM including swap |
| --- | --- | --- |
| Install peak | 3.592 cores / 3.07 GiB | 3.870 cores / 5.23 GiB |
| One-person active peak | 2.294 cores / 2.85 GiB | 2.953 cores / 5.10 GiB |
| One-person idle mean | 1.091 cores / 2.76 GiB | 1.678 cores / 4.86 GiB |
| Three-person active peak | NOT RUN | NOT RUN |
| Three-person idle mean | NOT RUN | NOT RUN |

Recorded 240 samples from 2026-11-20T14:33:10Z to 2026-11-20T14:41:08Z, with 0 sampling errors.
Idle means use the available samples; incomplete idle windows do not pass qualification. The
captured package peak was 3.592 cores and 3.08 GiB working set. The captured whole-node peak was
3.870 cores and 5.23 GiB including swap. CPU and memory maxima need not occur in the same
sample.

Observed bound-PVC use peaked at 77.63 MiB across 16 disk samples. [Disk
samples](logs/fix-1/disk-measurements.csv). End-of-run CRI counters totalled 1.48 GiB across 7
distinct image ids, before any inference about shared layers or unpacked filesystem size. [Image
counters](logs/fix-1/cached-images.json). These counters do not measure a clean VM image cache.

A measured minimum machine size and spare capacity remain **NOT RUN**. The desktop journey is
incomplete, and three concurrent people are not fully qualified. Do not use these partial
observations as a VM recommendation. The existing k3d node and its image cache were already
running; cold VM bootstrap, long-running assistant workloads and long-term storage growth are
outside this measurement.

## Earlier attempts and bootstrap limits

The original NOT RUN receipt correctly records an approval refusal before CI. Its
[original](logs/image-approval.log) and [committed-source](logs/final-image-approval.log) logs
remain; no bypass was used. After rebase and approvals, two earlier fresh installs on
`856a0274c` were attempted and torn down:

- Attempt 1: install/check, owner SSO/chat/PDF at 1280 passed; desktop refused
  because the collector omitted its normal grant fixture. Remaining conditions
  were NOT RUN. The collector was corrected; no product access check changed.
- Attempt 2: with the grant fixture, desktop admission succeeded but the website
  exited with unhandled `write EPIPE`. Captured the previous web-container log
  before teardown. Test `5c332d5d7` reproduced the process exit before the shared
  connection-handling fix. The [retained crash](logs/fix-1/web-previous.log) and
  [own-check receipt](checks.md) record it. These attempts are FAIL and do not
  qualify sizing or either complete viewport journey.

The actual-host bootstrap was run only with `--dry-run`; its existing-runtime refusal was safe
and expected. Complete plan output and configuration behaviour were checked in unprivileged,
network-isolated containers with stubbed system operations. Real Ubuntu VM bootstrap, reboot and
VM runtime/storage qualification remain NOT RUN. No independent-review result is claimed.
