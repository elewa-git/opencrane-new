# Final demo rehearsal, second attempt, 23 October 2026

**FAIL: the phone-width checker reused an existing invitation's email address.**
No owner refresh commit is qualified. This is the second final rehearsal for #569.
Fresh startup, both timed smoke widths and all ten desktop steps passed. Phone steps
1–6 passed. Step 7 failed, and steps 8–10 are **NOT RUN**.

The [failure picture](07-failure-owner-390.png) says: “This email already has an
invitation. Renewing it isn't available yet. Nothing was created.” The checker uses
`rehearsal@example.invalid` at both widths. The desktop invitation succeeded; the
phone attempt was refused. The checker then timed out after 120,000 ms waiting for
“Link created. No email was sent.” No product defect is established by this refusal.
The checker was not changed or retried. The orchestrator owns the next correction.

## Source and environment

Pinned source: `5bae5bd7163adcea6e2ec2dfde8e7fa7eb5921c4`, the starting `origin/main`.
It contains `53e6326a6` and the merged Models-page checker correction from #606.
All live work used this commit without source changes. The branch is
`work/demo-final-rehearsal-2`. `npm ci` passed. `.tools/nats-server` and `.tools/lychee`
point to the requested tools in the main checkout.

`claim.sh` returned secondary slot 1. Fresh startup ran from 03:44:58 to 03:57:36 UTC
on `http://127.0.0.1:25106`. Chromium used separate owner/member profiles. The computer
image was `sha256:40e715076ce0c19f0610b0fbe7872112c971d50a444487126f4465b3d8d4c3f0`.
[Image records](images.txt) and [machine-readable results](results.json) retain the details.

Startup used `infra/dev-stack/demo-up.sh`, with `DEV_STACK_ID=1`,
`DEMO_ALLOWANCE_CENTS=1000` and `P4_JOURNEY_ATTEMPT=demo-final-rehearsal-2-20261023`.
`ZITADEL_KEY_FILE` and `DEV_REAL_PROVIDER_FILE` contained only the supplied private paths.
The scripts received those paths; no operator command read or printed either key file.
The launcher set the computer idle period to four hours.

## Completed startup and smoke

Fresh startup, seed, real streamed replies, reload, Stop, supplier answer, replay,
sign-in and sign-out: **PASS**. All eight group-chat checks: **PASS**.
Website readiness took 88,603 ms. Shared-assistant disk isolation remains **NOT RUN**
for this task; a private conversation does not establish separate computer disks.

The smoke used `node --experimental-strip-types infra/dev-stack/demo-smoke-run.ts`,
with `DEV_STACK_ID=1` and `DEMO_ALLOWANCE_CENTS=973`. The initial startup observation
showed 27 charged-plus-held cents. The smoke's starting budget read confirmed 30 cents.
Its 973-cent company ceiling included existing spending and remained below the task cap.
Warm-up passed in 22,530 ms. Both timed widths finished inside three minutes.

| Smoke check | 1280px | 390px |
| --- | --- | --- |
| Stream and reload | PASS, 11,211 ms | PASS, 13,023 ms |
| PDF answer, preview and download | PASS, 13,506 ms | PASS, 13,423 ms |
| Stop and reload | PASS, 15,027 ms | PASS, 14,949 ms |
| Live member-to-owner message | PASS, 9,804 ms | PASS, 8,949 ms |
| Private shared-assistant reply | PASS, 15,937 ms | PASS, 12,588 ms |
| Company refusal and restored limits | PASS, 14,541 ms | PASS, 13,940 ms |
| Whole timed smoke | PASS, 80,026 ms | PASS, 76,871 ms |

Smoke pictures at 1280px: [reply](smoke-streaming-owner-1280.png),
[PDF](smoke-pdf-1280.png), [Stop](smoke-stop-1280.png),
[message](smoke-direct-member-1280.png), [shared reply](smoke-shared-member-1280.png),
[refusal](smoke-limit-member-1280.png). At 390px: [reply](smoke-streaming-owner-390.png),
[PDF](smoke-pdf-390.png), [Stop](smoke-stop-390.png), [message](smoke-direct-member-390.png),
[shared reply](smoke-shared-member-390.png), [refusal](smoke-limit-member-390.png).

## Ten-step script

The retained `infra/dev-stack/demo-rehearsal-run.ts` ran once, from 04:02:32 to
04:09:10 UTC, with `DEV_STACK_ID=1` and `DEMO_ALLOWANCE_CENTS=1000`. Before each paid
turn it checked company charges, unresolved holds and another 100 cents against that
whole-task cap. Times include the step's picture. Step 5 sends from 390px at both widths.

| Step | 1280px result and time | 390px result and time |
| --- | --- | --- |
| 1. Stream and reload | [PASS, 11,802 ms](01-streamedReply-1280.png) | [PASS, 10,425 ms](01-streamedReply-390.png) |
| 2. Scanned quote, total/date, preview/download | [PASS, 36,997 ms](02-scannedPdf-1280.png) | [PASS, 34,244 ms](02-scannedPdf-390.png) |
| 3. Action history | [PASS, 1,541 ms](03-actionHistory-1280.png) | [PASS, 1,192 ms](03-actionHistory-390.png) |
| 4. Stop, partial text and reload | [PASS, 14,864 ms](04-stoppedReply-1280.png) | [PASS, 10,313 ms](04-stoppedReply-390.png) |
| 5. Live member-to-owner message | [PASS, 9,663 ms](05-liveMessage-1280.png) | [PASS, 7,404 ms](05-liveMessage-390.png) |
| 6. Private shared-assistant reply | [PASS, 18,311 ms](06-private-shared-reply-1280.png) | [PASS, 16,386 ms](06-private-shared-reply-390.png) |
| 7. Group chat and unopened invite | [PASS, 10,546 ms](07-unopened-invite-1280.png) | [FAIL, 129,785 ms](07-failure-owner-390.png) |
| 8. Model answered, key hidden | [PASS, 1,501 ms](08-providerAnswer-1280.png) | NOT RUN |
| 9. Company refusal and restore | [PASS, 12,445 ms](09-member-refusal-1280.png) | NOT RUN |
| 10. Limit and group change history | [PASS, 1,788 ms](10-limit-history-1280.png) | NOT RUN |

Supporting pictures show the upload ready at [1280px](02-upload-ready-1280.png) and
[390px](02-upload-ready-390.png), PDF preview/download at [1280px](02-preview-download-1280.png)
and [390px](02-preview-download-390.png), and the phone sender during the
[desktop](05-member-phone-1280.png) and [phone](05-member-phone-390.png) runs.
Group chat and group display completed at both widths before the failed invitation:
[desktop chat](07-group-chat-1280.png), [desktop group](07-group-1280.png),
[phone chat](07-group-chat-390.png), [phone group](07-group-390.png).
The desktop run also captured [restored limits](09-companyLimit-1280.png) and the
[change-history page](10-group-history-1280.png). The history checker found both limit
and group changes in the page text. Its viewport pictures stayed at the top of the
page, so those particular rows are not visible in the pictures.

## Spending and cleanup

All amounts are integer euro cents. Unresolved Stop reservations still count against
the allowance. Final budget events and the authenticated budget read agreed.

| Work | Charged | Held | Total |
| --- | --- | --- | --- |
| Fresh startup, including provider verification | 13 | 17 | 30 |
| Warm-up and both smoke widths | 16 | 35 | 51 |
| Separate script through its failure | 18 | 34 | 52 |
| Whole task | **47** | **86** | **133 of 1,000** |

There were 24 reservations. Both original company ceilings were restored to 1,000 cents.
No saved ceiling restoration remained. Receipts and pictures were copied before
`infra/dev-stack/down.sh --id 1` ran at 04:09:43 UTC. Cleanup: **PASS**, 50,166 ms;
the slot directory, Compose containers and computer namespace were removed.
The owner stack, port 44200, its processes and data were not used.

Published pictures mask email text, password fields, invitation links and provider-key
patterns at capture time. The visible invitation address is a synthetic test fixture.
[Picture hashes](pictures.sha256) identify all 42 retained files. No invite link was opened.
Original private receipts remain in `/tmp/demo-final-rehearsal-2-evidence/`.
Owner refresh, laptop tunnel, physical phone and Safari: **NOT RUN**.
Source validation is recorded in [checks.md](checks.md). No full root suite ran.
