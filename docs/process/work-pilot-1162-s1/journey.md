# Pilot VM sizing and bootstrap receipt

Date: 22 November 2026. Branch: `work/pilot-1162-s1`. Source installed:
`e0c4a9b063f5cfcdd189134eaa145592727110fb`.

Journey on a fresh dev stack: PARTIAL

The constructor cause is fixed. The one-person package sizing observations are recorded below.
They are measured demand, not a qualified minimum machine size. Three-person sizing was dropped
from this ticket by the owner because the pilot runs on this box.

## Source, ownership and fresh installation

PASS: fetched main at the start and before pushing. It remained
`ed3662d8530338cde94d557713264f1ebf1057ae`, already contained in this branch. No rebase was needed
or left in progress. The installed source passed
[CI](https://github.com/elewa-git/opencrane-new/actions/runs/44773161512), [application
approval](https://github.com/elewa-git/opencrane-new/actions/runs/44773151009) and [scanner
approval](https://github.com/elewa-git/opencrane-new/actions/runs/44773156887) before installation.
The real approval consumers accepted both exact-source records; the runtime file and licence checks
were unchanged.

The first package attempt claimed secondary id 1 after the 17:25:51 UTC observation, load 5.69,
following 302 continuous qualifying seconds. The post-claim load rose to 6.51; this was recorded
before installation. The corrected collector waited until the two-hour resource limit. At 17:56:49
UTC, load rose to 6.23 and reset the final window; no second slot was claimed. The [rerun
observations](logs/fix-2/attempt-2/resource-window.jsonl) retain each reset.

Waited for both secondary ids to report free, no package stack and one-minute load below six for
five minutes. Checked every 30 seconds and reset the window when another journey held a slot or load
rose. The [observations](logs/fix-2/resource-window.jsonl) include the competing package and
qualifying intervals. Never installed beside another secondary journey.

The packaged procedure uses a new namespace, Helm install identity and PVCs. The CORE comparison
used the following commands; up includes the browser journey. The baseline run also repeated
journey.sh explicitly.

```sh
stack_id=$(infra/dev-stack/claim.sh) || exit 1
export DEV_STACK_ID="$stack_id"
# Set ZITADEL_KEY_FILE by path only.
nice -n 10 infra/dev-stack/up.sh --fresh --id "$stack_id"
infra/dev-stack/status.sh --id "$stack_id"
# Save startup and service logs before teardown, including after failure.
nice -n 10 infra/dev-stack/down.sh --id "$stack_id"
```

The packaged procedure used:

```sh
stack_id=$(infra/dev-stack/claim.sh) || exit 1
export DEV_STACK_ID="$stack_id"
# Set ZITADEL_KEY_FILE and PACKAGE_VALUES_FILE by path only.
nice -n 10 infra/dev-stack/run.sh package-prepare --id "$stack_id"
nice -n 10 node --experimental-strip-types infra/package/prepare.ts
OPENCRANE_ACCEPT_DEV_HOST_RISK=accepted-dev-box-366 \
  nice -n 10 infra/dev-stack/run.sh package-up --id "$stack_id" \
  --values "$PACKAGE_VALUES_FILE"
nice -n 10 infra/dev-stack/run.sh package-check --id "$stack_id"
DEV_STACK_ID="$stack_id" infra/package/forward.sh
# Run Chromium and collect node, pod and owned-volume observations.
# Copy startup and sanitised service logs before both teardown commands.
nice -n 10 infra/dev-stack/run.sh package-down --id "$stack_id"
nice -n 10 infra/dev-stack/down.sh --id "$stack_id"
```

Used the existing [accepted local
exception](../../../infra/package/README.robot.md#accepted-local-exception). The preflight still
records the host's swap and crash-reporting failures. Host protection for a production VM remains
NOT RUN. Changed no host setting and left the owner stack untouched. No paid model or paid VM was
used.

## Desktop cause and CORE comparison

The production build wrapped the CommonJS noVNC constructor in a default-export object. The old
viewer re-export passed that object to new Rfb, which threw a TypeError. Its caller then closed the
browser socket before any decoded frame. The development server exposed the class directly,
explaining the earlier CORE passes. An isolated production-browser regression reproduces this
without an ingress or computer. Test-first commits `de6cc73ef` and `1bd7ff9d5` precede fix
`dfd8aa424`, which describes both shapes and selects the constructor at import.

The unchanged viewer passed both widths in two full CORE runs on a fresh stack. PASS after the fix:
the fresh id 2 CORE journey installed e0c4a9b06 and passed both widths, including decoded frames,
viewing during a turn, access revocation, PDF answers and budget refusals. Collection and teardown
both exited zero. No connection retry, reconnect loop, longer timeout or access/memory change was
added. The existing website EPIPE regression also passes twice. The new test driver's browser-global
lint failure was recorded in `5e21fdc0f` before fix `e0c4a9b06`; the lint rule and exact pixel
assertion remain unchanged.

## Packaged browser outcome

Used real SSO in the development organisation and Chromium at 1280 and 390 pixels. The package uses
the scripted provider. The PDF is uploaded and scanned through the package services; the response
must contain Willow-47. The scripted provider can use inline text or read the existing project.pdf
fixture when the text is unavailable. Anonymous history reads are refused. Budget results use the
shared schema.

The package journey uses one person. A known xmessage window makes a decoded 800 by 600 desktop
frame distinguishable from an empty canvas.

| People | Width | Result |
| --- | --- | --- |
| 1 | 1280 | PASS sign-in, chat, history refusal, PDF answer, decoded desktop and budget |
| 1 | 390 | PASS sign-in, chat, history refusal and budget; FAIL PDF answer; desktop NOT RUN |

The [qualification status](logs/fix-2/qualification.json),
[assertions](logs/fix-2/browser-result.json) and masked screenshots record each condition. The pod
snapshot retains restart counts. No restart or incomplete browser result is excused as a pass.

PASS for the earlier run: sanitised startup and service logs were retained before package-down/down.
Both owned teardown commands exited zero and both slots were released. The first controller exited
143; its journey=0 field is invalid and its browser FAIL is retained.

## Earlier attempt in this round

FAIL: the first packaged attempt in this round decoded a desktop at 1280 pixels, but its mobile PDF
answer failed. The private collector uploaded sizing.pdf; the [scripted
provider](../../../infra/dev-stack/model-stub.ts) recognises the existing project.pdf.md fixture
path when it needs to read the file. The corrected collector uses the existing project.pdf fixture
name; its fresh rerun remains NOT RUN. Product code, PDF-answer assertions and provider behaviour
remain unchanged.

The controlling shell then exited with signal 15. Its cleanup overlapped the browser, making the
later owner sign-in timeout unreliable. Its final-status file incorrectly reports journey=0, so
browser-result.json is authoritative and that attempt is not a pass. The collector now stops its
browser before collecting logs and tearing down on a signal, and separately checks the required
browser outcomes. The root measurements describe that first attempt. The [failed browser
outcomes](logs/fix-2/attempt-1/browser-result.json), [controller
status](logs/fix-2/attempt-1/control-status.json), measurements and [masked failure
screenshot](screenshots/fix-2/failed-extra-1-0-390.png) remain available. No product retry or
deadline changed.

## Measured one-person demand

Measured on the existing eight-logical-CPU, nominal 16 GiB development box through its single shared
k3d node. Browsers run outside the measured node, as remote clients would. Added no second container
runtime. These measurements cover the local package, scripted model, short chat/PDF turns and live
viewing.

Sampled kubelet CPU, working-set memory and swap about every two seconds. The underlying CPU
counters refresh less often, so short bursts can be missed. The [CSV](logs/fix-2/measurements.csv)
and [summary](logs/fix-2/summary.json) retain sample timestamps, phases and counts. Package totals
sum only the owned namespace. Whole-node totals include Kubernetes services, the shared gateway and
runtime overhead; they exclude the owner services outside k3d. Never add node and pod values
together. For each CPU, working-set and swap counter, use the greater of the node value and
owned-pod sum to allow for different refresh times. Add working-set and swap bytes for the memory
total. Swapped pages are not free RAM.

Occupied disk uses read-only du -sk on bound PVC paths after matching namespace, claim and UID.
Image-cache sizes are separate CRI counters. They are neither occupied PVC bytes nor block-I/O
traffic. OS, image unpacking, retained data and backups also need disk reserve.

The latest one-person measurement retained 289 observations from 2026-11-20T17:27:05Z to
2026-11-20T17:36:41Z, with 0 error samples. Whole-node peaks were **3.654 CPU cores and 5.12 GiB
including swap**. Package peaks were 2.640 cores and 2.97 GiB working set; bound-PVC use peaked at
84.13 MiB. The run passed the requested 1280-pixel steps, but the 390-pixel PDF answer failed and
desktop viewing did not run. These numbers describe that measured one-person run only.

NOT QUALIFIED: these observations do not establish a minimum machine size or spare-capacity
recommendation.

The existing node and image cache were already running. A smaller physical VM, cold VM
bootstrap/reboot, long-running workloads and long-term storage growth remain NOT RUN. The bootstrap
on this host ran only with --dry-run and safely refused its existing Docker socket before writes.
Local container fixtures use stubbed system operations and cannot qualify a real Ubuntu VM.

## 22 November packaged journey attempt

PARTIAL: after waiting for both secondary slots to be free and the one-minute load to stay below
six for five minutes, claimed secondary slot 2. `package-prepare --id 2` printed that all listed
services were stopped, then failed with the exact message:
`Package command refused; check pins, named secrets and slot ownership`. No browser journey or new
measurement ran. `package-down --id 2` and `down.sh --id 2` completed; status reported `free`.
The [captured package preparation output](logs/fix-2/attempt-3/package-prepare.log) records the
failure. No service logs existed because no package services started.

## Retained earlier results and own gates

Fix round 1 remains PARTIAL: one-person sign-in/chat/PDF/history refusal/budget passed at both
widths and desktop failed after upgrade. It measured 3.870 whole-node cores and 5.23 GiB including
swap. Those observations did not establish a minimum. The
[previous
receipt](https://github.com/elewa-git/opencrane-new/blob/7485b5b531a431208534c0f01a80cf1ec15633b1/docs/process/work-pilot-1162-s1/journey.md)
and logs/fix-1 retain the failed conditions, earlier website crash and teardown.

The [own-check receipt](checks.md) records failing-first evidence and confirmed exit results: branch
tests twice, production pixels twice, viewer unit checks twice, typecheck, catalogue, Knip, scoped
lint and document checks. It separately retains the unsuccessful broader routine-sender timing
investigation; no routine code, deadline or assertion changed and no timing failure is claimed
fixed. No full local root suite ran. These are own checks; no independent-review result is claimed.
The PR remains draft.
