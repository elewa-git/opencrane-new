# Draft assignment during first workspace load

Journey on a fresh dev stack: PASS

Tested product commit `6cb1a04482f0083ee4fa67d2241c16903e4e52df` on 24 November
2026 UTC. The receipt commit adds screenshots and this record.

1. Waited for both secondary slots to be free and the one-minute load to stay
   below six for five minutes. Claimed slot 1 and ran `up.sh --fresh --id 1`
   and `status.sh --id 1`. Fresh startup ran CORE with the stand-in model.
2. CORE passed at 1280 × 900 and 390 × 844. Chromium covered sign-in, chat,
   reload, Stop, uploads and refusals. CORE also passed sign-out, reauthentication
   and replay of members and the MCP catalogue.
3. At each width, signed in and opened an existing personal session. Playwright
   set only `assistantId` to `null` in the first `/api/chat` response and held
   the real `/auth/me` response. Ctrl+N, Cmd+N and a pointer click left the saved
   session address in place. New session and Ask your agent were visibly disabled.
4. Released identity, waited for the requested session's transcript request,
   and held its real response. Clicked New session before releasing that
   transcript. The real server sent the member's existing assignment over
   WebSocket. The composer opened with one document load and one `/api/chat`
   read. Sent a message and saw the assistant reply finish at each width.
5. Copied the screenshots, ran `down.sh --id 1`, and confirmed that
   `status.sh --id 1` reported `free`.

| Screenshot | 1280 px | 390 px |
| --- | --- | --- |
| CORE chat after Stop and reload | [Desktop](workspace-1280.png) | [Phone](workspace-390.png) |
| Draft actions disabled during the held identity response | [Desktop](identity-wait-1280.png) | [Phone](identity-wait-390.png) |
| Live assignment received and composer available | [Desktop](draft-ready-1280.png) | [Phone](draft-ready-390.png) |
| Completed reply after opening the draft | [Desktop](draft-reply-1280.png) | [Phone](draft-reply-390.png) |

The first fresh attempt passed CORE, as did the separate `journey.sh` run on
that stack. The 1280 px draft received its assignment, but its browser reply
stayed at “Folding…” after the service recorded the turn as complete. Copied
sanitised startup and service logs before teardown. The focused regression
reproduced that state by opening a draft during a pending saved transcript read.
The final fresh attempt tested this timing at both widths.

Standalone approval and real-provider journeys were NOT RUN.

## Source checks

- The test-only commit `6d1dd1a25` reproduced both review failures. Selecting a
  saved session while Retry waited for identity left the rail loading after
  both reads settled. A 503 on the first list read let draft actions clear the
  address and sent the timed retry to the latest session.
- Provisioning, direct chat, workspace and navigation passed twice with 236 tests
  in each run. Provisioning checks the rail, button and Ctrl+N after the delayed
  Retry, and checks that a first-list 503 preserves the requested address through
  refused actions and successful retry.
- The test-only commit `8a21371d0` reproduced the live reply stall after a draft
  replaced a still-loading transcript. On the final product commit the draft
  showed the live message and its completion after the old read settled.
- The fixture source check reproduced both copies of the held response and
  five inline callbacks before the change. It passed after both specs shared the
  helper and provisioning declared the callbacks before use.
- Typecheck, event catalogue (174 types), Knip, changelog lint, scoped ESLint and
  Markdown lint passed.
- The dependency check accepts the shared response fixture from Angular specs.
  A temporary probe confirmed that application code still cannot import a test
  fixture or an Angular spec.
