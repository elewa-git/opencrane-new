# Draft assignment during first workspace load

Journey on a fresh dev stack: PASS

Tested product commit `0a3c30036ca8496043bf8e688067eed92dbbe9b1` on 24 November
2026 UTC. The receipt commit adds screenshots and this record.

1. Waited for both secondary slots to be free and the one-minute load to stay
   below six for five minutes. Claimed slot 2 and ran `up.sh --fresh --id 2` and
   `status.sh --id 2`. Startup ran CORE to completion with the stand-in model.
2. CORE passed at 1280 × 900 and 390 × 844. Its Chromium run covered sign-in,
   chat, reload, Stop, uploads and refusals. It also passed sign-out,
   reauthentication, and replay of members and the MCP catalogue.
3. At each width, signed in and opened an existing personal session. Playwright
   set only `assistantId` to `null` in the first `/api/chat` response and held
   the real `/auth/me` response. Ctrl+N, Cmd+N and a pointer click left the saved
   session address in place. New session and Ask your agent were visibly disabled.
4. Released the identity response and clicked New session. The real server sent
   the member's existing assignment over WebSocket. The composer opened with
   one document load and one `/api/chat` read. Sent a message and saw the
   assistant reply finish at each width.
5. Copied the screenshots before `down.sh --id 2`. The recording shell exited
   during teardown. A separate status check found the slot directory removed
   and `status.sh --id 2` reported `free`.

| Screenshot | 1280 px | 390 px |
| --- | --- | --- |
| CORE chat after Stop and reload | [Desktop](workspace-1280.png) | [Phone](workspace-390.png) |
| Draft actions disabled during the held identity response | [Desktop](identity-wait-1280.png) | [Phone](identity-wait-390.png) |
| Live assignment received and composer available | [Desktop](draft-ready-1280.png) | [Phone](draft-ready-390.png) |
| Completed reply after opening the draft | [Desktop](draft-reply-1280.png) | [Phone](draft-reply-390.png) |

The first attempt passed CORE. Its delayed check failed during setup because it
selected only sessions marked `open`, while CORE had left completed and stopped
sessions. Retained sanitised startup and service logs before releasing slot 1.
The corrected check used an existing personal session and passed on fresh slot 2.
Standalone approval and real-provider journeys were NOT RUN.

## Source checks

- The test-only commit `6ed82d972` failed as expected. An early draft action
  cleared the URL query while the identity response was held. The final focused
  suite passed twice with seven tests each time.
- Angular passed 1,602 tests. The final serial web Vitest run passed 16 tests.
  An earlier parallel run hit the private-reply fixture's socket timeout. The
  test passed in isolation and in the final serial run with the same timeout.
- Typecheck, event catalogue (174 types), Knip, changelog, scoped ESLint,
  Markdown lint and the production web build passed. The build reported the
  repository's stylesheet-budget, Mermaid and CommonJS warnings.
