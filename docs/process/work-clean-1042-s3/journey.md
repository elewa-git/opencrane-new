# Fresh-stack CORE journey

Journey on a fresh dev stack: FAIL

- Date: 18 November 2026.
- Tested source head: `684abe5fba4b22caaa0bbdc5b86398c62d7c04c9`.
- Fresh secondary slot: 1, with managed calls enabled through the stand-in provider.
- `infra/dev-stack/up.sh --fresh`: FAIL, exit 1 during the browser journey.
- Website readiness: PASS, 37,457 ms.
- `infra/dev-stack/down.sh`: PASS; final slot status was `free`.
- Copied 18 sanitised startup/service logs and 14 screenshots before teardown.
  The complete sanitised logs are retained privately. All published captures were
  visually inspected. The shared live-view evidence folder was restored afterwards.

## Steps and results

1. PASS: sign in through the browser at 390 px and 1280 px, send a message, wait for
   completion, reload it, then Stop another reply and retain its partial text.
2. PASS: at both widths, upload a PDF, wait for readiness, ask about its contents,
   read the Willow-47 answer and open its preview.
3. PASS: complete the 390 px attachment steps, open the live computer view and
   observe access loss clear the viewer.
4. FAIL: at 1280 px, the image attachment reply showed “Reply failed” and retained
   partial text. The unchanged runner waited 120 seconds for the third upload-chat
   reply's “Done” marker in `sendUploadedMessage`, then failed.
5. NOT RUN: the 1280 px live-view step, later CORE steps and the additional
   organisation-refusal captures. Startup failed before the capture script ran.

The browser reported `net::ERR_FAILED` and four `net::ERR_ABORTED` transport
failures. Their relationship to the failed reply is unproved. No product source,
journey timeout or runner was changed. This run does not qualify the slice for merge.

[Sanitised failure diagnostic](core-failure.txt).

## Captures

- [Failed image attachment reply at 1280 px](chat-failure.png)
- [Workspace at 390 px](workspace-390.png)
- [Workspace at 1280 px](workspace-1280.png)
- [PDF preparing at 390 px](upload-preparing-390.png)
- [PDF preparing at 1280 px](upload-preparing-1280.png)
- [PDF ready at 390 px](upload-ready-390.png)
- [PDF ready at 1280 px](upload-ready-1280.png)
- [Completed PDF reply at 390 px](upload-390.png)
- [Completed PDF reply at 1280 px](upload-1280.png)
- [PDF preview at 390 px](preview-390.png)
- [PDF preview at 1280 px](preview-1280.png)
- [Computer-view entry at 390 px](conversation-entry-390.png)
- [Live computer view at 390 px](conversation-viewer-390.png)
- [Viewer access loss at 390 px](conversation-revoked-390.png)
