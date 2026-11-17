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
