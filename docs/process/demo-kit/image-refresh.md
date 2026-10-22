# Computer image refresh

22 October 2026. Part of #32.

PARTIAL overall: the image release and requested browser proof pass. The broader
startup journey fails at its integration-row check, as recorded below.

The demo needs the same bridge code as the tested checkout. The previous image
lacked the explicit end reasons already present in the source. The page supports
older reports, but newly started computers now include that source.

Source: `4f97ddbf248f0c75097c78ff5cd7208a00d026f8`, based on
`560c4fab27e085720a018c6e877b3729b933df19`. The first two commits add and correct
the image regression. No application source, event contract, access check or money
rule changed. The final commit records the release and names the unchanged test
request before passing it to the driver; its assertions are unchanged. The later
merge of main `8a334f3ee` changes only CI settings; image sources are unchanged.

## Released image

`k3d-ocn-registry:5000/opencrane/computer@sha256:40e715076ce0c19f0610b0fbe7872112c971d50a444487126f4465b3d8d4c3f0`

Both `qualification` and `p2-1` match this digest. The release tag moved only after
all build gates passed. The package checker requires its two computer references
to match, so both were updated. The 385-component licence inventory and its checksum
are unchanged. The [image record](../../../apps/computer/evidence.json) includes
individual image checks, timings and the updated SBOM checksum. The complete
[turn checks](image-refresh-private.json.gz) and their
[file inventories](image-refresh-inventories.json.gz) are compressed JSON.

## Failing-first check

PASS: the corrected regression fails on the old pin,
`sha256:68e70e24e1f1ecb692f314d5531183b6a63fb8eca32ebe9292f39451218d1825`.
It waits for a personal reply to stream, sends Stop, then requires the bridge's
saved terminal report to contain `stop_interrupted`. The new image passes.

The first added assertion was wrong: it required the existing restricted private
turn to report interruption. That turn streamed, but saved `model_error` after Stop.
Receiving Stop alone does not establish the cause of failure. The first complete
build therefore failed after 464.29 seconds and did not move the release tag.
The correction keeps every existing private check and adds a separate personal
streaming turn. Its old-image run failed after 269.22 seconds, with no other failure.
No runtime rule or existing gate was weakened.

## Release gates

| Step | Result |
| --- | --- |
| Clean `npm ci`; NATS and Lychee tool links | PASS; 933 packages installed |
| Pinned Syft and SPDX download checksums | PASS |
| Runtime Docker build | PASS |
| Codex MCP protocol checks | PASS |
| Image source and filesystem contents | PASS |
| Installed notice completeness | PASS; 92 notices |
| Licence scan | PASS; all 385 components |
| Private execution with template capabilities | PASS |
| Qualification digest publication | PASS |
| Native custom-exec security probe | PASS |
| Fresh/resumed k3d image checks | PASS; all 24 checks |
| Private turns, recovery, tool refusals and personal Stop | PASS; all 84 checks |
| Complete `build.sh` | PASS; 622.89 seconds |
| Release tag and registry digest comparison | PASS |
| Complete lifecycle file, one worker | PASS; all 11 cases, 796.08 seconds |
| Changed image test, second successful run | PASS; all 84 checks, 495.30 seconds including the load wait |
| Credential and debugger checks | PASS; all 9 tests, 107.76 seconds |

The lifecycle run used claimed secondary slot 1, `LIFECYCLE_K3D=1`, a private
throwaway PostgreSQL 17.6 database and `--maxWorkers=1`. No case needed a rerun.
The tests removed their namespaces and admission policies.

## Browser proof

The first fresh start failed during local provider creation with
`Provider setup create: 503` after 76.39 seconds. The failure did not recur during
provider setup on the fresh retry. No timeout or access rule changed. The cause
of the first 503 is not established.

FAIL: the bundled startup journey later timed out at `typed integration rows`
(`infra/dev-stack/journey.ts:583`), after 1,035.89 seconds for the fresh start.
Its full result is not a PASS. The requested focused browser proof runs separately
on this same fresh stack; no image, timeout or access guard changes for it.

PASS: the focused proof ran at 390px, then 1280px, on the new image. Each Stop
kept `Hello` and its trailing space after reload (six characters). Both the conversation and computer
saved their end reports. The reply showed only “Stopped · partial reply kept”, with
zero “Reply failed” labels, live and after reload.

| Width | Stop | Deliberate provider failure |
| --- | --- | --- |
| 390px first | PASS; 1,109 ms; `stop_interrupted`. [Live](image-refresh-stopped-live-390.png), [reload](image-refresh-stopped-reload-390.png). | PASS; `model_error`, no Stop request. [Live](image-refresh-failed-live-390.png), [reload](image-refresh-failed-reload-390.png). |
| 1280px second | PASS; 2,545 ms; `stop_interrupted`. [Live](image-refresh-stopped-live-1280.png), [reload](image-refresh-stopped-reload-1280.png). | PASS; `model_error`, no Stop request. [Live](image-refresh-failed-live-1280.png), [reload](image-refresh-failed-reload-1280.png). |

The failure fixture made the local stand-in return `response.failed` with
`invalid_prompt` for “Please demonstrate a failed reply.” It sent no Stop request.
“Reply failed” remained visible after reload at both widths. The temporary fixture
change was restored; no application code changed and no paid model was called.

PASS: all three running computer Pods had both their requested image and actual
`imageID` equal to the new pin. The node had initially reported the first candidate's
name because both builds contain the same Linux image. Before fresh startup, only
this task's unused candidate cache entries were removed. The published release stayed
in the registry. The [browser record](image-refresh.json.gz) contains the exact Pod
names, digests, end reasons and timings. The focused run took 152.85 seconds.

## Source checks and cleanup

| Step | Result |
| --- | --- |
| Typecheck | PASS; 381.66 seconds |
| Event catalogue | PASS; 149 event types |
| Event security rules | PASS; 438 tests |
| Knip | PASS |
| Package licence checker and its refusal tests | PASS; 14 tests |
| Lint | PASS; 619.26 seconds |
| Changelog | PASS |
| Slot removal and release | PASS; 62.79 seconds |
| Throwaway PostgreSQL and volume removal | PASS |
| GitHub `ci-ok` | NOT RUN at receipt; the PR reports the pushed commit |
| Full root suite, paid calls and managed cluster | NOT RUN; outside this task |

The first lint attempt exhausted Node’s default heap after 616.75 seconds.
The retry used `NODE_OPTIONS=--max-old-space-size=8192`, matching the CI-only
change already merged into main. It passed code, dependency and unused-code
checks, then failed on a trailing space inside this receipt’s code span. The wording
was corrected and the full command passed. No lint rule was removed or relaxed.

Builds, lint, typecheck and tests use `nice -n 10`. Local logs and command timings
are under `/tmp/demo-kit-image-refresh/`. Only claimed secondary slot 1 is used.
The owner stack is untouched.

## Owner refresh

PASS: the existing [owner guide](../demo/README.md#owner-run-refreshing-the-owner-checkout)
requires a merged, qualified commit containing the refreshed image. It checks out that
commit before a fresh startup. `infra/dev-stack/stack.ts` applies that checkout's
`sandbox-template.json` and regenerates the matching admission rules. Fresh startup
removes the old computers. No separate image command is needed, so the guide is unchanged.
Running the owner refresh is NOT RUN. A paid fresh-install qualification remains required
by the guide; this stand-in check does not replace it.
