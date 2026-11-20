# Install hardening journey

Journey on a fresh dev stack: FAIL

## Latest round 3 result

20 November 2026. The fresh install from approved product `bf0a059d8` remains
FAIL at member chat at 390 px. All nine refusals, wrong-organisation sign-in,
owner token checks, owner/admin chat and cookies at both widths, member 1280 px
chat and cookies, and member 390 px cookies passed. The initial empty owner
workspace also received its assignment without a reload. The corrected member
token-reuse probe is NOT RUN because chat failed first.

The safe reason is `member 390px reply`, `BROWSER_TIMEOUT`, screenshot `PASS`.
Creation returned HTTP 200, but no message POST followed. The content projection
finished in 14 ms; the dispatcher restarted three times and its permission queue
recorded PostgreSQL pool timeouts. The precise restart cause remains unconfirmed.
No retry, timeout increase or weakened check was used. All owned resources were
removed after current service logs and screenshots were retained. Sampled load
was 1.15–4.56. See the [final round receipt](round-3-final/receipt.md).

The rapid-Enter regression is fixed test-first, but the original member failure
also accepted creation before its list catch-up stalled. It is not claimed fixed.
The overall journey remains FAIL; this draft must not merge.

## Latest correction attempt

20 November 2026, 22:15 UTC. Source `48a44288f` had green CI and both real
image approval consumers before the claim. The fresh package installed and all
nine pre-Helm refusals passed. The browser then failed to import `tls-cleanup.mjs`;
`join-handoff.mjs` was also absent beside the newly tracked runner. Browser
sign-in, owner claim, role chats, cookies and member token reuse are NOT RUN.
No browser page existed, so no failure screenshot could be captured. The full
journey is FAIL. All 28 startup/service logs were saved before package-down,
slot release and temporary-app deletion; all three cleanups passed.
See the [failed-run outcomes](round-3-runner-failure/outcomes.json) and
[safe import error](round-3-runner-failure/browser-wrong-org.log).

The executable-import, tunnel-cleanup and joined-access tests failed first with
missing helpers. They passed twice after the existing helpers were tracked beside
the runner. The corrected source still needs its own approved fresh install.
This failure does not pass any skipped browser condition.

## Previous packaged run

20 November 2026. The fresh packaged install tested product commit
`b53d05e69496734966c4a10be02b691c5a595527`. Package preparation passed with the
approved application and scanner images. All nine install refusals and real
wrong-organisation sign-in at 1280 and 390 px passed. Owner claim, wrong-token
refusal, token reuse refusal, owner chat and Secure and HttpOnly cookies passed
at both widths. Admin sign-in, chat and Secure and HttpOnly cookies passed at
both widths. Member sign-in and its Secure and HttpOnly cookie passed at 1280 px,
and joined access was ready before the first protected read. Member 1280 px chat
failed. The browser recorded `code=withheld; details withheld`, and its failure
screenshot could not be captured. Member 390 px checks and the member token
reuse check are NOT RUN. Package-down, stack down and temporary test app cleanup
passed. Sampled one-minute load ranged from 1.03 to 7.48 during the packaged run.
The full journey is FAIL. See the [packaged run receipt](round-3-packaged/outcomes.json),
[browser results](round-3-packaged/browser-product.json),
[safe browser log](round-3-packaged/browser-product.log),
[load samples](round-3-packaged/load-during-run.log) and saved screenshots.

Round 2, 20 November 2026. Product fix: `f4ce844c1`; test-first commit: `c9a572b19`.
The local source gates, exact-source CI and both image approval consumers pass.
The first full fixed-source run failed at the admin access handoff described below.
A new fresh qualification was refused at admission, before installation, because
the other secondary slot was no longer free. The earlier full qualification also remains FAIL.
No independent-review verdict is claimed.

## Round 4 packaged journey attempt

At product source `b53d05e69496734966c4a10be02b691c5a595527` (worktree head
`75ffe9be9da3c3695a31cb913a4b475bb022bd7e`, documentation only), CI and both
image approvals had already passed. Admission qualified after 11 checks over more
than five minutes: both secondary slots and locks stayed free, no package namespace
was present, and one-minute load ranged from 0.91 to 1.59. The samples are in
[admission observations](round-4-run/admission-observations.log).

The guarded package preparation step failed with the exact message:
`Package command refused; check pins, named secrets and slot ownership`. It created
an owned namespace record but no pods, PVCs, services or jobs. The resource
list and package owner record are retained in [the run evidence](round-4-run/).
Package-down and slot release passed.
The install refusals, sign-in, owner claim, token refusal and reuse, all role and
width journeys, cookies, and screenshots are NOT RUN. The overall fresh packaged
journey remains FAIL. See [outcomes](round-4-run/outcomes.json) and the
[sanitised command output](round-4-run/package-prepare-error.log).

## Round 3 admission wait

At head `b53d05e69496734966c4a10be02b691c5a595527`, all CI checks and both image
approval workflows passed: [CI](https://github.com/elewa-git/opencrane-new/actions/runs/44783553936),
[application](https://github.com/elewa-git/opencrane-new/actions/runs/44783556179) and
[scanner](https://github.com/elewa-git/opencrane-new/actions/runs/44783556418).

The packaged journey was NOT RUN. The first admission wrapper stopped before a slot
claim because its capacity-log file was absent; no stack command ran. After restarting
the sampler with saved output, the two-hour admission wait ended with another journey
process still active. No five-minute capacity window qualified. An earlier
window reached 299 seconds before capacity lookups failed; the final recorded window
reached 179 seconds with both slots and package stacks free. See the
[earlier samples](round-3-admission/capacity-early.log),
[final samples](round-3-admission/capacity.log),
[busy checks](round-3-admission/admission-observations.log) and
[outcomes](round-3-admission/outcomes.json) record the admission result. No slot was
claimed, package was installed, sign-in app was created or journey step started.
There are no screenshots or startup/service logs for this attempt. The overall
fresh packaged journey remains FAIL because the earlier full run stopped at admin.

## Reproduced workspace failure

A separate fresh packaged diagnostic used the previously approved source
`81bf17f5c53adca14ae310618684c319ec45edd1`. Both secondary slots were free and
one-minute load stayed below 6 for more than five minutes before the claim.
It repeated all nine pre-Helm refusals, both real wrong-organisation checks,
zero member/event creation, first-owner claim, wrong-token refusal, token reuse
and Secure/HttpOnly owner cookies. This diagnostic did not run admin/member chat.

The computer worker recorded `assistant.created` at 15:14:17 UTC and
`computer.ready` at 15:14:35 UTC. The open workspace still showed no assistant
and no usable composer. A direct `GET /api/chat` returned 200 with an assigned
assistant. One manual reload made the composer visible and enabled. See the
[recorded checks](diagnostic/reload-diagnosis.json),
[page before reload](diagnostic/before-manual-reload.png),
[page after reload](diagnostic/after-manual-reload.png) and
[provisioning times](diagnostic/provisioning.log).

The server could read the projection. The browser had read `/api/chat` only once
and opened its live connection only after a conversation was selected or created.
An empty assistant assignment was a successful read, so read-failure recovery
never refreshed it. The new `chat-context` subscription uses the HTTP context
builder and the existing session, active membership and `acts_for` checks. The
browser applies its own assignment and closes this subscription once assigned.
No retry, sleep, longer timeout or forced reload was added to the product.
The manual reload above is diagnostic evidence, not a passing product journey.

One-minute load ranged from 2.26 to 10.71 during the diagnostic, including startup
and cleanup. The peak sample was at 15:15:36 UTC. The
[30-second load samples](diagnostic/load-during-run.log) and
[admission log](diagnostic/capacity.log) retain the measurements.
The retained dispatcher log contains no timeout or pool-error line; see the
[dispatcher check](diagnostic/dispatcher-load-check.txt).
This short run does not qualify sustained load.

[Safe logs and outcomes](diagnostic/outcomes.json) were kept before teardown.
The package, its slot claim and its temporary sign-in app were removed.

## First full fixed-source run

The first full run used source `ccea595758cb5ab60b01bf23891b71eb485273b4`, after
[CI](https://github.com/elewa-git/opencrane-new/actions/runs/44763305277),
[application packaging](https://github.com/elewa-git/opencrane-new/actions/runs/44763328752)
and [scanner packaging](https://github.com/elewa-git/opencrane-new/actions/runs/44763332412)
passed. Both real approval consumers accepted the artifacts.

All nine install refusals and both wrong-organisation checks passed again.
Owner sign-in, chat, Secure and HttpOnly cookies passed at both widths
([1280 px](round-2-attempt-1/owner-chat-1280.png),
[390 px](round-2-attempt-1/owner-chat-390.png)). Admin
sign-in and cookie checks passed at 1280 px, but its first workspace context read
returned 403. Admin chat and all member checks were NOT RUN after that refusal.
The [outcomes](round-2-attempt-1/outcomes.json) retain this run as FAIL.

The [timing record](round-2-attempt-1/join-access-timing.log) identifies a fixture
preparation error. The join returned 200 at 16:24:26.984 UTC. The members projection
completed at 16:24:27.158. The workspace read began at 16:24:27.777 and returned
403 at 16:24:27.791. OpenFGA completed the join projection at 16:24:28.361.
The refusal protected the workspace while permission was still being applied.

The [join contract](../../../apps/server/README.robot.md) says the receipt confirms
the saved join and lets a caller wait for projection delivery. The existing native
dev journey waits for the member's OpenFGA permission before chat. This fixture
had omitted that preparation step. Product access checks remain unchanged.
A focused fixture test reproduced opening the workspace too early, then passed
twice after waiting for the actual membership permission. It also asserts that
the protected workspace request happens exactly once:
[red](round-2-attempt-1/join-handoff-red.txt),
[first green](round-2-attempt-1/join-handoff-green-1.txt),
[second green](round-2-attempt-1/join-handoff-green-2.txt),
[test](round-2-attempt-1/join-handoff.test.mjs.txt) and
[corrected helper](round-2-attempt-1/join-handoff.mjs.txt).
The failed request was not retried and this install was not turned into a PASS.

Sampled one-minute load ranged from 4.01 to 12.92. The dispatcher recorded one
connection-pool timeout for the `dream-memory` queue at 16:24:31.145 UTC; see the
[load samples](round-2-attempt-1/load-during-run.log) and
[dispatcher log](round-2-attempt-1/worker-dispatcher-7c6bd7d6c7-d4jdq.log).
No pool or timeout setting was changed. Six screenshots and service logs were
kept before teardown. The failure screenshot could not be captured, so that
part of the evidence is PARTIAL. The owned package, slot claim and temporary
sign-in app were removed.

## Fresh requalification admission

The corrected fixture waited from 16:32 UTC for both secondary slots, no package
stack and five minutes below load 6. The 30-second samples finally qualified at
17:25:52 UTC. The wrapper rechecked capacity and claimed a secondary slot. Its
post-claim check then found that the other slot was no longer free. The run stopped
before package preparation, with no namespace, volumes or temporary sign-in app
created. Its own package-down and down checks passed. See the
[admission outcomes](round-2-admission/outcomes.json),
[capacity samples](round-2-admission/capacity.log) and
[runner output](round-2-admission/run.log).

This is an admission FAIL, not a product journey. Requalification after the fixture
correction is NOT RUN. The three-hour work limit leaves insufficient time for a new
five-minute capacity window, a full install and journey, preserved logs and teardown.
The full fixed-source journey above remains FAIL. No skipped role or width passes.
The source fix and all its local gates, CI and both image approvals remain PASS on
`ccea595758cb5ab60b01bf23891b71eb485273b4`. The final update changes evidence only;
its new CI and image workflows must be checked separately before landing.

## Earlier full qualification

The remaining sections retain the failed full qualification from the previous round.

Date: 20 November 2026. Packaged source:
`77fc69f35a6b65cc94bf263ddefa121488ad75c1`, rebased onto `ed3662d85`.
The latest fresh install ran from 13:53 UTC. First-owner sign-in and token checks
passed. The first-owner workspace kept its initial unassigned state after
provisioning completed. Admin/member sign-in and chat remain NOT RUN.

## Source and image approval

The original unpublished-source refusal was correct. After publication, the
application workflow exposed a completion-message regression. The test-first
fix preserves the development-owner message and reports claim readiness in token
mode. See the [source checks](checks.md).

[CI](https://github.com/elewa-git/opencrane-new/actions/runs/44729079211),
[application packaging](https://github.com/elewa-git/opencrane-new/actions/runs/44730045363)
and [scanner packaging](https://github.com/elewa-git/opencrane-new/actions/runs/44729074136)
succeeded on the exact source above before any install. The real approval consumers
accepted both artifacts. [Safe approval results](image-approvals.txt) record the
accepted run ids and image digests. Package preparation and preflight fetched them again.

The digests below belong to the latest install. Each earlier attempt also used
CI-approved images for the same source; its private outcomes retain those bindings.

- Application: `sha256:262c2e1017d560f004cc5e145728694a8640e5f8ae204bc890328ea18128a096`.
- Scanner: `sha256:9e930a1468700ae8ded1d5c69a7a32ce4f719b57d96c81d034fa540fdbf8706f`.

Main's merged approval lookup fix from PR #1169 is retained unchanged. No second
lookup fix, manual image approval, replacement review file or local candidate was used.

## Installation and sign-in method

Each fresh install used `infra/dev-stack/claim.sh`, then the guarded
`run.sh package-prepare`, `infra/package/prepare.ts`, `run.sh package-up` and
`run.sh package-check` commands. This was the packaged Helm path, with a new
namespace and new volumes. Compose was not started in that slot. Before each
claim, both slots and all package stacks were free and the one-minute load had
remained below 6 for five minutes. Capacity was checked every 30 seconds and
checked again immediately before claiming.

The test hostname and self-signed certificate were reachable only through the
capture browser's loopback proxy. The fixture terminated real TLS and forwarded
to the package's guarded loopback forwarder. No DNS, Tailscale Serve, Funnel,
Ingress, public listener, owner stack, Docker daemon or host network setting changed.
This does not qualify a real public address or certificate issuance.

A temporary HTTPS-only web app was created only in OpenCrane 2 Dev. Its client id
and private credential supplied the test connection. The existing secondary setup
ran read-only. Original apps, people, other organisations and instance settings
were unchanged. The temporary app was deleted during cleanup. No model-provider
key was read; the package used its stand-in model.

The first-owner token was generated through the existing command. Only its hash
record was copied into the package. The token remained in the qualification
process's memory and browser form submission; it was never written into arguments,
events, receipts, logs or screenshots.

Wrong-organisation checks followed the separate-authentication-server method in
the dev-stack guide. The probe ran the real server code inside the approved
package image, with production settings and only the expected organisation changed.
Only the negative check's authentication traffic went to it. Real Zitadel tokens
were refused, with no session cookie. Other organisations were not accessed.
The normal package's organisation pin stayed unchanged during this method.

## Live results

| Step | Result |
| --- | --- |
| Qualify capacity and claim a spare slot | PASS before each fresh install |
| Fresh guarded package install, new namespace and volumes | PASS |
| Refuse each of the six unsafe production sign-in settings before Helm | PASS live |
| Refuse insecure saved runtime settings before Helm | PASS live |
| Refuse a development-owner bootstrap override before Helm | PASS live |
| Refuse an absent token record before Helm | PASS live |
| Start token mode without creating a development owner | PASS; member count was zero |
| Real wrong-organisation sign-in at 1280 and 390 px | PASS |
| Confirm no new member or event after the wrong-organisation check | PASS; member count and event position unchanged |
| Claim the first owner with the one-time token | PASS live |
| Refuse the wrong token and token reuse | PASS live; token input was cleared |
| First-owner workspace becomes usable after provisioning | FAIL; initial unassigned state remained |
| Admin and member sign-in and chat at 1280 and 390 px | NOT RUN; stopped at the first-owner workspace |
| Verify Secure and HttpOnly session cookies | PASS for the owner; other roles NOT RUN |
| Keep safe startup/service logs and available screenshots before teardown | PASS for available artifacts |
| Remove each owned package, release the slot and delete the temporary app | PASS |

## Failed qualification attempts

The first fresh package was healthy and all nine operator refusal checks passed.
The qualification script then waited 60 seconds for a rollout while an old server
Pod was terminating. It stopped before browser sign-in. Logs were saved before
`package-down` and `down`; no screenshot was produced. The temporary app was removed.
One already terminating server Pod no longer had a readable log; current service logs and bootstrap output were retained. That
missing historical Pod log is PARTIAL evidence.
The fixture was changed to the documented separate authentication server, without
extending a timeout or changing the production server's shutdown behaviour.

The next fresh package was also healthy. Both real wrong-organisation browser
checks passed and produced screenshots, but the capture process remained alive
after writing its results. `closeAllConnections()` had not closed its upgraded
HTTP CONNECT tunnels. The completed capture was stopped, and the coordinator
recorded failure. Owner claim and chat were not run on that install. Logs and both
screenshots were kept before teardown; the namespace, claim and temporary app were removed.

A focused real-socket test reproduced the open-tunnel fault before its fix. It
failed with `Qualification cleanup leaves its CONNECT tunnel open` and
`false !== true`. The fixture now tracks and destroys its own sockets when closing
its listeners. The unchanged test passed twice afterwards: [red](fixture-cleanup-red.txt),
[first green](fixture-cleanup-green.txt), [second green](fixture-cleanup-green-2.txt).
No product check or
assertion was weakened, and no retry, sleep or longer timeout concealed a failure.

A later admission attempt lost a race with another task's claim. Its post-claim
check stopped before namespace preparation. The unused claim was released.
No package, startup log, sign-in app or screenshot existed for that admission.

A further fresh install passed the nine operator refusals, both wrong-organisation
checks, the zero-member check, first-owner claim, wrong-token refusal and token reuse.
It then opened People while the ownership access projection was still applying.
The member request returned 503 and the page displayed “Members are unavailable
right now”. The access worker completed the ownership projection two seconds later,
but that page had already shown its explicit failure state. No retry or longer
wait was used to turn that failed request into a pass. The five screenshots and
service logs were copied before teardown. All owned resources were removed.

The latest fresh attempt followed the first-owner workspace before opening People.
The token checks and real wrong-organisation checks passed again. The workspace
reported “No assistant assigned” and “Your personal agent is being prepared.
Refresh shortly.” Its composer did not become usable within the unchanged check.
The workers recorded `assistant.created` at 13:58:33 UTC and applied `computer.ready`
at 13:59:00 UTC, while the workspace retained its earlier unassigned state.
The failure screenshot shows that state after provisioning completed.

The workspace reads its context when opened. An initially absent assignment is
not a read failure, so the existing read-failure recovery does not refresh it.
No browser reload, request retry, sleep, longer timeout or product change was used
to turn this result into a pass. The later manual-reload diagnostic above confirms the missing live update.
The fix now watches the personal assignment while the workspace is unassigned.

## Accepted local host gap

The install used the documented per-command
`OPENCRANE_ACCEPT_DEV_HOST_RISK=accepted-dev-box-366` exception from
[the package guide](../../../infra/package/README.robot.md#accepted-local-exception).
The recorded host checks and accepted failures were kept before teardown.
Production F1/F2 qualification is PARTIAL; this is the owner's accepted local gap,
not a production host-check PASS. Swap, crash-dump settings and private-memory
admission were unchanged. Private-memory qualification is not claimed.

## Retained evidence

The [latest outcomes](live/outcomes.json), [browser results](live/browser-product.json),
[sign-in refusals](live/browser-wrong-org.json), [capacity log](live/capacity.log),
[installation record](live/installation.json), [resource identities](live/resources.json)
and safe startup/service logs were copied before teardown. Full safe service logs
and the exact qualification scripts are also retained in the private fleet receipts.

- [Wrong organisation at 1280 px](live/wrong-organisation-1280.png).
- [Wrong organisation at 390 px](live/wrong-organisation-390.png).
- [First owner claimed](live/owner-claimed-1280.png).
- [Token reuse refused with an empty token input](live/token-reuse-1280.png).
- [Workspace after provisioning](live/failed-product.png).
- [Earlier People failure](earlier-people/failed-product.png).
- [Provisioning events](live/provisioning.log).

Fresh volume identities from the latest install:

- `backups`: `9f190141-df87-49b0-8cbd-bb96bb6ce1a9`, created `2026-11-20T13:55:48Z`.
- `data-nats-0`: `261dc40c-1c88-4e1b-a6a7-f80823c44794`, created `2026-11-20T13:55:48Z`.
- `data-objects-0`: `9a3ca472-0bfd-43ee-b900-99ea5056342f`, created `2026-11-20T13:55:48Z`.
- `data-postgres-0`: `55e7a55e-aa58-49be-85da-76e665eb6175`, created `2026-11-20T13:55:48Z`.
- `home-computer-a39df7e19bb5235d72898e6cc6fbc911`: `f2634ab6-74a8-48af-8691-4344cffd00db`, created `2026-11-20T13:58:39Z`.
- `pilot-restore`: `fd64ccda-db96-443e-ba4c-967b1856a8a5`, created `2026-11-20T13:55:48Z`.

The latest install, its slot claim and its temporary sign-in app were removed.
The checkout and worktree remain for review. No independent-review verdict is claimed.
This draft cannot merge until the complete fresh packaged journey passes.
Real public access, DNS, certificate issuance and hosted tenant setup remain outside
this slice in #1163.
