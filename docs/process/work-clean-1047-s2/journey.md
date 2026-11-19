# Fresh CORE journey

Journey on a fresh dev stack: PASS

Tested head: `4b88608ec5971ea5d702dd70b57da156fb15dff7`. Used secondary slot 1 with a fresh installation
and the stand-in provider at `http://127.0.0.1:25106`. Ran Playwright from `node_modules`
against the product at 1280 × 900 and 390 × 844, using separate owner and member
browser contexts. Preserved `OPENCRANE_FLEET_TASK`; no guard was bypassed.

Startup began at 2026-11-19T05:52:52.340766+00:00. Teardown finished at 2026-11-19T06:07:41.009905+00:00.

## Before claiming

Both secondary slots were free and no package stack was up. The one-minute load
stayed below six for 30 minutes in the final continuous sampling window. Earlier
high load reset the window. Checked every 30 seconds, then rechecked both slots,
package activity and load immediately before `claim.sh`.
See the [samples](load-wait.jsonl) and [claim checks](claim-gate.json).
All required source qualification completed before startup; the loaded test failures
and their isolated qualification remain explicit in [source checks](checks.md).

## Steps observed

1. Ran `up.sh --fresh` in the claimed slot. Website readiness passed in 45,622 ms.
   Signed in through Zitadel and PKCE. Checked wrong-organisation, expired-session,
   hostile-Origin and missing-Origin refusals without changing the owner stack.
2. At both widths, opened a conversation, sent a message and saw the streamed
   stand-in reply. Reloaded without duplicate replies. Pressed Stop on another
   reply and checked that its partial text survived reload.
3. At both widths, uploaded a PDF and saw the assistant read `Willow-47`.
   Checked an induced upload retry without duplicate files, reload, PDF/text/image
   previews, and EICAR, unsupported-type and oversized-file refusals.
4. At both widths, opened the computer view. Checked refusal without a grant,
   granted access to the real desktop, then revoked it. Pixels cleared and Stop
   was audited in 307 ms at 390 px and 338 ms at 1280 px.
5. Sent another message after suspension and saw the computer wake and reply.
   Checked assistant/computer lifecycle and disk survival after Pod replacement.
6. At both widths, opened action and organisation history. Checked separate allow
   and success rows. Checked refusal of another member's private history for both
   that colleague and the owner, and absence of private canaries from service logs.
7. At both widths, saved group and assistant ceilings through the UI, triggered
   over-ceiling refusals and reloaded. Nothing was repeated. Restored fixture
   ceilings and checked that the fresh migration remained idempotent.
8. Verified member and MCP catalogue replay, token boundaries, sign-out,
   reauthentication and loopback-only listeners. Ran `status.sh`: services and
   required health checks passed.
9. Copied all 37 original screenshots and 31 sanitised logs into this folder
   **before teardown**. Compared each copied screenshot's digest with its source.
   Ran `down.sh` successfully; both secondary slots then reported `free`.

## Results and limits

`up.sh --fresh`, `status.sh` and `down.sh`: PASS, exit 0. The
[run result](run-result.json) records the tested head, capture and teardown times.
The [capture manifest](capture.json) records all screenshot digests. The
[startup and browser assertions](up.log), [status output](status.log) and
[service log index](service-logs.md) are retained. Logs use the repository secret
sanitiser, private-path and email redaction, and removal of trailing whitespace.
Lines the secret sanitiser could not approve are withheld explicitly.

Inspected representative chat, upload, preview, desktop, spending-refusal and
history captures. The originals below are unchanged. Restored only this run's
changes in the shared screenshot folders after preserving these copies.

Approval journey: NOT RUN; the existing runner skips it pending #45 rows 4, 5
and 14. Real-provider, extended phase 4 and standalone release-image qualification:
NOT RUN; outside this CORE journey. CORE uses the repository's tracked computer
image. The current source's new digest entrypoint and report import also passed
in the rebuilt standard CI computer fixture image; see [source checks](checks.md).
The 69 opt-in source-test conditions remain [NOT RUN](skipped-tests.json).
Independent review is reserved for the orchestrator. The worktree remains for review.

## Screenshots copied before teardown

| Scene | 1280 px | 390 px |
| --- | --- | --- |
| Chat after Stop and reload | [View](screenshots/slot/workspace-1280.png) | [View](screenshots/slot/workspace-390.png) |
| Upload preparing | [View](screenshots/slot/upload-preparing-1280.png) | [View](screenshots/slot/upload-preparing-390.png) |
| Upload ready | [View](screenshots/slot/upload-ready-1280.png) | [View](screenshots/slot/upload-ready-390.png) |
| Uploaded PDF reply | [View](screenshots/slot/upload-1280.png) | [View](screenshots/slot/upload-390.png) |
| File preview | [View](screenshots/slot/preview-1280.png) | [View](screenshots/slot/preview-390.png) |
| Computer entry | [View](screenshots/live-view/conversation-entry-1280.png) | [View](screenshots/live-view/conversation-entry-390.png) |
| Computer viewer | [View](screenshots/live-view/conversation-viewer-1280.png) | [View](screenshots/live-view/conversation-viewer-390.png) |
| Computer access revoked | [View](screenshots/live-view/conversation-revoked-1280.png) | [View](screenshots/live-view/conversation-revoked-390.png) |
| Budget chat | [View](screenshots/p3-13-live/fresh-stub-chat-1280.png) | [View](screenshots/p3-13-live/fresh-stub-chat-390.png) |
| Group ceiling editor | [View](screenshots/p3-13-live/fresh-paying_group-1280.png) | [View](screenshots/p3-13-live/fresh-paying_group-390.png) |
| Group ceiling refusal | [View](screenshots/p3-13-live/fresh-paying_group-refusal-1280.png) | [View](screenshots/p3-13-live/fresh-paying_group-refusal-390.png) |
| Assistant ceiling editor | [View](screenshots/p3-13-live/fresh-assistant-1280.png) | [View](screenshots/p3-13-live/fresh-assistant-390.png) |
| Assistant ceiling refusal | [View](screenshots/p3-13-live/fresh-assistant-refusal-1280.png) | [View](screenshots/p3-13-live/fresh-assistant-refusal-390.png) |
| History chat | [View](screenshots/p3-19-live/fresh-stub-chat-1280.png) | [View](screenshots/p3-19-live/fresh-stub-chat-390.png) |
| Action history | [View](screenshots/p3-19-live/fresh-action-1280.png) | [View](screenshots/p3-19-live/fresh-action-390.png) |
| History category | [View](screenshots/p3-19-live/fresh-category-1280.png) | [View](screenshots/p3-19-live/fresh-category-390.png) |
| Organisation history | [View](screenshots/p3-19-live/fresh-change-1280.png) | [View](screenshots/p3-19-live/fresh-change-390.png) |
| Private history refused | [View](screenshots/p3-19-live/fresh-refused-1280.png) | [View](screenshots/p3-19-live/fresh-refused-390.png) |

[Restored budget headroom at 390 px](screenshots/p3-13-live/fresh-repeat-headroom-390.png).
