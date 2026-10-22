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
