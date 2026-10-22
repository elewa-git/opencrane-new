# Demo rehearsal

Status: PARTIAL for #32. Both fresh rehearsals passed all ten steps on source
`acce167e9bed1f33ca5fbf0c1c853eb4ae8c9b6d`. It contains every prerequisite,
including both Stop fixes. This draft does not qualify a merged owner demo commit.

## Limits and commands

The task limit is 1,000 euro cents, including charged cents and unresolved holds.
Each run set both company ceilings to 500 cents. The refusal step lowered the limit
to today's spending and restored it. Nightly uses the free stand-in and clears paid settings.

`npm ci` installed this worktree. The requested NATS and lychee tools are symlinked
in `.tools/`. `claim.sh` returned slot 1. Each run used these kit commands:

```sh
export DEV_STACK_ID=1
export ZITADEL_KEY_FILE=/home/jente/dev/opencrane-new/.keys/.zitadel-key
export DEV_REAL_PROVIDER_FILE=/home/jente/dev/opencrane-new/.keys/.openai-key
export DEMO_ALLOWANCE_CENTS=500
export COMPUTER_IDLE_MS=14400000
export P4_JOURNEY_ATTEMPT=demo-rehearsal-verified-a
infra/dev-stack/up.sh --id 1 --fresh
node --experimental-strip-types infra/dev-stack/demo-seed-run.ts
node --experimental-strip-types infra/dev-stack/demo-smoke-run.ts
node --experimental-strip-types .tools/demo-rehearsal-pages.ts
infra/dev-stack/down.sh --id 1
```

The second run used `demo-rehearsal-verified-b`. The last browser command is a private
operator helper; [its hash is recorded](page-checker.json). Only product provider setup
read the paid file. Its value was never printed. Proof was copied before cleanup.

## Fresh-install results

| Check | [First install](rehearsal-a/receipt.json) | [Second install](rehearsal-b/receipt.json) |
| --- | --- | --- |
| Fresh startup and kit seed | PASS | PASS |
| Streamed reply and reload | PASS | PASS |
| Scanned supplier PDF total/date, preview and download | PASS | PASS |
| Action history | PASS | PASS |
| Stop and partial reply after reload | PASS | PASS |
| Member messages owner live at 390px | PASS | PASS |
| Private shared-assistant reply | PASS | PASS |
| Group and unopened invitation link | PASS | PASS |
| Model answered with key hidden | PASS | PASS |
| Company ceiling refusal and restored limits | PASS | PASS |
| Change history for limits and groups | PASS | PASS |
| All eight group checks, including zero AI/computer/budget work | PASS | PASS |

The older journey leaves its separate paid-answer and member-disk-isolation rows unproved.
Real answers are proved by product setup and smoke; disk isolation is outside this script.
Both receipts contain UTC times, full source SHA and pictures at 1280px and 390px.
Image identifiers are saved for [install A](rehearsal-a/images.txt) and [B](rehearsal-b/images.txt). Startup through final logout took 806 and 715 seconds. Smoke runs
at 1280/390 took 55,112/55,769 ms and 55,792/54,444 ms; warm-up took 20,644/23,536 ms.
Each install used 15 paid chat turns and one provider verification: 29 cents charged,
51 held, 80 total. Both company ceilings were restored to 500 cents.
The task total, including every earlier attempt, is **440 cents: 169 charged and 271 held**.

The [second Stop picture](rehearsal-b/smoke/stop-390.png) shows both “Reply failed” and
“Stopped · partial reply kept”. The partial reply survives reload; the labels remain mixed.
Owner refresh, physical-phone access, laptop tunnel and Safari: NOT RUN.
A 390px Chromium window does not prove a physical phone or Safari.

## Retained earlier attempts

Receipts include full source SHA, attempt, timings, paid reservations and cents.

| Source and receipt | Outcome | Charged cents | Held cents |
| --- | --- | --- | --- |
| [b3c4c4075](failed-b3c4c4075/receipt.json) | FAIL: real private reply checked against stand-in text | 13 | 17 |
| [688be242a](failed-688be242a/receipt.json) | FAIL: second synthetic colleague's HTTP join returned 409 | 13 | 16 |
| [c96931aad](failed-c96931aad/receipt.json) | FAIL: server restarted before an offline replay rebuild | 13 | 16 |
| [abacbe417](failed-abacbe417/receipt.json) | FAIL: group display timeout; wrong history event name | 29 | 51 |
| [85714c511](failed-85714c511/receipt.json) | FAIL: list read asserted 200 during a documented moving list | 13 | 17 |
| [d89186d28 A](prior-d89186d28-a/receipt.json) | PASS: all ten steps and eight group checks | 29 | 52 |
| [d89186d28 B](failed-d89186d28-b/receipt.json) | FAIL: temporary binding-read 503 after verification | 1 | 0 |

These earlier attempts total 280 cents including holds. The first three stopped before
kit seed and smoke. Later failed proof remains available; none substitutes for the final pair.

## Source checks

- PASS: failing-first commits precede fixes, including the binding-read 503 regression.
- PASS: 32 focused Node tests twice; 17 owner/mode refusal tests twice; changed scripts compile.
- PASS: required lint and workspace typecheck; event catalogue, Knip and changelog checks.
- PASS: 438 event-security tests with the supplied `PG_TEST_URL`.
- PASS: nightly fixtures cover unique attempts, paid settings cleared, failure retained before cleanup,
  failed-journey propagation and claimed-id-only cleanup. Live nightly stand-in install: FAIL.
- FAIL: an additional compiler check across every dev-stack script found existing errors in
  `mcp-journey.ts`, `wake-latency.ts` and `zitadel-setup.test.ts`, outside this change.

[Source check details](checks.json) distinguish the required workspace checks from that extra check.
Checks and tests used `nice -n 10`. No local full root test suite or fleet batch ran.
GitHub CI is reported on the draft PR for its pushed head. No older nightly SHA qualifies it.
[The free nightly install](nightly-failed/receipt.json) failed before groups: the existing tool
review returned HTTP 409. It retained sanitised failure logs before cleanup; paid calls: zero.
Slot 1 was held through cleanup after each install. The owner stack, port 44200 and its data
were untouched. No dependency, product event or protected authority/security test changed.

## Harness corrections, 22 October 2026

The restarted-server health read now has an abort timeout equal to the time left in
its two-minute deadline. It retries connection failures and HTTP 502, 503 and 504.
Other HTTP failures stop the journey at once. The nightly fixture now reads, trims
and splits its attempt file in separate named steps, with expanded validation loops.

PASS: removing the health abort signal or the immediate HTTP refusal makes its new
test fail. Removing the private reply completion wait, the empty-answer check, or
just the whitespace trim makes the corresponding test fail. Removing 425 recovery
or the conversation-list status check also makes its test fail. All guards were restored.
The tests were committed before the health behaviour changed.

Source checked: `07d7be8173cb9fef065f73bf56378efd5b5d9293`. PASS: 33 changed-file Node tests twice,
lint, workspace typecheck, an extra compile check for the changed harness files, the
149-type event catalogue, Knip and changelog checks. The Node tests used one worker,
`nice -n 10` and the supplied `PG_TEST_URL`. The first test and lint attempts ended
with SIGTERM before a verdict; complete reruns supply the results recorded here.

### Picture check

Checked `unopened-invite-1280.png` and `unopened-invite-390.png` in each folder below:

| Folder | What the pictures show |
| --- | --- |
| `rehearsal-a/pages/` | Desktop: the chosen owner test user and synthetic users. Mobile: synthetic invite address only. |
| `rehearsal-b/pages/` | Desktop: the chosen owner test user and synthetic users. Mobile: synthetic invite address only. |
| `prior-d89186d28-a/pages/` | Desktop: the chosen owner test user and synthetic users. Mobile: synthetic invite address only. |
| `failed-abacbe417/` | Desktop: the chosen owner test user and synthetic users. Mobile: synthetic invite address only. |

The desktop people tables show `jente@elewa.ke`, `audit-other-member@example.test`,
`p4-5-later-participant@example.test`, `opencrane2-dev-ci-1-member@example.test` and
`opencrane2-dev-ci-1-owner@example.test`. Every invitation uses
`rehearsal@example.invalid`; its link is already covered. The owner's decision of
22 October permits the chosen owner test address in these private test pictures.
No other real address appears, so no picture or masking change was needed.

Also checked `group-1280.png` and `group-390.png` in those four folders, and the retained
`groups-list`, `groups-search`, `groups-created`, `groups-detail`, `groups-removed`,
`groups-removal-review`, `shared-assistant-choice`, `shared-assistant-create`,
`shared-assistant-create-response`, `shared-assistant-created`, `shared-assistant-review`,
`direct-chat-recipient`, `group-picker`, `group-denied-selection` and `group-join-position`
pictures under `rehearsal-a/groups/`, `rehearsal-b/groups/` and
`prior-d89186d28-a/groups/` (including their `group-chat/` folders). These show names,
member ids or synthetic data; no further real address appears.

### Remaining guard checks

Removal checks NOT RUN in this round: groups-only exclusion of provider and ownership checks;
direct-chat model, computer and budget event-count refusals; conversation-list
deadline and request timeout; provider-binding deadline and slow final read;
restart process identity, both processes stopped during replay and restart order;
nightly current-attempt and symlink restrictions, redaction or withholding failures,
and receipts longer than 100 lines. These remain follow-ups.

Paid rehearsals and live journeys: NOT RUN in this round, as requested. Earlier live
results and spending above are unchanged. The orchestrator's narrow health verify
remains separate from these local checks.

## Nightly 409

22 October 2026. Source: `5e54cdb6514f62e3491d1635ef585fe0f1616c57`.
The 409 fix passed live. The full nightly run is **FAIL** on a later group timing check.
[The receipt](nightly-409/receipt.json) records every group result and the request path.

The earlier failed request was `POST /api/org/integrations/journey-5b7c672b-70d5-4b95-aabe-4b57a90a8642/review`.
The API maps a conflicting tool-policy command to 409. The journey selected Allow for
its read-only fixture but supplied no action, consequence or safe argument fields.
`reviewedToolChoices` refuses that combination even when its revisions, timestamp
and review digest match. The fixture now declares those details. Discovery still
leaves tools blocked, and the write fixture stays blocked.

This was a valid product refusal of an incomplete journey fixture. It was not the
conversation list's `list_changed` reply or an already-decided action approval.
The helper generates a fresh command UUID and reads the saved catalogue before
posting. Waiting or changing the order cannot supply the missing review details.
Paid rehearsals use the separate real-model branch and skip this stand-in tool fixture.
No product API, event, access check or one-decision rule changed. HTTP 409 still fails
this journey immediately.

The failing regression was committed first as `338ee8f39`. It reproduces the missing
review details through the API's validator without services. It passes after the fix;
removing those details still refuses Allow even with a matching review digest.
PASS: 14 focused nightly, cleanup and stand-in tests twice; 438 event-security tests
once; lint, workspace typecheck, focused TypeScript check, event catalogue, Knip and
changelog checks. Tests used the supplied `PG_TEST_URL`; checks ran under `nice -n 10`.
Local full root suite: NOT RUN, as requested. No dependency was added.

The single live command was `nice -n 10 infra/dev-stack/daily-fresh.sh`, with
`ZITADEL_KEY_FILE` pointing to the existing private file. `claim.sh` reserved secondary
slot 1, which the nightly command reused. It ran fresh from 04:28:14 to 04:39:50 UTC,
with attempt `nightly-20261022T042814-0c8d0d01-6162-4ec5-abe3-52a2ee5c21af`.
The nightly script cleared paid settings. Paid calls and paid cents: zero.

| Nightly step | Result |
| --- | --- |
| Fresh startup, sign-in and local provider setup | PASS |
| Member grants, chat, reload and reconnect | PASS |
| PDF upload, scan, read and EICAR refusal | PASS |
| Computer suspend, wake and Pod replacement with saved files | PASS |
| Exact Owner tool review and integration access checks | PASS: review HTTP 200 |
| Private action history and budget checks | PASS |
| Group administration, private shared assistant and direct chat | PASS |
| Group mode before first send and mode kept after send | PASS |
| Group messages with zero AI, computer and budget activity | PASS |
| Later participant sees only messages after joining | PASS |
| Removed participant clears within two seconds | FAIL: 2,244 ms; transcript empty |
| Leaving clears access and updates remaining participants | PASS |
| People picker, long names, no matches and denied selection | PASS |
| Unsupported recipients refused without a saved draft | PASS |
| Group replay keeps participants and mode | PASS |
| Final member/catalogue replay verification and web page check | NOT RUN: group failure stopped the run |
| Cleanup of the claimed slot | PASS |

All eight group checks ran; seven passed. The removal timer includes waiting for the
Owner's participant list before observing the removed person's browser. The receipt
therefore does not establish exactly when that transcript cleared. The two-second
limit and failed result remain unchanged. No second live attempt ran.

Before cleanup, the nightly command kept sanitised logs, pictures and its group receipt
under `~/.opencrane/daily-fresh/nightly-20261022T042814-0c8d0d01-6162-4ec5-abe3-52a2ee5c21af/`.
A separate observer retained the review's HTTP 200 and group receipt before teardown.
The slot directory and its Compose containers were removed. The owner stack and port
44200 were untouched. Paid answers, member disk isolation and physical-phone checks:
NOT RUN in this attempt. GitHub CI is reported for the pushed PR head.

## Group removal timing

PRODUCT CHANGE: no. Timing qualification: **PARTIAL**. One of the three fresh nightly
commands reached removal and passed. Two failed earlier, so they cannot establish
whether removal meets the two-second rule. No measured removal exceeded two seconds.
The product and its access rules are unchanged. No changelog fragment was added.

On 22 October 2026, all three commands used the same claimed secondary slot, `1`,
with website `http://127.0.0.1:25106`. Each command was
`ZITADEL_KEY_FILE=/home/jente/dev/opencrane-new/.keys/.zitadel-key nice -n 10 infra/dev-stack/daily-fresh.sh`.
Each requested a fresh install. The nightly script cleared paid-provider settings;
paid calls and paid euro cents were zero. Cleanup passed after every attempt.
The owner stack and port 44200 were not used. The secondary directory and its
Compose containers were absent after the last cleanup.

| Run | Source SHA | UTC start–finish | Nightly result | Removal result |
| --- | --- | --- | --- | --- |
| 1 | `3ad4f987609059a0652f78a6b45d829b7dccb470` | 07:29:58–07:42:18 | PASS | PASS |
| 2 | `f588351695d5fd4e1b50caef6379795fbd59ca04` | 07:42:57–07:54:41 | FAIL | NOT RUN |
| 3 | `f588351695d5fd4e1b50caef6379795fbd59ca04` | 07:55:41–07:57:25 | FAIL | NOT RUN |

The attempts were, in order:

- `nightly-20261022T072958-69f21ebf-707f-40ed-b626-2daa88b800fa`
- `nightly-20261022T074257-4caa3f98-b4fe-4aee-b54b-b5f3a5aea1cb`
- `nightly-20261022T075541-7cf07d9a-2dd9-4c9a-9a4b-d52f9a98ccc2`

The timer now starts at the successful removal HTTP response. Observers are already
watching the removed person's open page, live connection and saved access event.
Their next history and file-list reads start after that response, alongside the
Owner's list observation. Run 2 and run 3 also check that the Owner's list initially
shows the person. Run 1 observed the list change after acceptance, at 716 ms.

| Hop, milliseconds after acceptance | Run 1 | Run 2 | Run 3 |
| --- | --- | --- | --- |
| Removal accepted | 0 — PASS | NOT RUN | NOT RUN |
| Saved removal observed | 15 — PASS | NOT RUN | NOT RUN |
| Updated access stream observed | 15 — PASS | NOT RUN | NOT RUN |
| Removed person's live feed closed | 150 — PASS | NOT RUN | NOT RUN |
| Removed person's page cleared, with no message rows | 163 — PASS | NOT RUN | NOT RUN |
| Next history read returned 403 (refused) | 129 — PASS | NOT RUN | NOT RUN |
| Next file-list read returned 403 (refused) | 114 — PASS | NOT RUN | NOT RUN |
| Owner's participant list updated | 716 — PASS | NOT RUN | NOT RUN |
| Revocation of previously readable files | NOT RUN | NOT RUN | NOT RUN |
| Open computer viewer revocation | NOT RUN | NOT RUN | NOT RUN |
| Pending approval revocation | NOT RUN | NOT RUN | NOT RUN |

Saving removal and updating access are the same event in `participation-*`.
The server saves it before returning success. The two 15 ms entries record when
the observer read it, rather than a later product change. Page and API observations
are upper bounds: they include 20 ms polling and request time. The Owner list does
not set the two-second access result. A missing access observation fails the check.
This people-only group chat already returned 403 for files before removal and has
no computer viewer or pending approval. Its file refusal does not qualify loss of
previously readable files, and these three parts of the wider owner rule remain NOT RUN.

Cause of the old measurement: the clock started before the Remove click, and the
journey waited for the Owner's list before inspecting the removed page. It could
therefore fail after the page had already cleared. The old 2,244 ms receipt does
not establish the page's actual clearing time. The two paid rehearsals measured
1,112 ms with the same product code, but used that old timer too. The corrected
run did not reproduce a product timing breach; its slowest access observation
was 163 ms.

Run 2 failed before removal because the first group message did not become visible
in the Owner's page within the existing 15-second wait. Retained worker logs show
that message was saved and processed. The reason it stayed absent from the page
was not established here. Run 3 stopped earlier: provider creation returned HTTP
503, then the lookup of that command's result returned 404. Neither attempt removed
a person. Their removal hops stay NOT RUN; neither failure was retried or hidden.

An earlier preparation attempt, `nightly-20261022T072329-d78c76d3-c268-4633-bef1-d25ff743b3a1`,
used `385cc6489920ca63f8c7b319749be072efdb839f` from 07:23:29 to 07:28:52 UTC.
It was deliberately stopped before the group checks to correct when API reads start.
Its nightly command returned FAIL after interruption; every removal hop is NOT RUN.
It is separate from the three consecutive commands above.

PASS: failing-first test commits `1fdfb5165` and `81deb1123`; ten focused tests twice;
438 event-security tests once with the requested `PG_TEST_URL`; workspace typecheck;
focused infra typecheck; lint; event catalogue (149 types); knip; changelog check.
The fake clock distinguishes a 500 ms page clear from a 2,400 ms Owner list update,
requires the next API read to follow acceptance, and fails a 2,001 ms page clear.
A delayed-observer mutation also failed, reporting 1,100 ms instead of 500 ms.
All tests, lint and typechecks ran under `nice -n 10`. The full local root suite is NOT RUN.
An additional broad infra typecheck found existing errors in `mcp-journey.ts`,
`wake-latency.ts` and `zitadel-setup.test.ts`; that extra check is FAIL. The required
workspace and focused checks are PASS. The authority tests and event-security test
were left unchanged.

Sanitised receipts and run records are retained outside the repository in
`~/.opencrane/group-removal-timing/2026-10-22/`. Failed attempts also retain sanitised
logs and pictures in their matching `~/.opencrane/daily-fresh/<attempt>/` folders.
GitHub CI is reported separately on the draft PR's final pushed head.
