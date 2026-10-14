# Web

For people, read [README.md](README.md) first.

This Angular app provides the organisation settings shell, MCP register and Memory panel.
The [server](../server/README.md) owns sessions and register truth. The register uses
authenticated HTTP reads; the workspace uses the authenticated WebSocket.
The browser retains the last successful register read only while access remains valid.
`/workspace/conversations` reads the server's Recent list. `?section=archived` reads
Archived. Search stays in memory and uses at most 100 characters. Each request uses
20 rows and the returned cursor. A changed list reloads page one once. Temporary
failure keeps loaded rows and offers a read-only retry. A 401 or 403 clears them.
Links use each row's mode to open the workspace or direct chat. A saved link missing
from page one searches Recent, then Archived, with up to five 50-row pages per section.
An exhausted search shows the generic unavailable screen; an outage can be retried.
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
Group details link to a shared assistant draft at
`/org/people/groups/<id>/assistants/new`. The draft reads the owner group, listed groups,
`/api/assistants` and `/api/org/models`. It offers that group's active model and tool grants.
Review shows that selected resources also become available to people through the owner group,
while desktop access stays separate. `POST /api/assistants` records one assistant with its
owner group, fixed paying group, name and grants. The server assigns its computer later.
The list shows the returned lifecycle and busy fields. This API has no failed-provisioning
retry, add-computer command or queue count. A lost computer is not shown as a failed create.

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

`/workspace/direct` is the human-chat screen. It reads `/api/chat` for the current
member id, `/api/chat/colleagues` for joined-colleague search, `/api/chat/groups`
for groups the member belongs to, and `/api/chat/groups/:groupId` for a current
member snapshot and team position. It creates a direct conversation with
`{ id, conversationId, mode: "direct", colleagueId }` for one colleague. Several
colleagues or a reviewed group use `{ mode: "group", participantIds, groupId?,
groupSnapshotPosition? }`. A person selects at most 96 other members, so the creator
and audience never exceed the server limit of 97. The snapshot position is sent with
the first create; a conflict tells the person to choose the group again and review it.
No create request happens while the person is still choosing recipients. The first
message gets a separate request after access is applied. The server encrypts the text
and records it as a human message. The screen never sends a turn, stop, assistant,
memory or model request. A lost reply keeps its command id and uses
`/api/conversations/:id/changes/:commandId` for a status read. Unknown status never
causes an automatic resend. A 401 or refused history read clears names, the draft
and transcript, then focuses the access message. The screen subscribes to the
conversation feed after loading history and resumes from its event position after
the existing WebSocket service reconnects. Repeated positions are ignored.
Group rows from the same conversation list open in this transcript. They use the same
100-row history paging, last-position socket resume and send-status checks as direct
rows. Each group message names its stored author id, using a colleague display name when
the current colleague read knows it. A successful append is labelled Saved; the screen
does not claim delivery. Group messages are plain text, including literal `@agent`, and
the group transcript has no assistant controls. Direct and group drafts stay with the
conversation where they were typed. A 403 reply to a message clears the transcript,
drafts, people and pending messages. On a phone, the screen closes the conversation menu
and focuses the unavailable notice. A missing or removed conversation link says the
chat was not found and leaves the authorised chat list available. Selecting a listed chat
opens it from that state. Late replies cannot restore cleared content.

The recipient picker shows up to three chips. When more people are selected, Review all
opens a full-screen native dialog with every recipient. The dialog starts focus on its
heading. Back to recipients closes it and returns focus to its opener. The chips wrap at
phone width, and each remove button has a 44px target. Group choices load in pages of 50
using the server's `next` cursor. A selection of more than three people cannot be sent
until the full audience has been opened for review. A group snapshot cannot be edited in
place; choosing it again reads a fresh snapshot. A blank
search says when no people match, and group-list failure leaves colleague selection
available. Choose an assistant opens the existing private-session picker. If people
are already selected, the picker refuses that choice and keeps the draft.

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

The member picker lives at `/workspace/shared`. It lists only assistant rows with
`canStartSession` and asks the member to confirm the assistant's fixed paying group.
It creates a private session with `POST /api/conversations`, using one command id,
conversation id, assistant id and the same payer id. After a lost reply, Check status
reads that command's change route and never repeats the create. A confirmed session opens
at `/workspace?conversation=<id>`. The transcript and payer id come from the authorised
conversation list; the member route does not supply the payer's name. The workspace says
that desktop access is separate. Uploads are unavailable for these sessions because this
create route does not accept them. Child delegation and child start status are not part of
these routes. Browser captures use intercepted replies and do not prove live access or
computer provisioning. [P4-7 screen receipt](../../docs/process/p4-7-screens/receipt.md).

## Ownership

`/org/people/owners` reads `/api/ownership`. The response lists current owner member
ids and display names, the ownership sequence, the viewer id and role, and whether the
screen is ready. Owners can enter a known member id as a proposed successor. The API
does not provide a member directory or candidate names, so the screen does not pretend
to offer a directory search. The server checks that the successor is an active member.
The review shows the names returned by the owners read and the entered id.

Transfer sends one command with action `transfer`, a fresh command id, the sequence
from the read, and the successor id. Step-down sends one command with action `step_down`
and the same sequence check. Confirmed events are `ownership.transferred` and
`ownership.stepped_down`. Each pending change is one record kept separate from the review draft.
While a command is applying or its reply is unknown, the screen disables another
ownership change. A 200 receipt is followed by read-only status and owner reads before
the screen shows the confirmed owners. A lost reply says that the change may or may not
have been recorded, shows the command id and offers GET-only status checks. A 404 says the
server has no record yet; the first request may still arrive. Refreshing the owner list is
safe while the result is unknown. A 401 clears the owner details. A 400 says that nothing
was sent. The screen never repeats an uncertain POST. The server prevents transfer or
step-down from removing the last Owner.

The API does not report other pending ownership changes with actor names or start times.
It also does not expose group grants for comparing the successor's access. The screen
does not invent either detail. The screen explains all ownership conflict and refusal
reasons returned by the server. It names an inactive successor and keeps the typed ID in
**Choose another owner**. If the viewer is no longer an Owner, it refreshes the owner list
and removes the Owner controls. Other access refusals clear protected owner details.
Admins can read the owner list but cannot start an ownership change.

`npm run visual:p4-2-screens` captures the ownership frames at 1280, 390 and 320 pixels,
with reduced motion on and off. It checks overflow, live status count, target size and
text contrast. The receipt records the visible differences from PPL-30 to PPL-35.

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

Stop records `agent.turn_stop_requested` to ask the computer to interrupt the turn.
The transcript says “Stopping…” until `agent.turn_failed` or `agent.turn_completed`
confirms that the turn ended. After ten seconds without an ending report, the page
says “Stop not confirmed”, shows the turn as active and lets the person try Stop again.
A late ending report still sets the final turn state. Tool finishes still update the
transcript while it is stopping. Every new socket connection resets readiness before
the server replays saved rows and sends `ready`; replayed tool transitions stay quiet,
while new transitions after `ready` are announced. HTTP reads page through history;
realtime consumes every validated envelope, including several deltas in one zoneless
render. Access refusal clears protected content. The computer state announces wake
progress.

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

`/org/models` is Models & providers. Owners and admins can create provider connections
and save or replace their keys. The browser keeps one pending command per provider
and checks its original command id after a lost reply. Enter uses the same pending
guard as the save button. Key fields stay as typed after refused or lost replies
and clear after a 200 receipt. List status comes from the server status field.
Key saved times come from the saved fact and stay unchanged during refresh.
A confirmed change keeps its controls locked until the updated provider row has
been read, so a late reply cannot change another open dialog.
The Verify step posts only `commandId`, `expectedRevision` and `action` for
reachability and skip. A priced test adds the model, price table id, reserved euro
cents and explicit consent. The provider id belongs only in the URL. Consent is
one quote record and clears before sending, when its result arrives, and when a
quote, step or provider changes. An unfinished or unknown test keeps its original
command locked; Check status sends one GET and never starts a new paid request.
A fresh visit restores this lock from an unknown model-answer fact returned by
the server. A settled result hides the paid controls until Test again is chosen;
the consent box then starts unticked.
Only pass, fail, skipped or budget_refused settles that UI lock. Budget refusal
uses the blocked state; unknown outcomes use the question mark state.

Anthropic skips model selection without a command. OpenAI writes model choices
only when the set changed. A 403 command refusal rechecks the provider list and
clears the page only if that read also refuses access. A 404 create or key status
read offers Start over; it never starts a new command by itself. The person types
a key again after choosing Start over. An unknown paid attempt has no Start over.

`provider-page-state.ts` keeps list reads, pending commands and access checks.
`provider-key-changes.ts` handles creation and write-only key saves. The screen
handles verification and model selection. `provider-display.ts` formats server
facts without turning unknown results into failures. Each open modal has its own
status region, and closing it returns focus to its own opening control.
The visual fixture checks request bodies with the real verification schema and
rejects a provider id in the body, just as the real route does. All priced-test
specs and captures intercept requests; none uses a paid upstream.

`/org/spending` shows the existing budget summary and editor, then lists held spend before the budget cards. It displays global
and configured paying-group/assistant monthly ceilings, current charges and held
reservations. It edits whole euro cents through `/api/org/models`. Running calls stay
in a waiting count. Owners and admins can read a hold's evidence and send one settlement
or release command with one evidence entry. A lost reply keeps its command reference
and offers a GET status check; the browser never repeats that POST. Each pending command
stays with its permit while another hold is open. Access loss clears budgets, effect
references and the open drawer. The browser check captures 1280px and 390px screens and
checks layout at 320px.

The chat restores approval cards from the authenticated approval endpoint above
the composer. Every participant sees the reviewed fields and consequence. Only
the requester sees Approve and Deny. Other participants see that the requester
must decide. Folded cards show only what the server proves. A used approval says
that its result is unknown. A lost decision reply leads to one status read. The
browser never repeats the POST by itself. A 503 can also mean the server refused
before recording the choice. If a
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
tokens or full tool output. Live tool start and finish rows update one polite status
message. History replay and streamed text do not announce tool changes. If a turn
ends before a tool finish report arrives, the tool says that no finish was confirmed;
it does not claim that the call failed, completed or kept running. An open details
drawer follows the latest saved tool row. A stored review that fails its schema
makes the GET return 400. The browser shows the read-failed state and pauses
decisions.
Chromium captures use intercepted fixtures and do not prove a live governed turn.

Run `nice -n 10 npm run visual:p4-4-screens` to capture direct-chat states at
1280px, 390px and 320px, with normal and reduced motion. The sample checks count
turn and model requests and do not qualify a fresh installation. See the
[direct-chat screen receipt](../../docs/process/p4-4-screens/README.md).

## Desktop view

## Memory reads

The workspace session panel reads `/api/memory/scopes`,
`/api/memory/:scopeId/facts` and the selected fact detail route. It passes the selected
session's group and assistant ids to scope discovery. It keeps results only in component
memory and honours the server's
`Cache-Control: no-store` response by making no browser cache of its own. Search and
scope changes discard old list replies; scope changes and access loss also discard old
detail replies. A refused read clears protected content. Source refusal hides its
reference; source service failure leaves the fact visible and says the source could not
be checked. A denied workspace session also clears every memory value and cancels its
pending reads. A changed requester causes scope discovery to run again. The detail view
uses the shared modal overlay, returns focus to its fact row and shows the scope audience,
kind, revision, saved date and pin state. A rejected search is reported beside the search
field. A stale page cursor is discarded and the first page is read again. A requester
change clears all store form state as well as read state before new scopes load.

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

## Shared assistant administration

An organisation admin opens a group's shared assistant page from People & groups.
The page reads the group, group list, assistant list and active model list before it
offers a create. It offers the group's model and tool grants, and sends the selected
paying group with the create command. A 401 or a refused read clears the protected
group details. A 403 create refusal keeps the form and its typed values because the
server may have refused a model or tool server that is no longer available.
A lost reply keeps the command and assistant ids. Check status only reads. If no
record is found yet, the page can send the same request again with the same ids.
A confirmed create clears the name and grants before the next create.

`workspace.spec.ts` covers these states, partial lost output, default/private posts,
personal posts, Enter, healthy refresh and two sends during one visit.
The visual script captures both the choice and selected memory-free states at three
widths with both motion settings, after finite animations finish. It checks 44px phone
buttons, overlap and overflow. Fresh-install live qualification remains NOT RUN.

## Direct conversations

`/workspace/direct` reads the context, authorised conversation list and colleague
search. Search states distinguish loading, failure and successful empty results.
A newer request cancels the previous search and ignores its late reply. Refresh
uses the typed query. Search returns at most 20 people; the screen asks for a narrower
query. Names already read are kept separately from the current search choices.

`direct-chat-sending.ts` owns one pending record for create, permission checks and
sending. The record keeps the conversation, colleague, original text and stable
create/message references. The composer and chat changes stay locked until a receipt
confirms the message. Only that submitted text clears; a later edit stays in the box.
The screen keeps separate in-memory drafts for each conversation or new recipient.
Reload discards them. No message is called recorded without a 200 receipt.

HTTP 425 `access_applying` means a recorded participant is waiting for the creation
permissions. First reads and sends retry with waits of 100, 200, 400, 800, 1600 and
1600 ms. A 403 read remains a refusal and clears protected information. A creation
status GET with 403 says that no creation record is available, keeps the message and
offers Try again with the same ids. A message status GET with 404 says no record yet
and offers Send again with the original id and text. Neither status check sends a POST.

History loads before socket subscription. Replies from a former conversation or
access state cannot replace the current view. New rows follow the bottom unless the
person has scrolled up. One live status line announces received messages and recorded
sends. A visible recorded notice stays until the transcript contains that message.
Send errors have their own text; refresh does not change it. Editing clears it.

The Participants button reads `/api/conversations/:id/participants` before showing names
or actions. The creator cannot be removed or leave; only that creator can add or remove
other people, and every other participant can leave. The list uses current conversation
participants, not a group-membership label. A missing colleague name is shown as removed
from the company. Each change posts once with the access position from that read. A lost
reply keeps its command id and offers a GET to the existing change route; it never sends
the command again. Applying, unknown and confirmed results have separate messages. A
refused participants read clears messages, names, drafts, participants and pending sends
and focuses the unavailable heading. Replies from an older conversation or an earlier
access period cannot restore that content.

The [screen checks](../../docs/process/p4-4-screens/README.robot.md) record API details,
captures, intentional design differences, guard removals and remaining live checks.
The [recipient checks](../../docs/process/p4-4-start-evidence.md) cover the first draft PR.

Dialog methods installed by model-registry tests remain writable, as browser
methods are. Other component tests can replace methods on their own dialog
elements even when the Angular runner reuses a test environment. The regression
in `src/app/models/model-registry.spec.ts` checks both `showModal` and `close`.

## Memory store and receipts

The Memory panel posts facts to `/api/memory/:scopeId/facts`. It counts UTF-8 bytes
and applies the server's text rules before enabling Store. Preference is available
only in person memory. Trusted source references come only from an authorised fact
detail read; the server checks them again. A saved receipt follows an accepted event.
`memory_busy` waits for `Retry-After` before offering the same command again. If the
reply may have been lost, Check status only reads
`/api/memory/:scopeId/changes/:commandId`; it never sends the fact again. Drafts and
command references stay in page memory. An unknown result keeps its command id and
status check when Cancel is pressed. A 401, 403 or refused 404 clears the draft, source,
receipt and pending command before the response body is read. A requester or scope change
also clears them, and late replies or delayed retries from the old request are ignored.
Invalid text shows the matching byte or character explanation beside the field and sets
`aria-invalid`. Cancel while editing makes no request. Undo and Edit actions remain
unavailable.

`memory-panel.spec.ts` covers cancellation, UTF-8 byte limits, scope-limited
preferences, saved and failed receipts, busy retries and status checks that never
resend, access refusal, pending requester changes and validation feedback. Browser
captures show the detail and invalid form at desktop and phone widths:
[detail](../../docs/process/p4-12-memory/captures/MEM-03-1280.png),
[phone form](../../docs/process/p4-12-memory/captures/MEM-30-390.png),
[validation](../../docs/process/p4-12-memory/captures/MEM-31-1280.png),
[saved receipt](../../docs/process/p4-12-memory/captures/MEM-32-1280.png), and
[unknown receipt](../../docs/process/p4-12-memory/captures/MEM-30-1280-unknown.png).

The [group recipient captures](../../docs/process/p4-5-pr5/receipt.md) show this picker
at desktop and phone sizes with fixture replies.
The [participant screen checks](../../docs/process/p4-5-pr7/receipt.md) show the
participant and unavailable states at desktop and phone sizes with fixture replies.
Participant events update the open list and the conversation's participant names as
they arrive. After a socket resync, the screen reads the current conversation list and
replaces the open participant rows with the server's current list. A participant event
cancels an older participant read so its reply cannot undo the live change. The add search
uses the server's matching-colleague results and follows its next-page cursor. An uncertain
participant command stays with its conversation, so another chat cannot replace it. Links
to another workspace page also stay on the screen until the command status can be checked.
The phone picker is a modal dialog with trapped keyboard focus; Back returns focus to its
opener. Access loss clears the shared socket message cache along with the page's drafts,
names, participant rows and transcript. The socket service ignores handlers left over from
the closed connection.
