# Fresh CORE journey

Journey on a fresh dev stack: PASS

Tested head: `44f739f458e67fe8c6f1cf4c1411373b2a4e7314`. Secondary slot 1, fresh install,
stand-in provider, origin `http://127.0.0.1:25106`. Ran from 2026-11-18T21:30:16.407503+00:00
to 2026-11-18T21:44:26.968430+00:00. Used the repository's Playwright from `node_modules` against the
running product at 1280 × 900 and 390 × 844, with separate signed-in browser contexts.
Preserved `OPENCRANE_FLEET_TASK`; no guard was bypassed.

## Before starting

Both secondary slots were free, no package stack was up, and the one-minute load
stayed below six for more than eleven minutes before the claim. Sampling ran every
30 seconds while the final required tests finished. The [claim sample](claim-gate.json)
was 17 seconds old and both slots were checked again immediately before `claim.sh`.
The [continuous samples](load-wait.jsonl) include an earlier background measurement
period and the current qualification period. Earlier high load reset the window.
All required source checks completed before startup.

## Steps observed

1. Ran `up.sh --fresh` for the claimed secondary slot. Website readiness passed in
   38,461 ms. Signed in the owner and member through Zitadel and PKCE. Checked wrong
   organisation, expired session, hostile Origin and missing Origin refusals.
2. At both widths, started a conversation, sent a message and saw the streamed
   stand-in reply. Reloaded without duplicate replies. Pressed Stop on the next
   reply and checked that the partial text survived reload.
3. At both widths, uploaded a PDF and saw the assistant read `Willow-47`. Checked
   upload/preview retry paths without duplicate files, promoted PDF/text/image
   previews, reload, and EICAR, unsupported type and oversized file refusals.
4. At both widths, opened the computer view. Checked the refusal without a grant,
   granted access to the real desktop, then revoked it. Pixels cleared and Stop
   was audited in 295 ms at 390 px and 108 ms at 1280 px.
5. Sent another message after suspension. Checked that the computer woke and replied,
   then checked assistant/computer lifecycle and disk survival after Pod replacement.
6. At both widths, opened action and organisation history. Checked separate allow
   and success rows, and refusal of another member's private history for both that
   colleague and the owner. Checked that private canaries were absent from logs.
7. At both widths, saved group and assistant ceilings through the UI, triggered
   over-ceiling refusals and reloaded. The refusal remained and nothing was repeated.
   Restored the fixture ceilings and checked the fresh migration was idempotent.
8. Verified replay of members and the MCP catalogue. Checked token boundaries,
   sign-out, reauthentication and loopback-only listeners. Ran `status.sh`: all
   required services and health checks passed.
9. Copied all 37 screenshots and sanitised startup/service logs into this folder
   **before teardown**. Ran `down.sh` successfully. Both secondary slots then
   reported `free`. The worktree remains for review.

## Results and limits

`up.sh --fresh`, `status.sh` and `down.sh`: PASS, exit 0. The
[run result](run-result.json) records the tested head and copy-before-teardown flag.
The [startup and journey output](up.log), [status](status.log), [teardown](down.log)
and [service log index](service-logs.md) are retained. Logs use the repository's
secret sanitiser plus private-path and email redaction.

Approval journey: NOT RUN. The existing journey explicitly skips it pending issue #45
rows 4, 5 and 14. Real-provider, extended phase 4 and standalone release-image
qualification: NOT RUN; outside this CORE run. The 72 opt-in source-test skips are
listed in [the source evidence](checks.md). No skipped condition is included in PASS.

## Screenshots copied before teardown

Original captures are retained. The builder inspected the chat, upload, desktop
revocation and budget refusal captures during the run and checked the final set.

| Step | 1280 px | 390 px |
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
