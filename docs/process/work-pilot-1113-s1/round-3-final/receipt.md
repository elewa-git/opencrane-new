# Packaged sign-in qualification

Journey on a fresh dev stack: FAIL

## Installed source and method

The latest install started on 20 November 2026 at 23:13:29 UTC. It used approved
product `bf0a059d8ba7607c8c0b571a2a07e53a2f777a1c`. Exact-source CI and both real
image approval consumers passed before the claim. The application digest was
`cc2afd57dc01fca26b9ef766a54850ccd1cd3213dd0fe56808993de90e4fcf01`; the scanner
was `db39363ab4d5d47d8194d5a6260791f057ef44e2f5c88c5bd3245125fc9e38ce`.
See [approval lookups](image-approvals.txt) and [installation identity](installation.json).

The run claimed secondary slot 1 only after both slots and package stacks were
free, no other journey was active, and load stayed below 6 for five minutes.
The validated pre-claim [capacity record](capacity.log) was saved before claiming.
It used guarded package preparation, private settings, Helm package-up and
package-check, with a new namespace and volumes. Compose was not started.
All dev-stack commands named the secondary id. The owner stack was not touched.
The existing loopback TLS fixture and a temporary app in OpenCrane 2 Dev supplied
real sign-in. No real model-provider key was read. The app was deleted afterwards.

The installed application stayed at the latest approved product commit. The
qualification-only token-probe correction was committed as `301258479`, retained
on a backup branch, and run from its exact private copy while the checkout was
reset to the approved product. Its exact script and helper were copied into the
private run receipt. Those commits change qualification files only; installed
application code is unchanged. The branch tip was restored after teardown.

## Observed results

| Condition | Result |
| --- | --- |
| New guarded package and approved image bindings | PASS |
| All nine unsafe install refusals before Helm | PASS |
| Real wrong-organisation sign-in at 1280 and 390 px | PASS |
| No member or event created by wrong-organisation sign-in | PASS |
| Owner claim, wrong-token refusal and original-owner token reuse refusal | PASS |
| Initial empty workspace receives its assignment without reload | PASS at 1280 px |
| Owner chat and Secure/HttpOnly cookies at both widths | PASS |
| Admin chat and Secure/HttpOnly cookies at both widths | PASS |
| Member chat and Secure/HttpOnly cookie at 1280 px | PASS |
| Member sign-in and Secure/HttpOnly cookie at 390 px | PASS |
| Member chat at 390 px | FAIL |
| Corrected member token-reuse probe and unchanged-role checks | NOT RUN; stopped at chat |
| Safe error code, failing step and masked failure screenshot | PASS |
| Startup and current service logs retained before teardown | PASS |
| Earlier dispatcher-container failure logs | PARTIAL; previous containers were not retained |
| Package-down, slot release and temporary-app deletion | PASS |
| Production F1/F2 host and private-memory qualification | PARTIAL / NOT RUN; accepted local exception and scope unchanged |

The [browser results](browser-product.json) retain each observed result.
[Coordinator outcomes](outcomes.json) retain cleanup. The sampled one-minute load
ranged from 1.15 to 4.56, peaking at 23:19:00 UTC; see [load samples](load-during-run.log).

## Remaining member failure

The safe failure is `member 390px reply`, `BROWSER_TIMEOUT`, screenshot `PASS`.
The [failure screenshot](failed-product.png) shows an unselected new session and
an outcome-unknown queued draft. Its form value is masked. The request trace
records conversation creation HTTP 200 and no following message POST.

The server accepted creation at 23:20:10.616 UTC. The content projection completed
at 23:20:10.661, in 14 ms; see [projection timing](creation-projection.log).
The client then performed its existing creation catch-up reads, but the new
conversation did not appear in the authorised list. It kept the draft and did
not send a message. No access check was bypassed and no request was manually retried.

The dispatcher had [three restarts](dispatcher-status.json), with exit code 1
rather than an OOM termination. Its current [service log](worker-dispatcher-7d66ccfd88-hf9tn.log)
records PostgreSQL connection-pool timeouts, including the `update-openfga` queue.
This identifies a stalled permission-processing path; the precise reason for
its earlier exits remains unconfirmed because previous-container logs were not
saved. It is not a passing reply or an established budget refusal.

The original member 1280 px failure also accepted conversation creation with
HTTP 200 before repeated list reads and no message POST. The rapid-Enter composer
race found in focused tests is real and fixed, but it does not explain this
creation-to-message stall. The original failure is therefore not claimed fixed.
No pool, CPU, access, money, memory or timeout setting was changed speculatively.
The full journey remains FAIL and this draft is blocked from merging.

## Token probe correction and earlier attempts

The previous fresh run passed all six role/width chats and cookies, then failed
its token-probe assertion. The [separate failed receipt](../round-3-token-failure/outcomes.json)
and [masked screenshot](../round-3-token-failure/failed-product.png) preserve it as FAIL.
The server correctly returned HTTP 409. The existing claim contract returns
`token_used` to the original owner and `owner_exists` to a different identity.
The probe had incorrectly required `token_used` for the member.

Test-first `9300810ce` fails on that mismatch. Fix `301258479` requires exact
HTTP 409 and the complete `{status: refused, reason: owner_exists}` response,
rejects success and other refusal bodies, and checks both identities and roles
remain unchanged. The original owner's `token_used` assertion stays in place.
All eight qualification tests pass twice. The stronger corrected probe is NOT RUN
live in the latest install because member chat failed first.

An earlier fresh attempt failed before browser startup because two local helper
imports were absent. Its [failed receipt](../round-3-runner-failure/outcomes.json)
is retained. The executable-import test now catches that failure before a slot
can be used. Neither failed attempt has been converted into a pass.

Full safe service logs and the exact qualification scripts remain in the private
fleet receipt for this run. The checkout and worktree remain for review.
