# Packaged file uploads

Journey on a fresh packaged installation: **PASS** — 15 November 2026.
At both 1280 and 390 px, a person signed in, uploaded a clean PDF, received
“The project code is Willow-47.” from its converted contents, then uploaded EICAR
and saw “File refused: malware detected.” The saved file list contained only the
clean attachment. This qualifies slice 1 of 3 of #15 with the packaged stand-in model.

Tested source and application image revision:
`bd73de7f728894c38b18e4dc5e171a2867a3acfb`.
Rebased onto `1170dc966146e25f950d7bdd33c2ec4283c8d300` (`origin/main`), which includes
PR #1127. The conflicts retained both main's model helpers and this PR's scanner/storage
allowlists, plus both documentation changes. No runtime logic fix was made in this
qualification. The final evidence commit changes image references and receipts.

## Current packaged journey

Claimed secondary slot **1** through `infra/dev-stack/claim.sh` with its fixed
private `DEV_STACK_DIR` outside the repository. Used the private Zitadel key by
file reference. Only the OpenCrane 2 Dev organisation was used.
No Compose stack ran in this slot. A new namespace and new persistent volume claims
were created; their identities are saved in
[installation.json](packaged-rebased-2026-11-15/installation.json).

Ran `run.sh package-prepare`, private `prepare.ts`, `run.sh package-up` and
`run.sh package-check` for that id, then used the package's loopback forwarder.
Both installation commands passed. Bootstrap completed; the scanner, model, server,
file storage and workers became ready. The previous missing model import did not
recur. Sign-in used the separate development test account, verified through
`/auth/me`, followed by the actual browser upload and chat controls.
No browser requests or service responses were replaced with fixtures.

| Step | 1280 px | 390 px |
| --- | --- | --- |
| Real sign-in and authenticated browser session | PASS | PASS |
| Clean PDF upload becomes Ready | PASS | PASS |
| Answer names the code read from the attached PDF | PASS | PASS |
| EICAR shows the malware refusal | PASS | PASS |
| Only the clean attachment is saved | PASS | PASS |
| Required upload, answer and refusal screenshots | PASS | PASS |

[Raw browser results](packaged-rebased-2026-11-15/result.json) record each width.
All six retained pictures were copied into this folder before package cleanup.
Visual inspection confirmed the answer and refusal at each width, with no horizontal
page overflow. Account details were masked during capture. An early blank mobile
sign-in picture was discarded; sign-in is also demonstrated by the verified session
and subsequent authenticated workspace actions.

| Screenshot | 1280 px | 390 px |
| --- | --- | --- |
| Clean file ready | [Desktop](packaged-rebased-2026-11-15/clean-ready-1280.png) | [Mobile](packaged-rebased-2026-11-15/clean-ready-390.png) |
| Answer about file | [Desktop](packaged-rebased-2026-11-15/clean-answer-1280.png) | [Mobile](packaged-rebased-2026-11-15/clean-answer-390.png) |
| EICAR refused | [Desktop](packaged-rebased-2026-11-15/eicar-refused-1280.png) | [Mobile](packaged-rebased-2026-11-15/eicar-refused-390.png) |

## Current approval and image evidence

Scanner approval came only from successful
[CI packaging run 43710911559](https://github.com/elewa-git/opencrane-new/actions/runs/43710911559)
for the exact rebased commit above. Pushed that commit before waiting for the job.
`package-prepare` fetched its immutable output through `fetchScannerApproval`;
preflight fetched and checked the output independently before installation.
No local approval or replacement approval record was created.

- Approved manifest SHA-256: `79360722f29c77bd0d3ff1a25c66ea24edaaaf99ccefbe2dff696e57640a5d9d`.
- Scanner image digest: `sha256:9b8d235f61582cc4b1846d7cc22c196ed615b80db87d4bf0ce762c03c015327f`.
- Complete verified database check: `2026-11-15T11:51:45.470Z`.
- Application image digest: `sha256:d92d9c78c4d10e238fdf666b894163017d917056b5fadb88cef79707889ab844`.

Built the application from the rebased committed source. All 14 actual-image layer,
import and runtime checks passed, including main's recursive model dependency check.
The promoted manifest uses those same runtime bytes without the build attestation.
The all-layer Syft scan matched all 580 existing reviewed components. Re-authenticated
all three signed Debian main indexes. The source-bound promotion check passed for
both server and website. Updated the image evidence and its exact digest constants;
no licence rule, guard or runtime behaviour changed.
Published the reviewed OCI bytes to the existing registry through its documented
HTTP endpoint. The existing object-store manifest returned HTTP 200. No Docker daemon,
container runtime, bridge, route or firewall setting changed.

## Current own checks

All tests, lint, typecheck and builds ran under `nice -n 10`. No full root test suite
or fleet batch ran locally. Waited while the one-minute load exceeded 10 before
starting queued batches, package preparation and browser qualification. The browser
wait was substantial; later load rises did not restart or repeat any step.
Each changed test ran once with its proper runner. The backup Node file was excluded
by the Vitest discovery filter and then ran once through Node's test runner.

| Check | Result |
| --- | --- |
| Eight focused storage/scanner Vitest files, 48 cases | PASS |
| Changed package Node suites, 612 cases | PASS |
| Changed CNPG backup Node suite, 207 cases | PASS |
| Changed historical image, licence and publisher Python suites, 131 cases | PASS |
| Actual rebuilt application image, 14 cases | PASS |
| Workspace, package and dev-stack typecheck | PASS |
| Event catalogue, Knip, changelog lint and Markdown lint | PASS |
| Configured changed-file ESLint | PASS command; zero errors |
| ESLint coverage of ignored infrastructure files | PARTIAL; 24 existing ignore warnings |
| Application candidate licence, Debian index and promotion checks | PASS |
| CI on rebased tested source, including scanner approval | PASS |
| Final receipt Markdown and mandatory privacy/secret scans | PASS |

The rebased source's full
[CI run 43710915862](https://github.com/elewa-git/opencrane-new/actions/runs/43710915862)
passed all its jobs. Final evidence-head CI is recorded in the PR checks and Evidence.
No independent review result is claimed here.

## Current cleanup and short log

Cleanup: **PASS** after an interrupted first wrapper. That wrapper exited 130 during
teardown, after the package namespace was removed. The source of the interruption
was not established. Then explicitly ran `package-down --id 1` and `down.sh --id 1`;
both exited zero. The namespace and both ownership markers are absent, and
`status.sh --id 1` reports `free`. See [cleanup.json](packaged-rebased-2026-11-15/cleanup.json).
No slot, namespace or computer remains claimed by this task. The worktree is retained
for review.

1. Rebased mechanically to bring in the main model packaging repair.
2. Ran the changed tests once and checked types, contracts and configured lint.
3. Obtained exact-source scanner approval from CI and rebuilt/reviewed the application.
4. Claimed a fresh secondary install and passed the packaged browser path at both widths.
5. Copied and inspected screenshots, then completed owned package and stack cleanup.

The remaining two slices of #15 are outside this qualification. This receipt proves
the listed local packaged journey with the stand-in model; it does not qualify a
customer environment, a real model provider, backup or restore.

## Previous qualifications

The records below describe earlier source heads and failed attempts. They are
historical and do not replace the current packaged PASS above.

Journey on a fresh dev stack: **FAIL** — 15 November 2026. Both fresh Compose
qualifications passed. The final packaged installation completed bootstrap and
started its workers, storage service and authenticated scanner, but the model
container could not import a required module. Packaged sign-in, clean upload with
an answer, EICAR refusal and packaged screenshots at 1280 and 390 px are **NOT RUN**.
The PR remains draft; this slice is not ready to merge.

Tested source: `be18431aecc2b3755eea57a49d4fa1531880a71c`.
Application image source: `e0a528a7fb998ff50a3d51014e15febe8797170a`.
The journey used base `35e9f09e8`. After qualification, fetched origin again and
completed the requested rebase onto `117564913e9af280be4939949cd83b7ccbe23256`.
That base is an ancestor of the final branch. The rebase finished with a clean
worktree. The reviewed application image predates this final rebase. No image
rebuild, packaging repair or journey followed the required stop. The worktree
is retained for review.

### Required owner decision

Stopped under the [engineering discipline](../standards.md#engineering-discipline-make-it-work-then-make-it-right):
“When two fixes that rest on the same assumption fail the same check … stop.”

The failed assumption is: **checking bootstrap and selected helper imports proves
that every packaged runtime entrypoint has all its dependencies.**

The first packaged startup exposed missing worker code and a hidden ClamAV
certificate directory. After those repairs, the next fresh packaged startup
still failed at the same installation gate: its model entrypoint imports
`infra/dev-stack/connection-custody-bridge.ts`, which is absent from the image.
An isolated read-only container reproduced `ERR_MODULE_NOT_FOUND` from the actual
reviewed image, before the model process starts. No model import fix, broader
context exception, retry, timeout increase or assertion relaxation was applied.

The owner needs to choose the next packaging boundary before another fix. One
option is to qualify every actual packaged entrypoint and repair the optional
model custody dependency. Another is to replace the development model wrapper
with a package-owned composition. Both retain the packaged browser journey as a
merge condition in this PR; neither treats the current source checks as live acceptance.

### Trusted packaging output

The scheduled workflow runs on free standard GitHub runners every six hours,
on manual dispatch after merge, and on pushes to this branch and main. It uses
no new repository secret, paid runner, paid cache or repository/organisation setting.
It reuses FreshClam, `database.mjs`, `release.mjs`, the flattened scanner recipe and
the actual-image licence inventory checks. Its artifacts contain approval and
an immutable OCI image. Local candidates and environment variables cannot approve.

The final package preparation fetched the successful
[scanner run 43703838673](https://github.com/elewa-git/opencrane-new/actions/runs/43703838673)
for the tested head through the production reader:

- Approved manifest SHA-256: `0a53411c2a458b63fdc3e4d16bc7db1442ecfb2ccbf529469ac5b66313c8772d`.
- Scanner image digest: `sha256:8668214420c0e5ae11237ca5c3a580c508057a996b8b542214cb6d6d1dabaae2`.
- Complete verified database check: `2026-11-15T10:23:53.859Z`.

The reader independently checks the successful workflow, source repository,
trigger, branch, commit and artifact bindings. Preflight fetches that output
again before accepting values. The old checked-in scanner records confer no
current approval. Both actual preparations used CI outputs; no approval steps
were hand-run locally to create an approval.

### Image publication and startup repairs

The HTTP publisher verifies selected OCI manifests and blobs and uploads only
those bytes to the existing registry's Docker-network address. No Docker daemon,
container, bridge, route or iptables setting changed. The broken host loopback
forward was not used. No protected container was removed.

The application was rebuilt from committed source and checked through its real
layers and containers. Its 580 scanned components match the existing review;
all three signed Debian main indexes were re-authenticated. The source-bound
promotion check passed before the image evidence was updated and published.
Application digest: `sha256:f085934fd049fdf66c7890f9be07ff3801ae9a93dedeec540e865daceec74b43`.
The existing reviewed object-store digest was published unchanged. Both registry
manifest requests returned HTTP 200 with the appropriate OCI media types.

The first installation exposed two causes, reproduced before their fixes:

1. Mounting the whole ClamAV configuration directory hid its bundled verification
   certificates. A failing rendered-chart test preceded the file-only mount fix.
   Signature verification remains enabled. The final scanner had both containers
   ready with zero restarts.
2. Every projection worker imports `image-worker.mjs`, which the context omitted.
   A real-image import test failed before adding that explicit context exception.
   The rebuilt image passed the new check, and final bootstrap and workers started.

Earlier real-image checks also exposed omitted shared database and storage
readiness helpers. Their explicit context exceptions remain. These repairs do
not establish that the still-failing model entrypoint is complete.

This continuation adds **353 shipped lines** and removes 13: 366 changed lines,
including workflow/configuration and excluding tests, documents and reviewed image
data. It stays below the owner's approximately 600 additional-line stop point.

### Fresh installation attempts and cleanup

Both runs claimed secondary slot 1 through `claim.sh`, used `up.sh --fresh` with
the free model, and kept `DEV_STACK_DIR` outside the repository. Compose was stopped
before creating each fresh packaged namespace and claims. The package used
`package-prepare`, private preparation and `package-up` for the claimed id.

| Condition | Result |
| --- | --- |
| Fresh Compose qualification, including both widths | PASS twice |
| Latest approved scanner output fetched from CI | PASS |
| Reviewed application/object-store image publication | PASS |
| Initial packaged startup | FAIL; scanner certificates and worker import |
| Separate startup diagnostic | FAIL; causes captured before cleanup |
| Final bootstrap, projection workers and scanner | PASS |
| Final `package-up` | FAIL; model container cannot import custody bridge |
| Final `package-check` | NOT RUN; installer did not complete |
| Packaged signed-in clean upload and answer, 1280/390 px | NOT RUN |
| Packaged EICAR refusal, 1280/390 px | NOT RUN |
| Packaged screenshots before cleanup | NOT RUN; browser phase was unreachable |
| `package-down` and `down.sh` | PASS for both attempts and the diagnostic |
| Claimed namespace absent and slot ownership released | PASS |

The built-in Compose pictures and observations were retained locally before
cleanup; unrelated tracked evidence was restored. Those pictures are not packaged
acceptance. The initial automatic cleanup finished before its Pod logs could be
captured; the separate diagnostic captured the bootstrap and scanner causes before
cleanup. The final model failure was reproduced directly against the reviewed
image. No slot, namespace or temporary Pod remains claimed by this task.

### Own source checks

The results below belong to the tested source before the final rebase.
Post-rebase tests, typecheck, event checks, Knip and ESLint are **NOT RUN** after
the required stop; the final head is not claimed source ready. Documentation
checks and the mandatory pre-push privacy scans were repeated.

All tests, lint, typecheck and builds used priority 10. Source gate scripts and journey phase boundaries waited for load to fall below
10 before starting; no full root suite or fleet batch ran locally.
The second fresh-stack process and its children inherited priority 10. The first
process tree was lowered to that priority before its browser qualification.

| Check | Result |
| --- | --- |
| Focused scanner/storage/approval Vitest files | PASS twice; 48 cases per run |
| Changed package Node files | PASS twice per file; final full batch 611/611 |
| Corrected no-job preflight fixture | PASS twice; 44/44 per run |
| Changed backup fixtures | PASS twice; 207 cases per run |
| Licence checks, HTTP publisher and five historical image suites | PASS twice |
| Startup-fix chart files | PASS twice; 280 cases per run |
| Real rebuilt application image checks | PASS twice; 13 cases per run |
| Deliberately removed CI/preflight guards in an isolated copy | PASS; all nine removals caused their intended test failures |
| Workspace, package and dev-stack typecheck | PASS on tested source; final rebase not checked |
| `check:events`, Knip, changelog lint, changed-file ESLint, Markdown | PASS |
| Additional untyped infrastructure JavaScript ESLint | PASS; zero warnings |
| Public privacy and secret scans before source pushes | PASS |
| Actual packaged model entrypoint import | FAIL; custody bridge is absent |

The first 611-case batch had one fixture failure: its no-job test consulted live
GitHub state after the new workflow existed. It still refused the forged image.
The test now uses explicit Git and GitHub fixtures, retains the exact assertion,
and passes twice; the subsequent full batch passed all 611 cases. One exploratory
attempt to force typed ESLint over infrastructure excluded by the repository
configuration reported 125 errors; no lint configuration or suppressions changed.
That result is separate from the configured passing gates.

Full CI passed on the tested startup-fix head
[be18431ae](https://github.com/elewa-git/opencrane-new/actions/runs/43703844066), including
all nine jobs. An earlier run failed one unchanged gateway publication setup case;
that case passed in isolation without changing its five-second limit or assertion.
Final rebased-head CI is reported separately in the PR checks. Passing CI does not
qualify this failed packaged journey.

### Historical records through 13 November 2026

Journey on a fresh dev stack: NOT RUN — this attempt stopped at the scanner review
boundary. The checked scanner release expired before the attempt began. A fresh
manifest needs an independently supplied approval before installation. The previous
packaged installation remains FAIL; no passing packaged journey exists.

Recorded on 13 November 2026 for issue #15, slice 1 of 3. Rebased source:
`9932cac1b51a6b8ea5c99081cc9f9e388ee252b3`. Base: `1e8588842` (`origin/main`).

#### Diagnosis and required approval at that time

Fetched `origin` and rebased onto the updated `origin/main`. The rebase completed.
The image-layer test conflict retained both main's required `web-page.mjs` check
and this slice's scanner and credential helper allowlist. No runtime code, image
pin, inventory, approval check or deadline changed in this attempt.

Waited while the one-minute load exceeded 10. At 20:27 UTC it fell to 9.97 before
source checks began. No secondary slot was claimed or started. Slot 1 was already
running; slot 2 reported free. Left the existing stack alone.

Read both package guides and traced the commands. `package-prepare` creates the
owned namespace and ownership record only. It does not build or publish images.
The [image promotion instructions](../../../infra/package/README.robot.md#package-image-promotion)
describe a committed-source build, actual image checks, an all-layer Syft scan,
Docker inspection, authenticated Debian main index review and a read-only promotion
check. They provide no command that publishes images or automatically approves a
replacement. The local qualification builder explicitly does not push or approve
deployment. Do not describe `package-prepare` as an image publisher.

Read-only registry checks at 20:27–20:28 UTC confirmed:

- HTTP `GET /v2/` inside `k3d-ocn-registry` returned **200**.
- Exact manifest requests for the reviewed application, object-store and scanner
  digests inside that container each returned **404**.
- Plain HTTP `HEAD /v2/` through `127.0.0.1:5001`, with proxy use disabled,
  failed with `Recv failure: Connection reset by peer` too.

The previous Docker HTTPS reset therefore does not by itself establish a scheme
bug in a package publisher. No such publisher is called by `package-prepare`.
No Docker daemon settings, network settings or existing containers were changed.

At `2026-11-13T20:27:55.048Z`, the production `readApprovedRelease` function refused
the checked scanner inputs with `Scanner release refused`. Their verified complete
upstream check was `2026-11-12T20:25:13.766Z`; the 24-hour allowance expired at
`2026-11-13T20:25:13.766Z`. Restarts, copied records and a changed timestamp cannot
renew that evidence.

The [scanner packaging instructions](../../../infra/clamav/README.robot.md#packaging-evidence)
require: “The approval must come from the job's review inputs, not a hash supplied
alongside untrusted JSON.” This builder has no independent approved replacement
inputs. As instructed, stopped the packaged installation at that boundary.

The missing independent input is approval of a fresh scanner candidate from
`infra/clamav/refresh.sh`: its complete upstream check, all three verified database
files, independently approved manifest SHA-256 and reviewed immutable scanner image
containing those exact bytes. `release.mjs` must verify that approved pair and
produce the matching release. The reviewed scanner image and manifest hash then
belong in the review record consumed by preflight. A candidate's calculated hash
alone grants no approval. The trusted packaging reviewer or owner must provide
those approved inputs.

Resuming also requires a newly built application image from the rebased committed
source, with its immutable digest, revision label, Docker inspection, all-layer
Syft scan, complete licence inventory and authenticated Debian main package
evidence, followed by the documented promotion check. This is the documented
operator review, rather than an automatic pin update; no separate human-only
application review requirement was found in these instructions. The current image
still records source `47258e903347daaaf2727da636d4bca3f0f53a36`; rebasing does not
make its imported sources match this checkout.

These are image and scanner review inputs for slice 1, not permission to enable
three-replica NATS or resume the parked image-review work. No replacement was
self-approved by editing `reviewed-images.json` or its supporting inventory.
Publication of the approved immutable images and host-registry connectivity still
need proving after those inputs exist.

| Current attempt | Result |
| --- | --- |
| Fetch and rebase onto updated main | PASS; completed |
| Registry API inside existing container | PASS; HTTP 200 |
| Reviewed application, object-store and scanner manifests in registry | FAIL; all three HTTP 404 |
| Host plain-HTTP registry connection | FAIL; connection reset |
| Checked scanner release at actual current time | FAIL; stale, correctly refused |
| New image/scanner approval | NOT RUN; independent packaging review inputs needed |
| Fresh package preparation, installation and package-check | NOT RUN; stopped before claiming a slot |
| Packaged clean upload, answer and EICAR refusal at 1280 and 390 px | NOT RUN |
| Packaged screenshots | NOT RUN; no browser journey |
| New package/stack cleanup | NOT RUN; no slot or installation created |
| Source checks at that time | PARTIAL; results below |

#### Source checks at that time

| Check | Result |
| --- | --- |
| Six focused scanner/storage Vitest files: 32 checks | PASS twice; 15 and 36 seconds |
| Chart rendering and preflight, including licence/promotion refusals: 292 checks | PASS; 87 seconds |
| NATS preparation: 19 checks | FAIL; 13 passed and six hit the existing 30-second process deadline; 342 seconds |
| Workspace, package and dev-stack typecheck | PASS |
| `check:events`, Knip, changelog lint and changed-file ESLint | NOT RUN; stopped at packaging approval boundary |
| Markdown lint | NOT RUN; stopped at packaging approval boundary |
| All changed tests twice | PARTIAL; focused tests repeated, chart/preflight once, NATS failed |
| Actual application image layer/source checks | NOT RUN; no replacement image built or approved |
| Final privacy and secret scans | PASS |
| Pushed-head CI | Recorded in PR Evidence after push |

Started source checks only after load fell below 10, under `nice -n 10`. The load
rose during those checks, reaching 24.85. No full root suite or fleet batch ran.
The queued remaining gates waited for load, then were cancelled when applying the
explicit packaging approval stop. No test was turned into a pass by a retry.

The NATS failures were `expired certificate`, `client issuer`, `changed object`,
`changed reference`, `partial objects` and `replaced object`. Each reported
`Preparation fixture exceeded its existing process deadline`. Both positive
preparation cases passed. No timeout, assertion or production check changed;
these six fixture failures remain unresolved. No second NATS run was attempted.

Retained the earlier repairs for findings 2–7: historical/scanner fixtures, safe STS
diagnostics, bounded issuance and valid-lease readiness, isolated refusal cases,
shared database validation, named callbacks and the eight-box scanner diagram.
The focused tests passed twice on this rebased source. This attempt introduced no
production fix, so there is no new failing-test/fix commit pair or new guard-removal
claim. Finding 1 remains open. No further review result is asserted here.

#### Earlier failed installation

The following attempt ran before this diagnosis, on rebased code
`ba6d15abf23c0e003a38d9b18ef3d9c8495fbe10`, base `7ec65e982`.

#### Previous packaged journey

1. Fetched `origin` and rebased because `origin/main` had moved. The rebase
   completed without conflicts. The lockfile was unchanged, so `npm ci` was
   not required.
2. Claimed secondary slot **1** through `claim.sh` and ran `up.sh --fresh`.
   The built-in Compose journey passed, including clean PDF upload, its answer
   and EICAR refusal at 1280 px and 390 px. Startup and the journey took about
   16 minutes. Preserved its generated files locally before cleanup and restored
   the unrelated tracked evidence files that the built-in journey overwrote.
3. Stopped Compose with the slot's supported teardown, then claimed slot **1**
   again. Set `DEV_STACK_DIR` to the dedicated private directory fixed by that
   secondary id. Its `stack-owner` belonged to this worktree. The current
   configuration refuses arbitrary directories for secondary ids.
4. `package-prepare --id 1` passed and created a new namespace. Private
   preparation passed with the reviewed scanner manifest and release. It created
   the named Secrets from files in the claimed slot.
5. `package-up --id 1` installed the Helm release and created new bound claims.
   Its bootstrap Pod remained Pending with `ImagePullBackOff`. The website and
   object-store Pods also could not pull their pinned images. Kubernetes reported
   `failed to resolve reference` followed by `not found` for both reviewed digests.
   The likely cause is that those digests are absent from the registry.
6. Stopped the owned installer after those definitive image-pull failures, while
   it was waiting for bootstrap. The command exited **143**. Left its existing
   ten-minute bootstrap deadline unchanged and stopped the journey here.
7. Cleanup: **PASS**. `package-down --id 1` and `down.sh --id 1` both exited
   zero. The slot subsequently reported `free`; the package namespace was absent.

[Installation identities, new claims and registry errors](packaged-2026-11-13/installation.md)
were retained before cleanup. The inherited fleet marker stayed set throughout.
Only the claimed secondary slot was used.

| Step | Result |
| --- | --- |
| Fresh Compose startup and built-in journey | PASS |
| Fresh packaged namespace and private preparation | PASS |
| `package-up --id 1` | FAIL: bootstrap image pull; reviewed digests not found |
| `package-check --id 1` | NOT RUN: installation did not complete |
| Signed-in packaged clean upload and answer, 1280 px | NOT RUN |
| Packaged EICAR refusal, 1280 px | NOT RUN |
| Signed-in packaged clean upload and answer, 390 px | NOT RUN |
| Packaged EICAR refusal, 390 px | NOT RUN |
| Packaged screenshots at either width | NOT RUN: browser could not start against the failed installation |

Compose evidence does not satisfy packaged acceptance. The PR remains draft and
its packaged merge condition is not met.

#### Checks on the rebased code

| Check | Result |
| --- | --- |
| Six changed Vitest files, two workers: 32 checks, 44 seconds | PASS |
| Changed backup test: 207 checks, 21 seconds | PASS |
| Changed package Node tests: 608 checks, about 14 minutes | FAIL: 601 passed; seven NATS preparation cases hit their existing process deadline |
| Licence checks: 82 checks, 22 seconds | PASS |
| Five historical image suites: 48 checks | PASS |
| Actual image-layer checks: 11 checks, 133 seconds | FAIL: 10 passed; bootstrap runtime imports do not match this checkout |
| Workspace and infrastructure typecheck | PASS |
| `check:events`: 174 catalogue entries | PASS |
| Knip and changelog lint | PASS |
| Changed-file ESLint | PASS for checked files; 20 infrastructure files were ignored by the existing configuration |
| Markdown lint before receipt update | PASS |
| Final Markdown lint, public privacy and secret scans | PASS |

The seven preparation failures were `expired certificate`, `client issuer`,
`changed object`, `changed reference`, `partial objects`, `replaced object` and
`wrong SAN` in `infra/package/prepare-nats-routes.test.mjs`. Each reported
`Preparation fixture exceeded its existing process deadline` while the checks
ran alongside startup. Recorded the failures without extending deadlines or
rerunning those cases.

The image suite used the reviewed application image and its saved archive.
`test_bootstrap_runtime_imports_match_source_recursively` failed with
`Packaged bootstrap imports failed`. The image was built from
`47258e903347daaaf2727da636d4bca3f0f53a36`; its imported
`infra/dev-stack/identity.ts` differs from the rebased checkout.

The first test commands used Vitest for a Node test file and Node for six Vitest
files. Those invocations did not run the intended tests. The correct runners
subsequently produced the 207-check and 32-check results above. Tests, lint,
typecheck and startup ran under `nice -n 10`; no full root suite ran.

CI for the pushed receipt commit is recorded in the PR Evidence and checks.

#### Earlier runs and source evidence

The material below records earlier heads and attempts. Its passing source checks
and Compose results do not replace the current packaged FAIL above.

Journey on a fresh dev stack: FAIL — the Compose fresh-stack journey passed, but the
packaged journey stopped before package preparation when `target-up --id 2` exited
non-zero with: “DEV_STACK_DIR must be an empty dedicated directory outside the
repository, or owned by this worktree”. The stack cleanup completed.

Recorded on 13 November 2026 for issue #15, slice 1 of 3. Rebased head:
`4c07a6120b590f21c85a07fc88821cd30937bc0b`.
The browser journey is a merge condition. Component checks do not satisfy it.

The automatic Compose journey on the fresh secondary stack passed the upload,
answer and EICAR refusal checks at 1280 px and 390 px. It wrote screenshots named
`upload-1280.png`, `upload-390.png`, `preview-1280.png`, `preview-390.png`,
`workspace-1280.png` and `workspace-390.png` in the claimed slot's private
directory. Slot cleanup removed that directory, so those files are unavailable to
attach to this receipt. They would be Compose screenshots, not evidence for the
packaged installation.

The packaged journey did not start. After the Compose journey passed, I stopped it
as required before preparing the separate package namespace. `target-up --id 2`
then failed with the guarded error above. The launcher hid its underlying cause;
the likely failure is target or slot directory ownership validation, but the exact
cause is unknown. No package namespace or installation was created, and no
packaged browser steps or screenshots were captured. `package-down --id 2` and
`down.sh --id 2` completed; the slot reported free.

##### Earlier attempt (12 November 2026)

1. Checked `origin/main` and open pull requests before starting. This slice was
   neither merged nor open. Read the issue's owner decisions and Slices comment.
2. Ran `npm ci` and linked the existing NATS and link-checking tools.
3. Built the application, object-store and scanner images. Verified a fresh scanner
   release against its three actual databases and independently approved manifest.
4. Ran the source gates below, then claimed secondary slot **1** through `claim.sh`.
5. Ran the standard `journey-entry.ts` guard with that claimed id. It refused:
   **Automated journeys require a secondary stack and no fleet task**.
   `requireAutomatedJourney` rejects the inherited `OPENCRANE_FLEET_TASK` setting.
   The setting was preserved and the guard was not bypassed.
6. Ran `run.sh package-down --id 1` and `down.sh --id 1`. Both exited zero.

No packaged namespace or installation was created. `package-prepare`, private
preparation, `package-up`, `package-check` and browser sign-in were **NOT RUN**
after the guard refusal. Neither the owner stack nor its ports were used.

A separate image publication attempt through the existing loopback registry failed
with **connection reset by peer** while Docker attempted HTTPS to
`127.0.0.1:5001`. This environmental registry failure is outside this PR; the PR
changes no registry publication implementation. The reviewed images exist locally; their presence
in the registry and their installation on Kubernetes have not been proved.

##### Packaged browser acceptance

| Width | Packaged clean upload and answer | Packaged EICAR refusal | Screenshot |
| --- | --- | --- | --- |
| 1280 px | NOT RUN | NOT RUN | Not captured |
| 390 px | NOT RUN | NOT RUN | Not captured |

Compose clean upload, answer and EICAR refusal passed at both widths as recorded
above. Packaged clean upload, answer, refusal and screenshots were NOT RUN because
target setup failed before package preparation.

The next attempt needs a fresh secondary slot and packaged installation in the
order documented in
[the dev-stack contract](../../../infra/dev-stack/README.robot.md).
Use a newly reviewed scanner release if the recorded database check has expired.
At each width, sign in, start a chat, choose a small text or PDF file through Attach,
wait for Ready, and ask for a fact present only in that file. Save the chat answer.
Then choose the EICAR test file and save the visible
**File refused: malware detected.** message. Always run package-down and down.

##### Own checks

| Check | Result |
| --- | --- |
| Scanner, HTTPS service, release and real storage fixtures: 154 tests | PASS twice |
| Chart, upload services, rendering and preflight: 318 tests | PASS twice |
| Installer and private-setting refusals: 269 tests | PASS twice |
| Database backup chart compatibility: 207 tests | PASS twice |
| Licence and promotion checks: 82 tests | PASS twice |
| Actual application image layers, imports and native hashes: 11 tests | PASS twice |
| Root workspace and infrastructure typecheck | PASS |
| `check:events`: 174 catalogue entries | PASS |
| Knip | PASS |
| Changelog lint | PASS |
| ESLint on changed files | PASS |
| Additional ESLint on infrastructure JavaScript ignored by the root config | PASS |
| Markdown lint | PASS |
| Public privacy and secret scans | PASS |
| Actual all-layer image scan and source-bound licence promotion | PASS |
| Browser journey on a fresh packaged installation | NOT RUN |

Tests, typecheck, lint and builds ran under `nice -n 10`. Vitest used two workers.
No full root test suite ran. No application web source changed; the actual package
image build compiled the website. Infrastructure TypeScript remains ignored by the
repository's ESLint configuration and is covered here by its strict typecheck.

The production packaged adapter was also exercised inside the built application
image against the pinned ClamAV engine in an isolated Docker network namespace.
It verified the mounted database bytes before returning **clean** for small text
and **infected** for EICAR. This was a component check, without a browser or chat.
Its disposable container was removed. The real MinIO fixture verified short-lived
leases, renewal, object access and refusal of another bucket and bucket creation.

##### Image records

The application image was built from committed source
`47258e903347daaaf2727da636d4bca3f0f53a36`. Later commits change chart delivery,
reviewed image records, test fixtures and this receipt. They change no application
runtime module copied into that image.

- Application image: `sha256:1d4e3cf8ef189954fe1a2e6751de79e3c37c9f9742b14186163447bef8f3c22c`.
- Scanner image: `sha256:126d7e9292b6c260c60d4fc945bb74698ddd387da474b73bca78d3b0ad2becfb`.
- Object-store image: `sha256:adf12617265bc7ff63369b81854605493964424a90d9e713c14ae62a8cd3e31c`.

The inventory covers 580 application-image components, 243 object-store components
and 112 scanner operating-system packages. The scanner's GPL engine and bundled
notices are recorded separately. Signed Debian main indexes cover every installed
OS package. The image inventory also records the reviewed CC0 hashing library
bundled inside AGPL MinIO, as allowed by the runtime-layer policy.

##### Work log and cleanup

Started with failing tests for package services and source-bound image promotion.
A real image check then exposed hidden shell files in the upstream scanner database
folder. Removed that folder before copying the exact reviewed database set.
Pinned loaded scanner facts before cleaning up shared code. Reproduced and fixed
Kubernetes delivery of Secret files and numeric non-root engine identity.

Shared the bounded ClamAV transport, release validation and fixed production engine
settings. Deleted the duplicate development transport. Split model runtime settings
from private package preparation. Historical licence fixtures now use a fixed
baseline and explicit unreviewed inputs, so later promotion cannot rewrite their
claims. No event, business-state or access-check contract changed.

The change has **972 changed shipped-code and configuration lines** (additions plus
removals), excluding tests, documentation and generated licence/release records.
This includes the two dependency declaration lines and the new authentication-library
export. The root declaration reuses the already installed Apache-2.0 MinIO client
for the real storage test.
The worktree is retained for review. The claimed slot and disposable test containers
were released; the existing shared registry and test database were left in place.

##### Review repairs

Recorded on 13 November 2026. Own source checks: PASS. CI is recorded on the PR.
Capability: NOT RUN, awaiting #1119 and the complete fresh packaged journey.
Fetched `origin` and completed `git rebase origin/main`: already up to date.

- Finding 2: reproduced the historical inventory failure and missing scanner values.
  The historical tests now accept the current review, then explicitly remove its
  source revision to prove refusal. The NATS fixture supplies the reviewed scanner.
  Production approval checks were not relaxed.
- Finding 3: reproduced a credential and response-body canary through the real STS
  provider and structured logger. Issuance discards upstream errors and retains only
  a fixed message and structured cause classification. The canary now passes.
- Finding 4: bounded issuance to ten seconds and connected cancellation to the actual
  socket and response body. A separate readiness entrypoint shares the server's lease
  validator. Controlled time covers stalled headers and bodies, expiry, cancellation
  and recovery. The probe allows five seconds for Node startup and file validation;
  it does not load the STS client or full authentication library.
- Finding 5: added isolated refusal inputs and proved rotation after the service
  rejects the previous lease. Deliberately removed each of the twelve guards below,
  saw the corresponding test fail, then restored it. No broken guard was committed.
- Finding 6: shared regular-file, database size and streamed hash validation in
  `infra/clamav/database.mjs`, with both refresh and packaged caller coverage.
  Extracted named fixtures and cases in all four files listed by the review.
- Finding 7: reproduced the nine-box diagram count and removed the indirect NATS
  neighbour. The scanner diagram now has eight boxes.

| Deliberately broken guard | Isolating test with guard removed | Restored |
| --- | --- | --- |
| Database symlink | FAIL: startup accepted the link | Yes |
| Database minimum size | FAIL: startup accepted 511 bytes | Yes |
| Database maximum size | FAIL: startup accepted 512 MiB plus one byte | Yes |
| Input is a Buffer | FAIL: scan accepted a Uint8Array | Yes |
| Input maximum size | FAIL: scan accepted 20 MiB plus one byte | Yes |
| Byte-count equality | FAIL: scan accepted a different count | Yes |
| Clock rollback | FAIL: scan accepted the earlier clock | Yes |
| Abort after scan | FAIL: scan returned clean after cancellation | Yes |
| Lease expiry | FAIL: HTTP was attempted with an expired lease | Yes |
| Lease maximum age | FAIL: HTTP was attempted with an overlong lease | Yes |
| Per-request credential read | FAIL: rotated request reused the retired credential | Yes |
| Approved scanner hash equality | FAIL: preflight accepted another well-formed hash | Yes |

The symlink fixture keeps the target bytes, link size and actual byte count valid.
The size fixtures match the modified bytes' hashes. The input fixtures keep every
other binding valid. These failures therefore test the named guard independently.

Test commits preceded the production fix. Cleaned the changed code against the
engineering standard: shared decisions, small named functions, separate statements,
no new dependencies, no copied schema and no changed business-state or event contract.
Two NATS fixture cases hit their existing process deadline while checks ran in
parallel; the remaining verification runs serially without changing those deadlines.

The application image was rebuilt from the production fix commit named above.
The source-bound promotion check passed for all eight image roles; the application
and website each contain the same 580 reviewed components. Re-authenticated all
three Debian main indexes and checked their package lists before changing the
image pin. The actual archive and container passed all 11 image-layer checks.
No registry publication or packaged journey was attempted during these repairs.

| Review verification | Result |
| --- | --- |
| Scanner, refresh, credential, storage and Docker fixtures: 60 tests | PASS twice |
| Historical image fixtures: five suites, 48 Python checks | PASS twice |
| Chart and preflight: 70 checks | PASS twice |
| NATS route preparation: 19 checks | PASS twice, serially |
| Existing server storage-refusal checks: seven tests | PASS |
| Controlled manual guard-removal checks: twelve | PASS: each isolated test failed, then guard restored |
| Workspace and infrastructure typecheck | PASS |
| `check:events`: 174 catalogue entries | PASS |
| Knip, changelog lint and changed-file ESLint | PASS |
| Additional ESLint for changed infrastructure JavaScript | PASS |
| Markdown lint | PASS |
| Public privacy and secret scans | PASS |
| Rebuilt image, all-layer scan, source-bound promotion and Debian main verification | PASS |
| Actual rebuilt image layer and container checks: 11 tests | PASS |
| Fresh packaged journey and both browser widths | NOT RUN: waiting for #1119 |

Retained the worktree for review. No dev stack was claimed during these repairs;
Docker fixtures removed their own disposable containers and images. The rebuilt
application image remains available locally for the later fresh qualification.
