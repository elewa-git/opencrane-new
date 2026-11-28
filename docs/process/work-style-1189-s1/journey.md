# Package style cleanup

Journey on a fresh dev stack: PASS

The tested product commit is `df2043c7548a60d196db61861c7f148714eeed46`.
CORE completed on a new slot-1 install using the stand-in model. The live pilot
stayed in slot 2. The fleet marker stayed set throughout the run.

## Fresh install and interruption

Slot 1 was free, with no package Pods, before the claim. The availability wait ran
from 03:31:35 until 04:33:05 UTC on 28 November 2026. The last five minutes stayed
below load six, sampled every 30 seconds. Loads ranged from 2.48 to 4.99.

`claim.sh --id 1` returned 1. `up.sh --fresh --id 1` created the new install and
reported three passing startup checks. Its launcher then ended with exit 143
while CORE was running. No assertion failure was written to its output. The
signal sender is unknown; the host refused a signal-tracing attachment. No host
permission, source code, guard or timeout was changed.

The slot still had 14 running services and five healthy endpoints. Startup and
service logs and screenshots were copied before any teardown. The supported
`journey.sh --id 1` command then completed the full default CORE check on that
same new installation. It exited 0 and reported 34 passing checks. This was one
fresh install; the existing member was preserved during the continuation.

The interrupted launcher is PARTIAL. The completed CORE journey is PASS. Both
attempts remain recorded; the successful continuation does not replace the
interruption record.

## What the person did

1. The owner and member signed in through Zitadel in separate browser contexts.
   Session, wrong-organisation, expiry and hostile sign-out checks passed.
2. The member sent messages at 390 and 1280 px. The reply streamed, survived reload
   and appeared once. Stop kept the partial reply after reload.
3. The member uploaded a PDF and asked for its project code. Scanning, extraction,
   the Willow-47 reply, reload and previews passed at both widths. EICAR files,
   unsupported types and oversized files were refused. The existing driver used
   one upload retry at each width and no preview retry; no duplicate
   file was created. This slice added no retry.
4. The person opened the computer view. Reply, removal, suspension, wake-up and
   Pod replacement checks passed, including preservation of the computer's disk.
5. Private history stayed unavailable to another member and the owner. The owner
   could read organisation metadata without private text. Token exposure checks
   and checks of the process and gateway logs passed.
6. The owner saved paying-group and assistant monthly limits at both widths.
   An over-limit call was refused, and the refusal remained after reload.
7. Sign-out, the next credential check and member and catalogue replay checks
   passed. Final status showed 14 running services and five healthy endpoints.
8. Screenshots and service logs were copied before `down.sh --id 1`. Teardown
   exited 0. `status.sh --id 1` then reported `free`.

The optional long-chat approval journey was NOT RUN. The default CORE command
explicitly skips it, and this slice does not require it.

## Pictures

| Step | 1280 px | 390 px |
| --- | --- | --- |
| Reply, reload and Stop | [Desktop chat](workspace-1280.png) | [Phone chat](workspace-390.png) |
| File ready | [Desktop file](upload-ready-1280.png) | [Phone file](upload-ready-390.png) |
| PDF answer | [Desktop answer](upload-1280.png) | [Phone answer](upload-390.png) |
| Monthly-limit refusal after reload | [Desktop refusal](budget-refusal-1280.png) | [Phone refusal](budget-refusal-390.png) |

The pictures contain generated fixture data. The selected pictures were checked
for credentials, private paths and real email addresses before committing.
CORE also wrote pictures into older receipt folders. Those were preserved
privately and their tracked originals were restored.

## Source checks

| Check | Result |
| --- | --- |
| Focused Node checks | PASS twice: 91 checks each |
| Focused backup checks | PASS twice: 23 checks each |
| Package Vitest checks | PASS: 260 checks in 20 files |
| First broad package Node run | FAIL: 1,705 passed; one unchanged NATS preparation fixture hit its existing process deadline |
| Complete NATS preparation file, run alone | PASS: 19 checks; no code or timeout change |
| Full typecheck and final package typecheck | PASS |
| Event catalogue and Knip | PASS |
| Scoped ESLint with an extra local configuration | PASS, including size, complexity, depth and parameter limits |
| Repository ESLint configuration | PARTIAL: it excludes `infra`; the extra local configuration checked these files |
| Markdown, changelog, public privacy and secret checks | PASS |
| Web-specific tests and build | NOT RUN as separate gates; no web source changed |

The original model-secret check was tested before the refactor. Removing its
embedded-key refusal made the new test fail with a missing expected exception.
Restoring the original check made all three model-secret tests pass. The changes
then kept those tests green.

The extra lint check found complexity 16 in the backup validator. Moving its
saved-event checks into a named function brought it within the limit of 15.
The provider setup now has named steps, and the key-permission probe shares the
existing provider probe module. Inline builders and chained operations were
expanded. No dependency or public contract changed.

[CI](https://github.com/elewa-git/opencrane-new/actions/runs/46104421269),
[application approval](https://github.com/elewa-git/opencrane-new/actions/runs/46104457905)
and [scanner approval](https://github.com/elewa-git/opencrane-new/actions/runs/46104460348)
all passed for the tested product commit before the claim. Both image artifacts
and both approval artifacts were present and unexpired.

[Result counts](result.json) and the [scope list](scope.json) contain the small
structured records. Raw files remain on the box only, including `startup.log`,
`core-continuation.log`, `status-after-core.log`, `teardown.log`, `package-node.log`
and `nats-isolated.log`. No raw service or test log is committed.

## Work left for another part

The change is 780 added plus deleted shipped-code lines, counting the executable
provider journey driver. Ordinary tests and documents are excluded.
The [scope list](scope.json) names the remaining source files and every file
skipped because the two open pull requests also change it. The longer sign-in
flows still need the same style check. Provider navigation code replaced after
the ticket's date window, the later shutdown logger and automatic chat-default
helper were left unchanged.
