# Web

For people, read [README.md](README.md) first.

This Angular app provides the organisation settings shell and MCP register.
The [server](../server/README.md) owns sessions and register truth. The register uses
authenticated HTTP reads; the workspace uses the authenticated WebSocket.
The browser retains the last successful register read only while access remains valid.
The Integrations register searches and filters that read. Its detail page reads the
register first, then reads the matching server's tool policy. It shows a server row as soon
as the register read succeeds. A failed list refresh keeps the row, says that availability
was not checked, and hides that message while another refresh is running. A 401 or 403
clears the register and detail page before showing the shared access-lost message.

The add page accepts a remote HTTPS address and follows discovery status. When discovery
returns an inventory, the page links to Tools & access. That page saves a changed tool
mode once. If its reply is lost, Check status reads the saved modes and never sends the
save again. A saved tool policy stays visible until the server replies with new modes.
Connected state and access grants remain unavailable until the server provides those details.
People & groups reads flat group rows from `/api/groups`, validates them through
the shared protocol package and creates groups through the same-origin API.

## Entrypoint and usage

[src/main.ts](src/main.ts) bootstraps the standalone application.
From the repository root, with the server configured and running:

```sh
npm run dev -w apps/web
```

Open `http://localhost:4200/org/integrations`; `/org` also opens this implemented page.
`/org/integrations/<id>` shows four separate facts for a registered server. It does not
read the tools route for an id missing from the register.
Organisation navigation is Overview, People & groups, Models & providers, Spending,
Integrations, Routines and Change history. People & groups reads the flat group list,
shows read-only group details and lets Owners and Admins create groups. Overview and
Routines show explicit availability states until their screens are built. Desktop uses a
220px sidebar; phones use the shared modal menu. Back to workspace opens `/workspace`.
`/org/states` renders the shared state vocabulary for development and visual checks,
but is not a navigation destination. [F3 source receipt](../../docs/process/f3-org-shell/README.md).
[proxy.conf.json](proxy.conf.json) forwards `/api`, `/auth` and `/ws` to port 8080.
The register reads `/api/org/integrations`, leaving `/org/integrations` and the
other `/org/...` paths to Angular page navigation.
Configure the provider callback and server `OIDC_REDIRECT_URI` for the browser origin,
including `/auth/callback`. Local HTTP development requires local-only cookie settings
as described in the [server README](../server/README.md).
The browser uses same-origin auth and WebSocket URLs; no credentials are built into assets.

## Contract and verification

The client validates the register response and incoming messages with
[protocol](../../libs/protocol/README.md).
Register refresh failures keep old rows and their load time visible. A retry after a
failed first read never shows the empty-register message or zero counts. The refresh
button stays in place and keeps keyboard focus while retrying. Detail refresh keeps its
facts and policy visible until a new tools reply arrives. It hides an old failure notice
while retrying and moves focus from a message-state Refresh button to the header Refresh
button when the row appears. Clear search returns focus to the search field.
Refusal clears protected rows before any response body is parsed. Non-admins see that the
Owner or Admin role is required. Adding a remote MCP server uses `/org/integrations/new`;
discovery and tool review retain their existing API flows.
Socket closure updates state and schedules reconnect with jitter;
there is no durable outgoing message queue. Sign out uses a native form POST to
`/auth/logout`; the server sends a 303 navigation to Zitadel. Page JavaScript never
reads a logout URL or ID token. Zitadel signs out all accounts in that browser,
returns home without a chooser and requires credentials on the next sign-in.
That next sign-in may first show a remembered-account selector. Page navigation ends the
current socket; the shell does not explicitly disconnect it first. The server checks
the session and Origin on every WebSocket upgrade.

```sh
npm run typecheck -w apps/web
npm run build -w apps/web
npm run test -w apps/web
npm test -- apps/web/test
```

The Angular suite covers components, messages and reconnect timing; the root suite
checks theme contracts and drives Chromium through the dev proxy into the real server,
PostgreSQL, NATS and OpenFGA register path. Both suites are needed. A real provider
sign-in journey on a fresh silo is not qualified by these tests.
The build produces static assets in `apps/web/dist/web/browser`; serve them with
same-origin `/auth` and `/ws` routing and TLS in a deployment. The app needs no server
filesystem or database permission. Reload discards local UI state and reconnects;
the chat workspace reloads durable history from the bridge projection.

Dependencies are Angular, RxJS, tslib, the shared protocol schemas and self-hosted
DM Sans/DM Mono font files from Fontsource (OFL-1.1). Playwright is build-time only.
See the [repository architecture](../../README.md) and [plan](../../plan.md).

## Sign-in

`/` shows the SSO-first sign-in screen or the current session and sign-out action.
`/signin/handoff` focuses Cancel and announces “Opening single sign-on…” for 2.5 seconds before
opening the existing server login route; Cancel returns home and stops the timer.
`/signin/rejected` shows fixed, safe failure copy with an SSO recovery action.
Set the public `opencrane-org` meta tag in `src/index.html` for the deployment’s
organisation display name. A non-empty `?invitation=…` arrival shows the frame’s
invitation copy using that name; it does not grant membership or validate an invite.
All three use the onboarding SSO colour token and shared states at desktop and
390px widths. Passwords stay on Zitadel. Email sign-in is unavailable until
delivery is qualified; there is no fake sent-email screen.

Run `npm run visual:signin` with the dev stack running to capture the three screens
and 1× card comparisons cropped from the design source in `/home/jente/.fleet/signin-shots/`. The capture checks card dimensions, spacing, tokens, copy, overflow and 44px
controls. Browser-clock checks exercise focus, Enter/Space cancellation and timing. The live journey uses normal
timers, real Zitadel and both test accounts; see the
[sign-in evidence](../../docs/process/signin-evidence.md).

## Chat workspace

After sign-in, choose **Open workspace** (`/workspace`). Personal Agent sessions
use the real bridge's `GET /api/chat`, conversation commands and resumable `/ws`
feed. Only `agent_session` rows are shown. A new draft creates a conversation at
first send; message ids stay stable across explicit retries. Pending messages are
kept only on this page and the UI warns that reload discards an unsent draft.
No conversation content or credentials are stored in browser persistent storage.

Stop records `agent.turn_stop_requested`, interrupts the computer and keeps text
through that position on replay. HTTP reads page through history; realtime consumes
every validated envelope, including several deltas in one zoneless render. Access
refusal clears protected content. The computer state announces wake progress.

Keyboard paths: Enter sends, Shift+Enter adds a line, Ctrl/Cmd+N opens a draft,
Ctrl/Cmd+Shift+A asks the personal Agent, Ctrl/Cmd+K finds a session. Native panel
and preview dialogs use Escape and focus restoration. Phones use a top-bar menu,
a docked composer and 44px targets. The panel starts closed below 1100px.

Run `NO_COLOR=1 npm test -- apps/web/test` for Chromium plus replay tests, and
`NO_COLOR=1 npm run test -w apps/web -- --watch=false` for Angular's unit suite.
`npm run visual:chat` regenerates the [comparison page](../../docs/design/chat/comparison/index.html).
[Reuse and deferred file transport](../../docs/design/chat/IMPLEMENTATION.md) records
attribution and the scope limits. The live dev-stack journey uses only the stub
provider and includes streamed text, Stop and reload through the shipped UI.

## Tool policy

Tools & access lives at `/org/integrations/:serverId/tools`. Native radio groups offer
Allow automatically, Ask and Block. Saves need the validation connection returned by
the policy read. A 409 offers a GET to review current modes or discard edits. A lost save
reply keeps its command id in memory and offers GET-only status checks. Access refusal
aborts reads, clears the policy and focuses the shared access-lost heading. Publishing,
grants and review marking wait for server support. The add flow offers remote URLs;
catalogue and hosted packages remain unavailable.

`/org/models` is Models & providers: the pinned registry remains here, with provider
and routing editing explicitly unavailable. `/org/spending` shows the existing budget
summary and editor, then lists held spend before the budget cards. It displays global
and configured paying-group/assistant monthly ceilings, current charges and held
reservations. It edits whole euro cents through `/api/org/models`. Running calls stay
in a waiting count. Owners and admins can read a hold's evidence and send one settlement
or release command with one evidence entry. A lost reply keeps its command reference
and offers a GET status check; the browser never repeats that POST. Each pending command
stays with its permit while another hold is open. Access loss clears budgets, effect
references and the open drawer. The browser check captures 1280px and 390px screens and
checks layout at 320px.

The chat restores approval cards from the authenticated approval endpoint above
the composer. The requester sees the reviewed fields and can approve or deny.
Other participants see that the requester must decide. Folded cards show only
what the server proves. A used approval says that its result is unknown. A lost
decision reply leads to one status read; the browser never repeats the POST by
itself. A 503 can also mean the server refused before recording the choice. If a
409 is followed by a still-open approval, the card says the choice was not recorded
and lets the requester choose again. A 200 keeps the card locked with a recorded
message until a later read shows its latest state, even if the first read fails.
Access refusals hide the cards but keep any open or uncertain choice locked. A
15-second timeout ends a stuck poll so later polls can run. The approval drawer
shows the same result and status check as the card. It closes if that card
disappears. Focus moves to the conversation when a focused card disappears or
access changes, and moves to a folded card when the drawer's opener is gone. No
decision time, other person's name, cancellation cause, tool-server readback or
confirmed result is available from this contract.
The requester-only POST uses the session CSRF token and appends one conditional
decision. A 403 or 400 means the decision was not recorded. A GET while handling
that reply may still record that the approval expired or was cancelled. A 409
means the approval is no longer requested, its conditional append lost, or the
append was rejected. A 503 can mean the server refused before an append or that
the append outcome is not known. Check status sends one GET only.

Transcript tool records come from `agent.command_ran` and `agent.turn_failed`.
Restricted turns do not report commands. Team turns sent from the workspace run
restricted, so they show at most the “Reply failed” line. Tool details show the
recorded result, UTC time and event reference, then say that the location, account
and attempt history are not available. The transcript does not show raw arguments,
tokens or full tool output. A stored review that fails the review schema makes the
GET return 400. The browser shows the read-failed state and pauses decisions.
Chromium captures use intercepted fixtures and do not prove a live governed turn.

## Desktop view

Admission uses `POST /api/conversations/:id/view`; the viewer socket uses
`/ws/conversations/:id/view`, through the existing frontend `/ws` proxy.

The session panel and its phone overlay offer **Watch your computer** for a saved
conversation. The self-contained `LiveView` component opens a native dialog with
fit/actual-size viewing and Connecting, Viewing, Disconnected and Access changed
states. Participants need an explicit shared-desktop grant; a refused admission
shows **Unavailable**. Revocation closes the connection and clears pixels.
Escape closes the dialog and restores focus to its entry. Changing conversation
or destroying the component cancels admission and closes the old connection.
All viewer buttons have 44px targets. The viewer uses only noVNC's OSI-licensed
core and the authenticated proxy; it provides no control or clipboard path.

`npm run build:live-view-test -w apps/web` builds a separate browser qualification
host from `test/live-view-main.ts`; the k3d test serves it on `/live-view-test`.
[Licence and live evidence](../../docs/process/live-view-evidence.md).

The viewer's **Screenshot** button starts one capture and save request. It shows one
saving message and stays focused while the request runs. The transcript and both viewer
locations use the same capture status component. While Check status reads the feed, its
button stays in place, announces that it is unavailable and ignores extra clicks. If the
read fails, the status gives the same explanation in the viewer or transcript where it
was opened. Try again and the same-request resend move focus to the status region before
the button disappears. A saved PNG appears in the
transcript and Files panel with a name, caption and capture facts. Its preview shows
the image, the computer id, the generation number and a download link. A 503 offers a
same-key retry. An unanswered request shows its command id and says that its result
could not be confirmed. It keeps the Screenshot action unavailable until Check status
successfully reads the feed. That read marks only the unanswered request it began for.
The same-key resend appears after a successful read. A new Screenshot after that read
uses a new command id. A failed read never says that Files were read. A scan rejection
appears once in the transcript and does not show the file name. A 401 or 403 asks the
person to check access; a later denial clears file details and closes the preview.
Thumbnail and preview failures have their own retry states.
The [screenshot screen receipt](../../docs/process/p3-18-screens/README.md) records browser
captures and checks. The [earlier screenshot receipt](../../docs/process/p3-18-screenshots.md)
records the service journey. Sample browser checks do not qualify a fresh installation.

## Team composer and recovery

Private is the safe default. The memory-free choice applies to one turn, uses the
shared disk and has no earlier private context. Both buttons lock while a message
is sending or queued. Retry first reads the pending command's status and reuses its
id if it must send again. Recovery refuses both Send and Retry.
A successful receipt clears the pending command and resets the choice to Private.
The draft stays as typed after refused or lost send replies. Pending commands block
session changes. They are kept only on this page, with their reference shown.

Recovery notices follow the last reply. Changes are announced through the existing
conversation status region. Selection from the notice moves focus to the composer;
recovery restores lost composer focus without taking focus from another control.
A recovered computer shows the lost-request notice only for an affected last turn.
The last confirmed time is calculated from loaded Done turns in the browser.

`workspace.spec.ts` covers these states, partial lost output, default/private posts,
personal posts, Enter, healthy refresh and two sends during one visit.
The visual script captures both the choice and selected memory-free states at three
widths with both motion settings, after finite animations finish. It checks 44px phone
buttons, overlap and overflow. Fresh-install live qualification remains NOT RUN.
