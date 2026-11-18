# CORE journey

Journey on a fresh dev stack: PASS

Tested head: `9d715a3845dfd3c693c1a556f2d526b782d853c1`.
Run date: 18 November 2026. Secondary slot: **1**.
Fresh startup, status and teardown each exited **0**.
[Slot 1 was verified free](teardown-status.txt) after teardown.

The standard CORE runner used Playwright from this checkout at 1280 px and 390 px.
Managed calls were switched on with the stand-in provider. Clock injection is
always active; the default `systemClock` keeps production timing unchanged.
The [capacity log](journey-capacity.txt) records five continuous eligible minutes
before each claim: both slots free, no package stack and load below 6.

## Steps observed

1. Sign in through Zitadel and PKCE in separate owner and member browser contexts.
   Refuse wrong-organisation tokens, expired sessions and hostile logout requests.
2. Send a message, watch the streamed reply, reload, then Stop another reply and
   retain its partial text after reload: [desktop](screenshots/workspace-1280.png),
   [mobile](screenshots/workspace-390.png).
3. Upload and preview a PDF, then read its project code through the running agent.
   Exercise text and image previews, reload, and refuse EICAR, type and size cases:
   [desktop preview](screenshots/preview-1280.png),
   [mobile preview](screenshots/preview-390.png).
4. Refuse a viewer without a grant, grant the real desktop, then revoke access and
   clear pixels. Revocation took 411 ms at 1280 px and 502 ms at 390 px:
   [desktop refusal](screenshots/shared/docs/process/live-view/conversation-revoked-1280.png),
   [mobile refusal](screenshots/shared/docs/process/live-view/conversation-revoked-390.png).
5. Read action history and organisation metadata. Keep private history unavailable
   to another member and the owner, then clear protected history on access change:
   [desktop](screenshots/shared/docs/process/p3-19-live/fresh-refused-1280.png),
   [mobile](screenshots/shared/docs/process/p3-19-live/fresh-refused-390.png).
6. Save zero paying-group and assistant ceilings through Spending. Send messages,
   see the matching refusals and retain them after reload at both widths. Restore
   headroom afterwards: [desktop group refusal](screenshots/shared/docs/process/p3-13-live/fresh-paying_group-refusal-1280.png),
   [mobile assistant refusal](screenshots/shared/docs/process/p3-13-live/fresh-assistant-refusal-390.png),
   [restored headroom](screenshots/shared/docs/process/p3-13-live/fresh-repeat-headroom-390.png).
7. Verify member and catalogue replays, computer wake and disk retention. Sign out,
   refuse unauthenticated access, and require credentials for the next sign-in.
   Check that tokens do not appear in browser boundaries or process logs.

## Evidence and limits

The [startup output](startup.txt) records each assertion; [status](status.txt)
records running services and healthy endpoints. All **37 screenshots** were copied
before teardown. All **33 unique images** were visually inspected. The
[screenshot index](screenshots.md) links every capture, and the
[manifest](screenshots.json) records dimensions and SHA-256 digests.

Each viewport needed one existing upload transport retry. Both completed with no
duplicate files and zero preview retries. The startup output retains the transport
messages and retry counts. No retry or timeout was added by this slice.

**NOT RUN:** the runner skipped its approval journey pending #45 rows 4, 5 and 14.
No approval, native-provider or extended journey qualification is claimed here.
The separate opt-in test conditions are listed in [checks.md](checks.md).

The initial startup selected token bootstrap mode, which skips CORE. That attempt
is **NOT RUN** for the journey. Its [startup](attempt-bootstrap/startup.txt),
[status](attempt-bootstrap/status.txt) and [teardown result](attempt-bootstrap/result.txt)
were preserved. The corrected attempt above used another fresh startup after a
new eligibility check. It ran the complete required CORE path.

## Behaviour-preserving review fixes

The [fix receipt](review-round-1.md) records the later test-proof repairs and
receipt extraction. The extraction preserves production behaviour; the focused
receipt and dispatch tests pass before and after. This existing CORE PASS remains
the product journey evidence. No new live journey is claimed for the fixes, and
the approval qualification above remains NOT RUN.
