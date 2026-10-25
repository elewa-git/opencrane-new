# Final demo rehearsal, attempt 3

**FAIL. No source is qualified for the owner refresh.** Fresh startup and the desktop
smoke passed. The phone-width smoke failed at Stop. No paid turn was retried and the
separate ten-step script was not started. This is evidence for board card #569.

## Source and setup

Pinned `origin/main`: **`62c404b3a072dfe9c0e3fe838f5d4ffd3860641e`**.
This includes the required fixes through `53e6326a6` and the repeated-width checker
correction in #608. The source was not changed or updated during the live run.
The worktree was `<worktree>`, branch
`work/demo-final-rehearsal-3`. `npm ci` passed on Node 22.23.3. Both requested tool
symlinks pointed to the existing NATS and Lychee binaries.

`infra/dev-stack/claim.sh` claimed secondary slot 1. Fresh startup ran from
05:43:33 to 05:52:55 UTC on 23 October 2026: 562 seconds including seed preparation.
`infra/dev-stack/demo-up.sh` used `DEV_STACK_ID=1`, `DEMO_ALLOWANCE_CENTS=1000`
and `P4_JOURNEY_ATTEMPT=demo-final-rehearsal-3-20261023`.
The launcher set the computer idle period to four hours.
`ZITADEL_KEY_FILE` and `DEV_REAL_PROVIDER_FILE` were the supplied private file paths.
No operator command read or printed either credential file.

The browser origin was `http://127.0.0.1:25106`. Separate Chromium profiles signed in
as owner and member. [Computer image records](images.txt) identify the running image:
`sha256:40e715076ce0c19f0610b0fbe7872112c971d50a444487126f4465b3d8d4c3f0`.

## Startup and smoke

Fresh startup and seed: **PASS**. Website readiness took 70,403 ms. Startup's real
streaming/reload, Stop/reload, member reply and supplier total/date checks all passed.
Its group journey passed all 26 assertions in 139,263 ms, including eight group-chat
checks. Both projection replay checks, sign-out and loopback listener checks passed.
That group receipt does not prove shared-assistant disk isolation. Its paid-provider
check is marked NOT RUN; the separate real-reply journey supplies the paid evidence.

The smoke used `node --import ./.tools/rehearsal-redaction.mjs
--experimental-strip-types infra/dev-stack/demo-smoke-run.ts`, with `DEV_STACK_ID=1`
and `DEMO_ALLOWANCE_CENTS=971`. This deducted startup's 29 charged or held cents.
The temporary import only masked pictures; it did not change checks or retry turns.
Warm-up passed in 25,398 ms, outside the timed smoke.
[Machine-readable timings](smoke-timings.json) keep every result.

| Smoke check | 1280px | 390px |
| --- | --- | --- |
| Stream and reload | PASS, 12,245 ms | PASS, 10,633 ms |
| PDF total/date, preview and matching download | PASS, 11,886 ms | PASS, 10,830 ms |
| Stop and reload | PASS, 13,030 ms | **FAIL, 158,723 ms** |
| Live member-to-owner message | PASS, 8,957 ms | NOT RUN |
| Private shared-assistant reply | PASS, 9,906 ms | NOT RUN |
| Company refusal and restored limits | PASS, 11,297 ms | NOT RUN |
| Whole timed smoke | PASS, 67,321 ms | **FAIL, 180,186 ms** |

Desktop pictures: [reply](smoke-streaming-owner-1280.png), [PDF](smoke-pdf-1280.png),
[Stop](smoke-stop-1280.png), [live message](smoke-direct-owner-1280.png),
[private reply](smoke-shared-member-1280.png), [refusal](smoke-limit-member-1280.png).
Phone pictures: [reply](smoke-streaming-owner-390.png), [PDF](smoke-pdf-390.png).
The member sends at 390px even during the desktop smoke.

## Observed failure

The phone Stop step used the remaining smoke time and failed at the three-minute
deadline. The checker closes its pages at that deadline; it saved no picture of the
failed step and records no underlying error. The cause remains unproved.

At 06:01:26 UTC, a separate read-only browser visit opened the same personal chat.
No message was submitted. The latest reply showed “Reply failed” and “Reply did not
complete · partial reply kept”, with 175 characters retained and no Stop button.
It did not show “Stopped · partial reply kept”. The
[picture after the timeout](after-timeout-390.png) and [observation](after-timeout.json)
record this later state; they do not establish the exact state at the deadline.
The desktop Stop and earlier startup Stop passes do not make this failure a pass.

## Separate ten-step script

The failure stopped qualification before this script. No script timings or pictures
exist. The [script results](script-results.json) explicitly record all twenty checks.

| Step | 1280px | 390px |
| --- | --- | --- |
| 1. Streamed reply and reload | NOT RUN | NOT RUN |
| 2. Scanned PDF total/date, preview and download | NOT RUN | NOT RUN |
| 3. Action history | NOT RUN | NOT RUN |
| 4. Stop with partial text kept after reload | NOT RUN | NOT RUN |
| 5. Live member-to-owner message at 390px | NOT RUN | NOT RUN |
| 6. Private shared-assistant reply | NOT RUN | NOT RUN |
| 7. Group chat and unopened invitation | NOT RUN | NOT RUN |
| 8. Model answered with the key hidden | NOT RUN | NOT RUN |
| 9. Company ceiling refusal and restoration | NOT RUN | NOT RUN |
| 10. Limit and group change history | NOT RUN | NOT RUN |

## Spending and cleanup

All amounts are integer euro cents. Uncertain holds count against the allowance.
[Spending records](spending.json) retain the totals and restored limits.

| Work | Charged | Held | Total |
| --- | --- | --- | --- |
| Startup, including provider verification | 13 | 16 | 29 |
| Warm-up and smoke through the failure | 13 | 35 | 48 |
| Whole task | **26** | **51** | **77 of 1,000** |

The final authenticated budget read and the later budget-event read agreed.
Both original company ceilings were restored to 1,000 cents. No saved restoration
file remained. The read-only visit made no paid call.

Receipts and pictures were copied before `infra/dev-stack/down.sh --id 1` ran.
Cleanup: **PASS**, exit 0. The slot directory, Compose containers and both computer
and gateway namespaces were absent afterwards. The owner stack, port 44200, its
processes and data were not used.

Published pictures mask email addresses, password fields, invitation links and
provider-key patterns at capture time. [Picture hashes](pictures.sha256) identify
all 20 retained pictures. Private original records and operator helpers are retained
under `/tmp/demo-final-rehearsal-3-evidence/` on the rehearsal host.
Owner refresh, laptop tunnel, physical phone and Safari: **NOT RUN**.
[Source checks](checks.md) are separate from the failed live result.
