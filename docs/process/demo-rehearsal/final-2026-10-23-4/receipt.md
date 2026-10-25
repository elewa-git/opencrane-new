# Final demo rehearsal, fourth attempt, 23 October 2026

**FAIL: the desktop shared-assistant check did not observe streaming.**
No source is qualified for the owner refresh. This is the fourth attempt for #569.
Fresh startup, both timed smoke widths and desktop script steps 1–5 passed.
Desktop step 6 failed; steps 7–10 and all ten phone script steps are **NOT RUN**.
The checker and product were not changed or retried. The orchestrator owns the follow-up.

The [member's failure picture](06-failure-member-1280.png) shows the private assistant's
answer, “The capital of France is Paris”, with Done. The checker nevertheless timed
out after 120,000 ms waiting for `locator('.caret')` to become visible. It did not
reach its answer and reload assertions. The visible answer does not turn that failed
step into a pass. The cause of the missed streaming indicator is unproved; this
receipt does not establish a failed model reply.

## Source and fresh installation

Pinned source: `fe606c2fcb678bbfe5f424d8a8d3af8fb877611a`, the starting `origin/main`.
It includes `53e6326a6`, the earlier checker corrections and the Stop correction
merged in #611. Every live check used that commit. The worktree is
`<worktree>`, branch `work/demo-final-rehearsal-4`.
`npm ci` passed. Both requested tools were symlinked from the main checkout's `.tools/`.
No application, checker, event, dependency or protected test changed.

`claim.sh` returned secondary slot 1. `demo-up.sh` ran fresh from 08:31:00 to
08:39:35 UTC with `DEV_STACK_ID=1`, `DEMO_ALLOWANCE_CENTS=1000` and
`P4_JOURNEY_ATTEMPT=demo-final-rehearsal-4-20261023`. The supplied Zitadel and OpenAI
credential paths were passed as `ZITADEL_KEY_FILE` and `DEV_REAL_PROVIDER_FILE`.
No operator command read or printed either credential file. The launcher set the
computer idle period to four hours. The origin was `http://127.0.0.1:25106`.
Owner and member used separate Chromium profiles.

The running computer image was
`sha256:ddbd61e7b3efd8d78a46e53611e332a11cfe110d844a6bd5a277f9bd3a8b6e21`,
the corrected image recorded by #611. [Image records](images.txt) retain each computer.
[Startup checks](startup-checks.txt) passed, including real streamed replies, reload,
Stop, the supplier answer, all eight group-chat checks, replay and sign-out.
Website readiness took 43,307 ms; the groups and chat journey took 134,834 ms.
Shared-assistant computer-disk isolation remains **NOT RUN** for this task.

## Timed smoke

`demo-smoke-run.ts` ran once from 08:39:56 to 08:45:26 UTC with
`DEMO_ALLOWANCE_CENTS=970`. This conservative company ceiling included the existing
30 cents of startup charges and holds and stayed below the 1,000-cent task cap.
Warm-up passed in 30,146 ms. Both timed widths finished within three minutes.
The original daily and monthly company ceilings were restored to 1,000 cents.

| Smoke check | 1280px | 390px |
| --- | --- | --- |
| Stream and reload | [PASS, 36,675 ms](smoke-streaming-owner-1280.png) | [PASS, 18,210 ms](smoke-streaming-owner-390.png) |
| PDF answer, preview and download | [PASS, 12,898 ms](smoke-pdf-1280.png) | [PASS, 13,663 ms](smoke-pdf-390.png) |
| Stop and reload | [PASS, 20,002 ms](smoke-stop-1280.png) | [PASS, 16,087 ms](smoke-stop-390.png) |
| Live member-to-owner message | [PASS, 9,556 ms](smoke-direct-member-1280.png) | [PASS, 7,996 ms](smoke-direct-member-390.png) |
| Private shared-assistant reply | [PASS, 13,482 ms](smoke-shared-member-1280.png) | [PASS, 15,970 ms](smoke-shared-member-390.png) |
| Company refusal and restored limits | [PASS, 13,117 ms](smoke-limit-member-1280.png) | [PASS, 16,266 ms](smoke-limit-member-390.png) |
| Whole timed smoke | PASS, 105,732 ms | PASS, 88,192 ms |

[Machine-readable timings](smoke-timings.json) record every smoke step.

## Ten-step script

`demo-rehearsal-run.ts` ran once from 08:45:56 to 08:50:11 UTC, with
`DEMO_ALLOWANCE_CENTS=1000`. Before each paid turn it checked company charges,
unresolved holds and a further 100 cents against the whole-task allowance.
Step times include pictures. [Results](results.json) retain every outcome and the
failure message. Step 5 used the member's 390px window during the desktop pass.

| Step | 1280px result and time | 390px result |
| --- | --- | --- |
| 1. Stream and reload | [PASS, 15,615 ms](01-streamedReply-1280.png) | NOT RUN |
| 2. Scanned quote, total/date, preview/download | [PASS, 32,817 ms](02-scannedPdf-1280.png) | NOT RUN |
| 3. Action history | [PASS, 1,355 ms](03-actionHistory-1280.png) | NOT RUN |
| 4. Stop, partial text and reload | [PASS, 10,558 ms](04-stoppedReply-1280.png) | NOT RUN |
| 5. Live member-to-owner message | [PASS, 7,670 ms](05-liveMessage-1280.png) | NOT RUN |
| 6. Private shared-assistant reply | [FAIL, 124,983 ms](06-failure-member-1280.png) | NOT RUN |
| 7. Group chat and unopened invite | NOT RUN | NOT RUN |
| 8. Model answered, key hidden | NOT RUN | NOT RUN |
| 9. Company refusal and restore | NOT RUN | NOT RUN |
| 10. Limit and group change history | NOT RUN | NOT RUN |

Supporting pictures show the [ready upload](02-upload-ready-1280.png),
[PDF preview and download](02-preview-download-1280.png),
[phone sender](05-member-phone-1280.png) and [owner at failure](06-failure-owner-1280.png).
The earlier smoke passes do not fill the unrun script rows.

## Spending, privacy and cleanup

All amounts are integer euro cents. Unresolved reservations count in full.
[Spending records](spending.json) include all 20 reservations. The final budget events
and the checker's authenticated budget read agreed on charges, holds and both limits.

| Work | Charged | Held | Total |
| --- | --- | --- | --- |
| Fresh startup, including provider verification | 13 | 17 | 30 |
| Warm-up and both smoke widths | 16 | 35 | 51 |
| Separate script through its failure | 9 | 17 | 26 |
| Whole task | **38** | **69** | **107 of 1,000** |

Both company ceilings were 1,000 cents at cleanup. No saved restoration remained.
Receipts and pictures were copied before `down.sh --id 1` ran from 08:50:58 to
08:51:37 UTC. Cleanup: **PASS**. The slot directory, its Compose containers and both
computer namespaces were absent afterwards. The owner stack and port 44200 were not used.

All 26 published pictures mask email text, password/email fields, invitation links
and provider-key patterns at capture time. An ignored local Node preload added these
masks to screenshot calls; it changed no application code or checker assertions.
[Picture hashes](pictures.sha256) identify the saved files. No invitation link was opened.
Original private records remain in `/tmp/demo-final-rehearsal-4-evidence/`.
Owner refresh, laptop tunnel, physical phone and Safari: **NOT RUN**.
[Source checks](checks.md) are separate from this failed live qualification.
