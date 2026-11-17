# Fresh CORE journey

Journey on a fresh dev stack: FAIL

- Date: 17 November 2026.
- Tested head: `d6c3d4ecaa45779618f98f8db91cee9d6de5c489`.
- Fresh secondary slot: 1; managed calls enabled with the free stand-in provider.
- Browser: installed Playwright against the slot origin; real Zitadel sign-in.
- `infra/dev-stack/up.sh --fresh`: FAIL, exit 1 during the browser journey.
- `infra/dev-stack/status.sh`: exit 0 after the failure.
- `infra/dev-stack/down.sh`: PASS, exit 0; final status reports `free`.
- Screenshots and sanitised startup/service logs were copied before teardown.
  Full diagnostics remain in the task's private fleet receipt.

## Observed steps

1. Fresh startup bootstrapped the owner, switched on managed calls and passed
   website readiness in 38,972 ms.
2. The member signed in and reached the workspace at 390 px. The browser uploaded
   the PDF, showed its ready state and opened its preview. The ordered upload
   checks reached the text attachment after the EICAR, unsupported-type and size refusals.
3. After sending `notes.txt`, the agent displayed “Hello from your computer.”,
   then “Reply failed” and “Reply did not complete · partial reply kept”.
   `browser-upload.ts:149` timed out waiting for that reply's “Done” marker.
   The underlying cause is not proved by this run.
4. The 1280 px browser checks and later CORE steps were NOT RUN. The failed
   mobile run does not qualify the journey for merge. Paid-provider and approval
   journeys were NOT RUN.

No journey assertion, timeout or product code was changed. The source gates and
remaining helpers are listed in [the scope receipt](checks.md).

## Screenshots retained before teardown

All captures are from the failed 390 px run:

- [Workspace](screenshots/workspace-390.png)
- [Upload preparing](screenshots/upload-preparing-390.png)
- [Upload ready](screenshots/upload-ready-390.png)
- [Upload](screenshots/upload-390.png)
- [PDF preview](screenshots/preview-390.png)
- [Failed attachment reply](screenshots/chat-failure.png)

## Fresh rerun

Journey on a fresh dev stack: FAIL

- Date: 17 November 2026.
- Tested head: `66305ff418ad16eb177057e4e6a3ce6f66e8825f`.
- Fresh secondary slot: 1; managed calls enabled with the free stand-in provider.
- The 1-minute load average stayed below 6 for five minutes before the stack was claimed.
  It rose to at least 25.56 while the journey was running.
- `infra/dev-stack/up.sh --fresh`: FAIL, exit 1 during the browser journey.
- `infra/dev-stack/down.sh`: PASS; final slot status was `free`.
- Sanitised `server.log`, `computers.log` and failure metadata, plus the available
  390 px captures, are in the private fleet receipt for this rerun.

The browser completed the 390 px workspace, upload, preview and attachment checks,
then failed in the later computer live-view check. The runner timed out waiting for
the fourth agent reply's “Done” marker in `browserLiveViewJourney`. The screenshot
shows the read-only computer view. This differs from the earlier attachment-reply
failure; neither run proves a product defect or qualifies the slice for merge.
The 1280 px checks and later CORE steps were NOT RUN. No passing-run screenshots
were produced. Paid-provider and approval journeys remain NOT RUN.

## Fresh rerun 2

Journey on a fresh dev stack: FAIL

- Date: 17 November 2026.
- Tested head: `90e88b1682a615c3037cbc6d343432867729e4b9`.
- Fresh secondary slot: 1; managed calls enabled with the free stand-in provider.
- Before claiming the slot, the one-minute load stayed below 6 for five minutes.
  Samples at 30-second intervals ranged from 2.08 to 4.67; the five-minute sample
  was 3.41.
- `infra/dev-stack/up.sh --fresh`: FAIL, exit 1 during the browser journey.
- `infra/dev-stack/down.sh --id 1`: PASS; final slot status was `free`.
- Sanitised startup and service logs are in the private rerun receipt. The failure
  capture is [the read-only computer view](screenshots/rerun-2-chat-failure-390.png).

The 390 px workspace, upload, preview and attachment checks completed. The later
computer live-view check timed out after 30 seconds waiting for the fourth agent
reply's “Done” marker. The capture shows the computer view and does not establish
that reply completion passed. The 1280 px checks and later CORE steps were NOT RUN.
The attachment reply did not reproduce its earlier failure in this attempt. This
run does not qualify the slice for merge. Paid-provider and approval journeys remain
NOT RUN.

## Passing run

Journey on a fresh dev stack: PASS

- Date: 17 November 2026.
- Tested head: `a8e7a7ff8f265b8aaabc2c347a88abbb66e70464`.
- Fresh secondary slot: 1; managed calls enabled with the free stand-in provider.
- Before claiming the slot, the 1-minute load average stayed below 6 for five minutes.
  Samples taken about every 30 seconds ranged from 0.43 to 1.17.
- `infra/dev-stack/up.sh --fresh`: PASS; website readiness took 39,488 ms.
- CORE browser checks: PASS at 390 px and 1280 px. Attachment uploads and replies,
  chat completion, the live computer view and the later CORE checks completed.
  One upload transport attempt reported `net::ERR_FAILED`; its retry passed, with
  no duplicate files.
- Organisation sign-in refusal: PASS at 390 px and 1280 px.
- `infra/dev-stack/down.sh --id 1`: PASS; final slot status was `free`.
- Paid-provider and approval journeys remain NOT RUN.

The live-view assistant replies completed at both widths. No reply timed out, so
there is no unfinished fourth reply to diagnose in this run. The captures below
show the completed chat and the organisation refusal at both widths.

### Captures

- [Chat at 1280 px](pass-chat-1280.png)
- [Chat at 390 px](pass-chat-390.png)
- [Organisation refusal at 1280 px](pass-refusal-1280.png)
- [Organisation refusal at 390 px](pass-refusal-390.png)
