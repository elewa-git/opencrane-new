# Final demo rehearsal, 23 October 2026

**FAIL: the browser checker stopped at the Models page. No owner refresh commit is qualified.**
This is the final rehearsal attempt for #569. It does not establish a product defect.
The picture shows “Model answered” and no key value, but the checker returned `Error`.
Its error message was not retained. Source inspection found that its unscoped `main`
locator matches both the organisation shell and the Models page. This is the likely
cause, not a confirmed live error diagnosis. The orchestrator owns the next correction.

## Source and environment

Pinned source: `f377da0af2c0b01d92f23783d2ba4728ef57d175`, the starting `origin/main`.
It includes `53e6326a6`. All live work used this commit without product changes.
The branch is `work/demo-final-rehearsal`. `npm ci` passed; `.tools/nats-server`
and `.tools/lychee` point to the requested tools in the main checkout.

`claim.sh` returned secondary slot 1. Fresh startup ran from 01:09:12 to 01:17:29 UTC,
then the timed smoke and the ten-step script ran on `http://127.0.0.1:25106`.
Chromium used separate owner/member profiles. The computer image was
`sha256:40e715076ce0c19f0610b0fbe7872112c971d50a444487126f4465b3d8d4c3f0`.
[Image records](images.txt) and [machine-readable results](results.json) retain the details.

The startup command was `infra/dev-stack/demo-up.sh`, with `DEV_STACK_ID=1`,
`DEMO_ALLOWANCE_CENTS=1000` and `P4_JOURNEY_ATTEMPT=demo-final-rehearsal-20261023`.
`ZITADEL_KEY_FILE` and `DEV_REAL_PROVIDER_FILE` contained only the supplied private paths.
The scripts received those paths; no operator command read or printed either key file.
The launcher set the computer idle period to four hours.

## Completed startup and smoke

Fresh startup, seed, real streamed replies, reload, Stop, supplier answer, replay,
sign-in and sign-out: **PASS**. All eight group-chat checks: **PASS**.
Website readiness took 54,256 ms. The separate startup receipt does not prove
shared-assistant disk isolation; that remains **NOT RUN** for this task.

The smoke command was `node --experimental-strip-types infra/dev-stack/demo-smoke-run.ts`,
with `DEV_STACK_ID=1` and `DEMO_ALLOWANCE_CENTS=970`. A private screenshot helper
masked email addresses, password inputs and invitation links at capture time.
Warm-up passed in 22,646 ms. Both widths finished inside three minutes.

| Smoke check | 1280px | 390px |
| --- | --- | --- |
| Stream and reload | PASS, 9,247 ms | PASS, 11,224 ms |
| PDF answer, preview and download | PASS, 11,076 ms | PASS, 12,090 ms |
| Stop and reload | PASS, 11,047 ms | PASS, 13,100 ms |
| Live member-to-owner message | PASS, 6,039 ms | PASS, 7,073 ms |
| Private shared-assistant reply | PASS, 10,900 ms | PASS, 13,984 ms |
| Company refusal and restored limits | PASS, 14,553 ms | PASS, 10,445 ms |
| Whole timed smoke | PASS, 62,862 ms | PASS, 67,916 ms |

Phone-width smoke pictures: [stream](smoke-streaming-owner-390.png),
[PDF](smoke-pdf-390.png), [Stop](smoke-stop-390.png),
[live message](smoke-direct-member-390.png), [shared reply](smoke-shared-member-390.png)
and [refusal](smoke-limit-member-390.png). These do not replace the separate script below.

## Ten-step script

The script stopped at its first recorded failure. All later steps are **NOT RUN**.
Times cover the completed attempt for each step, including its picture.
The 390px member check in step 5 ran while the owner window was 1280px wide.

| Step | 1280px result and time | 390px script result | Picture |
| --- | --- | --- | --- |
| 1. Stream and reload | PASS, 12,135 ms | NOT RUN | [Reply](01-streamedReply-1280.png) |
| 2. Scanned quote, total/date, preview/download | PASS, 28,391 ms | NOT RUN | [Upload](02-upload-ready-1280.png), [answer](02-scannedPdf-1280.png), [preview](02-preview-download-1280.png) |
| 3. Action history | PASS, 935 ms | NOT RUN | [History](03-actionHistory-1280.png) |
| 4. Stop, partial text and reload | PASS, 12,620 ms | NOT RUN | [Stopped reply](04-stoppedReply-1280.png) |
| 5. Live member-to-owner message at 390px | PASS, 7,175 ms | NOT RUN | [Member](05-member-phone-1280.png), [owner](05-liveMessage-1280.png) |
| 6. Private shared-assistant reply | PASS, 13,407 ms | NOT RUN | [Private reply](06-private-shared-reply-1280.png) |
| 7. Group chat and unopened invite | PASS, 12,689 ms | NOT RUN | [Chat](07-group-chat-1280.png), [group](07-group-1280.png), [invite](07-unopened-invite-1280.png) |
| 8. Model answered, key hidden | FAIL, 1,246 ms; checker error | NOT RUN | [Models at failure](08-failure-owner-1280.png) |
| 9. Company refusal and restore | NOT RUN | NOT RUN | No script picture |
| 10. Limit and group change history | NOT RUN | NOT RUN | No script picture |

Before step 7 completed, the temporary checker was interrupted twice to correct its
recipient-picker assumptions. Both interrupted attempts are **PARTIAL**. Groups do not have the direct-chat “Use selection” button.
Its history event check was also corrected from `group.*` to `team.*` before that step ran.
The first six desktop results were retained. No paid calls were repeated during either
interruption. Step 7 then passed; step 8 failed. No further live qualification was attempted.
Private operator scripts and original receipts remain in `/tmp/demo-final-rehearsal-evidence/`.
Their hashes are in `results.json`. No product fix is included here.

## Spending and cleanup

All amounts are integer euro cents. Unresolved Stop reservations still count as spent allowance.

| Work | Charged | Held | Total |
| --- | --- | --- | --- |
| Fresh startup, including provider verification | 13 | 17 | 30 |
| Warm-up and both smoke widths | 16 | 35 | 51 |
| Separate script through its failure | 9 | 17 | 26 |
| Whole task | **38** | **69** | **107 of 1,000** |

The final authenticated budget read confirmed 38 charged and 69 reserved cents.
Both original company ceilings were restored to 1,000 cents. There were 20 reservations.
Receipts and pictures were copied before `infra/dev-stack/down.sh --id 1` ran.
Cleanup: **PASS**; slot directory, Compose containers and computer namespace were removed.
The owner stack, port 44200, its processes and data were not used.

Published pictures mask email addresses, password fields and the invitation link.
[Picture hashes](pictures.sha256) identify the retained files. The invite was never opened.
Owner refresh, laptop tunnel, physical phone and Safari: **NOT RUN**.
Source validation is recorded in [checks.md](checks.md). No full root test suite ran.
