# Fresh CORE journey

Journey on a fresh dev stack: PASS

Tested source head: `168fd08ec3be6807a289a3106e6b5a667b804454`.
The fresh secondary stack used slot 1. Its website origin was the slot's loopback
address. Playwright ran against that origin at 1280 × 900 and 390 × 844 px.

## Steps observed

1. Checked both secondary slots and package activity every 30 seconds. Both slots
   stayed free, no package stack ran, and one-minute load stayed below 6 for 317
   seconds before claiming slot 1. The [load samples](load-wait.jsonl) record the
   complete window.
2. Ran `up.sh --fresh`. It exited 0 after the built-in CORE journey. Real browser
   sign-in, chat, upload, file preview, desktop viewing and refusals ran at both
   widths. The live viewer displayed decoded desktop pixels. A missing desktop
   grant refused the viewer, and revoking access removed its pixels.
3. Ran `status.sh` in the claimed slot; it exited 0. In separate fresh Playwright
   browser contexts at both widths, sent a view admission request with no
   application cookie. Each returned HTTP 403 with only `status: refused` and an
   `attemptId`. The [browser result](anonymous-browser.json) records both widths.
   The event-store global-head assertion for this refusal is covered by the
   [source test](../../../apps/server/test/live-view-anonymous.test.ts).
4. Copied all 37 journey screenshots and 16 filtered service logs before
   teardown. The [capture manifest](capture.json) lists each screenshot and its
   SHA-256 digest. [Startup checks](startup.log), [status result](status.log) and
   the [service-log index](service-logs.json) are retained. Service log copies
   contain only timestamps, levels, operation names and numeric status fields.
   The committed logs retain the first 20 and last 200 safe records per service;
   complete filtered copies were kept before teardown.
5. Ran `down.sh`; it exited 0. Both secondary slots then reported free.

## Screenshots

| Scene | 1280 px | 390 px |
| --- | --- | --- |
| Workspace | [View](screenshots/slot/workspace-1280.png) | [View](screenshots/slot/workspace-390.png) |
| File preview | [View](screenshots/slot/preview-1280.png) | [View](screenshots/slot/preview-390.png) |
| View entry | [View](screenshots/live-view/conversation-entry-1280.png) | [View](screenshots/live-view/conversation-entry-390.png) |
| Visible desktop | [View](screenshots/live-view/conversation-viewer-1280.png) | [View](screenshots/live-view/conversation-viewer-390.png) |
| Access revoked | [View](screenshots/live-view/conversation-revoked-1280.png) | [View](screenshots/live-view/conversation-revoked-390.png) |

The capture manifest also lists the upload, budget-refusal and history screenshots.
The screenshot files were copied before the slot was removed.
