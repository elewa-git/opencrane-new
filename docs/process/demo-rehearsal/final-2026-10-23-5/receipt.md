# Final demo rehearsal, fifth attempt, 23 October 2026

**PASS: fresh startup, both timed smoke widths and all twenty script checks.**
The qualified owner-refresh source is `f11df5c56fe08e4bac477cc4c3f375288568c0cd`.
This is the fifth attempt for #569. The smoke and ten-step script each ran once.
No step failed, so the authorised script-only retry was not needed.
The owner refresh itself remains **NOT RUN**.

## Source and fresh installation

The pinned source was the starting `origin/main`. It includes `53e6326a6`, the Stop
correction in #611 and the checker-3 correction in #615. Every live check used that
commit. The worktree is `/home/jente/dev/wt/demo-final-rehearsal-5`, on branch
`work/demo-final-rehearsal-5`. `npm ci` passed. Both requested tools were symlinked
from the main checkout's `.tools/`. No product, checker, event, dependency or protected
test changed. The documentation commit is a receipt for this source, not a new live-tested source.

`claim.sh` returned secondary slot 1. `demo-up.sh` ran fresh from 12:30:55 to
12:39:38 UTC with `DEV_STACK_ID=1`, `DEMO_ALLOWANCE_CENTS=1000` and
`P4_JOURNEY_ATTEMPT=demo-final-rehearsal-5-20261023`. The supplied credential paths
were passed as `ZITADEL_KEY_FILE` and `DEV_REAL_PROVIDER_FILE`. No operator command
read or printed either credential file. The launcher set the computer idle period
to four hours. The origin was `http://127.0.0.1:25106`. Owner and member used separate
Chromium profiles. The owner stack and port 44200 were not used.

The running computer image was
`sha256:ddbd61e7b3efd8d78a46e53611e332a11cfe110d844a6bd5a277f9bd3a8b6e21`.
[Image records](images.txt) retain each computer. [Startup checks](startup-checks.txt)
passed, including real streamed replies, reload, Stop, the supplier answer, replay
and sign-out. Website readiness took 41,257 ms. The
[group and chat checks](startup-groups.json) took 137,670 ms and passed all eight
group-chat assertions. That group's paid-model placeholder does not describe the
separate real-model checks, which passed. Computer-disk isolation remains **NOT RUN**.

## Timed smoke

`demo-smoke-run.ts` ran once from 12:40:01 to 12:44:48 UTC with
`DEMO_ALLOWANCE_CENTS=971`. This conservative company ceiling included the existing
29 cents of startup charges and holds and stayed below the 1,000-cent task cap.
Warm-up passed in 26,111 ms. Both timed widths finished within three minutes.
Both original company ceilings were restored to 1,000 cents.

| Smoke check | 1280px | 390px |
| --- | --- | --- |
| Stream and reload | [PASS, 13,064 ms](smoke-streaming-owner-1280.png) | [PASS, 17,821 ms](smoke-streaming-owner-390.png) |
| PDF answer, preview and download | [PASS, 18,956 ms](smoke-pdf-1280.png) | [PASS, 15,203 ms](smoke-pdf-390.png) |
| Stop and reload | [PASS, 12,627 ms](smoke-stop-1280.png) | [PASS, 18,419 ms](smoke-stop-390.png) |
| Live member-to-owner message | [PASS, 10,401 ms](smoke-direct-member-1280.png) | [PASS, 9,209 ms](smoke-direct-member-390.png) |
| Private shared-assistant reply | [PASS, 13,516 ms](smoke-shared-member-1280.png) | [PASS, 20,329 ms](smoke-shared-member-390.png) |
| Company refusal and restored limits | [PASS, 12,928 ms](smoke-limit-member-1280.png) | [PASS, 11,571 ms](smoke-limit-member-390.png) |
| Whole timed smoke | PASS, 81,492 ms | PASS, 92,552 ms |

[Machine-readable timings](smoke-timings.json) record every smoke step.

## Ten-step script

`demo-rehearsal-run.ts` ran once from 12:45:06 to 12:50:17 UTC with
`DEMO_ALLOWANCE_CENTS=1000`. Before each paid turn it checked company charges,
unresolved holds and a further 100 cents against that allowance. Step times include
pictures. Step 5 sent from a 390px member window in both passes. Invitation links
were created for display and never opened. [Results](results.json) list all twenty
outcomes and every supporting picture, including previews and both history entries.

| Step | 1280px result and time | 390px result and time |
| --- | --- | --- |
| 1. Stream and reload | [PASS, 12,119 ms](01-streamedReply-1280.png) | [PASS, 13,176 ms](01-streamedReply-390.png) |
| 2. Scanned quote, total/date, preview/download | [PASS, 38,398 ms](02-scannedPdf-1280.png) | [PASS, 35,765 ms](02-scannedPdf-390.png) |
| 3. Action history | [PASS, 1,679 ms](03-actionHistory-1280.png) | [PASS, 1,514 ms](03-actionHistory-390.png) |
| 4. Stop, partial text and reload | [PASS, 14,286 ms](04-stoppedReply-1280.png) | [PASS, 14,408 ms](04-stoppedReply-390.png) |
| 5. Live member-to-owner message | [PASS, 10,522 ms](05-liveMessage-1280.png) | [PASS, 7,775 ms](05-liveMessage-390.png) |
| 6. Private shared-assistant reply | [PASS, 18,100 ms](06-private-shared-reply-1280.png) | [PASS, 15,845 ms](06-private-shared-reply-390.png) |
| 7. Group chat and unopened invite | [PASS, 12,190 ms](07-groupAndInvite-1280.png) | [PASS, 11,161 ms](07-groupAndInvite-390.png) |
| 8. Model answered, key hidden | [PASS, 1,372 ms](08-providerAnswer-1280.png) | [PASS, 990 ms](08-providerAnswer-390.png) |
| 9. Company refusal and restore | [PASS, 16,923 ms](09-member-refusal-1280.png) | [PASS, 15,983 ms](09-member-refusal-390.png) |
| 10. Limit and group change history | [PASS, 3,571 ms](10-changeHistory-1280.png) | [PASS, 2,430 ms](10-changeHistory-390.png) |

The shared-answer pictures show the member's private reply at
[1280px](06-private-shared-reply-1280.png) and [390px](06-private-shared-reply-390.png).
The phone sender is shown at [desktop pass](05-member-phone-1280.png) and
[phone pass](05-member-phone-390.png). Step 7 also checks the group chat's message
and fixed group mode. Step 9 checks refusal before and after reload, unchanged
charges and holds, then confirms restoration of both saved limits.

## Spending, privacy and cleanup

All amounts are integer euro cents. Unresolved reservations count in full.
[Spending records](spending.json) include all 24 reservations and the observations
after startup, smoke and script. The final budget-event read and the script's
separate authenticated budget read agreed on charges, holds and both limits.

| Work | Charged | Held | Total |
| --- | --- | --- | --- |
| Fresh startup, including provider verification | 13 | 16 | 29 |
| Warm-up and both smoke widths | 16 | 35 | 51 |
| Ten-step script at both widths | 18 | 34 | 52 |
| Whole task | **47** | **85** | **132 of 1,000** |

Both company ceilings were 1,000 cents at cleanup. No saved restoration remained.
Receipts and pictures were copied before `down.sh --id 1` ran from 12:50:41 to
12:51:36 UTC. Cleanup: **PASS**. The slot directory, its Compose containers and both
computer namespaces were absent afterwards. No further paid call was made.

All 68 published pictures mask email text, password/email fields, invitation links
and provider-key patterns at capture time. An ignored local Node preload added these
masks to screenshot calls; it changed no product code or checker assertions.
[Picture hashes](pictures.sha256) identify the saved files. Original private records
remain in `/tmp/demo-final-rehearsal-5-evidence/`. Earlier failures remain in their
original receipts; this pass does not rewrite them.

Owner refresh, laptop tunnel, physical phone, Safari and shared-assistant computer-disk
isolation: **NOT RUN**. [Source checks](checks.md) record the separate local validation.
