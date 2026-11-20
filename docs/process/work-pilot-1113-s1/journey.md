# Install hardening journey

Journey on a fresh dev stack: FAIL

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
to turn this result into a pass. Whether this first-owner handoff should wait,
update itself or explicitly lead the person through a refresh remains unresolved
in this round. A further speculative qualification attempt was not made.

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
