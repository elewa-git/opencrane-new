# Web

For people, read [README.md](README.md) first.

This Angular app provides the organisation settings shell, MCP register and Memory panel.
`/welcome/survey` is a separate page without a chat composer. It reads
`/api/onboarding` and opens the first unsaved step. The name and optional pronouns
form sends one checked `save_step` command. A confirmed save reads progress again.
Step 2 reads `GET /api/chat/groups?limit=16` every time it opens. It uses the
returned group ids as read-only context and never follows `next`. A failed group
read blocks Continue; Try again only repeats that GET. Work text is trimmed and
checked against the event store's 1–4,096 UTF-8 byte and character rules.
Any outstanding group read that returns 401 or 403 clears the survey, including
after Back or a newer group read. Older successful replies cannot replace current
groups. If saving step 2 would clear saved steps 3 or 4, the screen warns and asks
for confirmation. If only the current group list differs from the saved list, it
explains the difference and asks before replacing the saved step. A confirmed save
reads progress again before showing what remains saved.
Back opens the previous step. Editing an earlier step clears later current answers.
An unknown save uses only `GET /api/personal/changes/:commandId`. A 409 rereads
progress while keeping typed answers in memory; 403 clears them. A failed initial
read offers another try or an in-memory draft. Before saving that draft, the page
reads progress again. If it finds saved steps, it shows them and requires the person
to keep them or choose to edit step 1 and review later steps. The page checks
`/auth/me` even when progress has saved answers. A 200 reply with
`authenticated: false`, or a 401 or 403, clears those answers and any form values.
Late replies from that load cannot restore them.
Step 3 saves direct, warm or formal tone, brief or detailed length, and a
citations choice. The grouped controls use arrow keys to move and Space to select.
Step 4 saves distinct choices from the three offered tasks and an optional own task
of at most 4,096 UTF-8 bytes. These are wishes only; they grant or install nothing.
Back sends no write. Changing style warns before clearing a later task answer.
After all four steps, the page links to `/account/assistant`, which currently shows
that persona review is unavailable. `/account` reads only
the onboarding `state` and links to the survey for `not_started` or `survey`.
No survey answer is stored in the address, console or browser storage.
`npm run visual:screen-p4-19-survey` uses intercepted replies to capture both widths.
`npm run visual:screen-p4-19-survey2` captures the work step and its save states.
`npm run visual:screen-p4-19-survey3` captures style, tasks, save states and completion.
The [server](../server/README.md) owns sessions and register truth. The register uses
authenticated HTTP reads; the workspace uses the authenticated WebSocket.
The browser retains the last successful register read only while access remains valid.
Chat approval cards use the server's `missingFields`, `canApprove` and `canDeny` values.
Only the requester gets decision controls. Just before sending, the browser checks the
current card by id and repeats the state, requester, field and decision checks. A native
refusal appears from `agent.native_consent_refused`
in the feed. Its details use `nativeRequestId`, the saved turn id, optional
`serverName` and the saved time. It has no tool call id or permission action.
A detail opening checks the feed again. Each opening has its own request number, so a
reply from a closed or earlier opening cannot change the current drawer. A failed
refresh keeps the last safe summary and says the check failed. A 401 or 403 clears the
transcript and any open details. `npm run visual:screen-p3-5-facts` captures desktop and phone
screens with example server replies.
`/org/integrations/:serverId/access/explanation?requester=&assistant=&tool=` sends
the strict API query names `requesterId`, `assistantId` and `toolName` after checking
the address. It parses the server reply with `toolAccessExplanationSchema`. A missing
grant reply has no sources, profile or policy details. A failed refresh keeps dated
rows dimmed. Any 401 or 403 clears them and cancels other reads. Name lookups are
left for a later part; the page uses generic person and assistant names.
`/workspace/conversations` reads the server's Recent list. `?section=archived` reads
Archived. Search stays in memory and uses at most 100 characters. Each request uses
20 rows and the returned cursor. A changed list reloads page one once. Temporary
failure keeps loaded rows and offers a read-only retry. A 401 or 403 clears them.
Links use each row's mode to open the workspace or direct chat. A saved link missing
from page one searches Recent, then Archived, with up to five 50-row pages per section.
If either list changes during the search, it starts again at Recent page one once.
A second change offers Retry. An exhausted search shows the generic unavailable screen;
an outage can be retried.
The direct and group chat header shows Archive or Unarchive only when its current
server list row has `joinEventId` and `archivePosition`. It posts one `archive`
state command with that row's join, choice and expected position. A 200 receipt
reads the change once. `applying` keeps the pending command and offers Check status.
A lost reply or 425/503 keeps the same id and body; 404 offers a same-body retry.
409 reloads the list and selected row before another choice. 400 drops the command.
401/403 clears the chat and pending command. Late replies from another chat are ignored.
Recent, Archived, Back and chat selection stay blocked while the archive command is
unresolved. The original command id and body remain in memory for Check status and a
same-body retry after 404. A `current` status releases the command when the server row's
archive position has reached or passed the event sequence, even if a later device choice
has changed the value again. The header and tooltip use the saved group title.
The archived transcript line is a page notice, not a saved message or unread item.
The assistant workspace header does not yet have this control.

The direct/group transcript uses `read-marker.ts` after rendering caught-up messages in a
visible tab, while the transcript is near the newest message. Only
saved `message.posted` and `agent.message_completed` rows qualify. The command uses the
current list row's `joinEventId` and saved read position; local rows and other streams do
not qualify. One POST runs at a time. A lower list position cannot lower the confirmed
position for that chat and join. An uncertain reply keeps its id and body. The next read
attempt checks the original change GET once before sending again; a 404 retries the same
body. Conflict reloads the selected list row. Denial clears the page. Selection changes
abort a pending read. Read ids and positions remain in memory only.

Both open transcript pages clear protected content on a refused history, list or status
read, or a socket refusal. The direct/group page also clears after a refused read save.
Both pages also clear on a bare WebSocket close with code 1008 and do not reconnect that socket.
The workspace clears its address selection and
aborts an upload. Its revision prevents late list and history replies from restoring
content. Assistant-session read markers remain for the next part.
`npm run visual:screen-p4-6-read` captures the two lock screens and an open
group chat with a checked read body at two widths using intercepted API replies. The
phone check measures each header action's full box and the lock notice after rendering.
The Integrations register searches and filters that read. Its detail page reads the
register first, then reads the matching server's tool policy. It shows a server row as soon
as the register read succeeds. A failed list refresh keeps the row, says that availability
was not checked, and hides that message while another refresh is running. A 401 or 403
clears the register and detail page before showing the shared access-lost message.
`/org/integrations/<id>/changes` uses the detail page's two reads and refresh handling.
It accepts ids matching `[\w-]{1,200}`. The policy's saved catalogue snapshots supply
added, removed, schema-changed and details-changed rows. Missing or equal snapshots show
no counts and block review because the page cannot show a complete comparison. A missing
or invalid saved definition also blocks review. Each available full definition is shown
in an expandable, escaped view beside the short comparison. Descriptions
are limited to 300 characters; changed input fields show their types and limits, with at
most ten fields and 180 characters of detail per field. Titles, annotations and metadata
are also bounded. A failed tool policy read shows a visible notice. It hides Review tools
until a policy has loaded, or labels retained comparison rows with their last check time.
An expired catalogue says that calls stay paused. The changes page posts the exact
catalogue digest, policy revision, connection, account mode and every tool choice to
`POST /api/org/integrations/:id/review`. A new tool is Block. The next POST to
`/:id/publication` uses the review receipt's sequence for both `expectedSequence` and
`reviewRevision`. An unknown review needs a fresh detail read; there is no review
status endpoint. An unknown publication checks only
`GET /api/org/integrations/changes/:commandId` for its original command. The command id
is saved in session storage before the POST, keyed by server, so reopening checks that
original change before offering another decision. An unknown or deadline publication
reply with a change reference keeps Check status available. A 409 needs a fresh read.
`GET /:id/publication` supplies current progress. An older intent whose review revision
is behind a drifted policy does not block the new review. A saved command reference is
checked against its original change first. A matching reply releases it if the command
is confirmed or its publication belongs to an older policy revision. An uncertain
command for the current revision keeps Check status. Invalid saved references are
removed before any request, and access refusal removes a saved reference. Only a
matching change reply can confirm a pending publication. Publishing never restores
old approvals.
The check-start API and dated restored view are unavailable here. Run
`npm run visual:screen-p3-7-drift` and `npm run visual:screen-p3-7-drift2` for
intercepted desktop and phone captures.

The add page accepts a remote HTTPS address and follows discovery status. It also accepts
a hosted package only as a sha256 digest locator, one supported Linux platform and a
public upstream host and port. It posts one command id.
The hosted admission page renders the admission GET's checking, rejected, unavailable,
admitted and expired statuses. It shows the four dated verdicts and maps recognised
refusal reason codes to plain text. Unknown codes get a generic explanation. A rejected
package can return to the editable form for another digest. An unavailable scanner
offers only the admission status GET; there is no check-start request. Continue remains
disabled. Choosing another version returns keyboard focus to the new image field. A
401 or 403 clears package details only when it belongs to the current request; an old
status reply from a previous package cannot erase a newer registration or its result.
The intercepted checks and captures for the refusal and unavailable states
are in [the second admission receipt](../../docs/process/screen-p3-6-admission2/receipt.md).
The browser checks each encoded `xn--` host label by decoding and re-encoding it.
The decoded label must contain a non-ASCII letter, mark or digit and no other
characters except letters, marks, digits and hyphens. This catches a Chromium URL
case that the server rejects before the browser sends a command.
An uncertain POST keeps the command id
and reads `/api/org/integrations/changes/:commandId` without posting again. Once the
server id is known, Check status reads `/api/org/integrations/:serverId/admission`.
The page shows the returned queue time and each check's verdict and date. It updates
passed rows and the summary when the earliest check expires, even without another read. A failed read
remains unavailable; 401 or 403 clears package details and ignores older replies. Four
current passes still leave Continue disabled because discovery is unavailable. The
intercepted browser capture and checks are in
[the admission receipt](../../docs/process/screen-p3-6-admission/receipt.md).
When discovery
returns an inventory, the page links to Tools & access. That page saves a changed tool
mode once. If its reply is lost, Check status reads the saved modes and never sends the
save again. A saved tool policy stays visible until the server replies with new modes.
Connected state and access grants remain unavailable until the server provides those details.
People & groups reads flat group rows from `/api/groups`, validates them through
the shared protocol package and creates groups through the same-origin API.
The local group page searches `/api/members` after a 250 ms pause with at most 100
characters, an empty `after` cursor and a limit of 20. Show more follows `next` and
removes repeated ids. The add command uses a new UUID once. A pending addition blocks
other adds and removals. The page hides Check status and resend while an add POST is
running. Check status reads only its original command id after the POST settles.
A 404 offers an exact same-body resend, with one POST at a time. A confirmed
addition rereads the group after both content and IAM are current. A denied
search clears the group and late results; a temporary
search failure keeps the group on screen.
The default Members tab reads `/api/members?q=&after=&limit=20`. Search starts a new
page, and `next` loads more rows. A request generation drops older successful and
ordinary failed search replies. Any live 401 or 403 clears member and group rows,
closes the tabs and stops later replies from showing names. Member rows are read-only
in this part.
Each member name links to `/org/people/members/<id>`. That page reads the member
first, then `/api/members/<id>/access` only for a full admin detail. A minimal
header never triggers the access read. A refused read clears all detail, including
late replies. A 404 from either read also clears the whole page. Temporary failure keeps
loaded data and offers GET-only retry. Member and access load times stay separate when
only one read succeeds. Grants use three columns on desktop and labelled cards on phones.
Tool explanations are not shown in this part. Screen captures use intercepted reads;
see [the receipt](../../docs/process/screen-p4-3-detail/receipt.md).
The Members read also supplies `permissions.invite`. When true, People & groups shows
Invite people. The drawer checks the email with `/api/invitations/identity`, creates
one invitation command and reads `/api/invitations/:memberId/command-changes/:commandId`
for the link and exact expiry. A lost create reply keeps both random ids in memory and
offers GET-only Check status on the Invitations tab. The tab's list remains unavailable.
No email is sent. The link's join page is separate work. Closing the drawer discards
its draft; access refusal clears it before reading the response body. Late replies
cannot restore it.
`?tab=groups` opens the existing Groups tab, including from group detail pages.
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

The member detail page opens a departure drawer for a non-owner when the detail reply
allows removal. GET `/api/members/:memberId/departure` supplies the reviewed access,
shared work, version-specific routine and connection states, retained history and
`memberSequence`/`reviewRevision`. The review lists organisation and group membership
separately from resource access, and shows any recorded personal computer. The Remove
button requires `complete` and `permissions.remove`, with no unresolved shared work.
POST `/remove` sends only
`commandId`, `expectedSequence` and `reviewRevision`. A lost reply keeps that command id
for GET `/changes/:commandId`; 404 does not permit a second POST. Conflict reads a new
review and uses a new command id for any later removal. Refusal clears all protected
detail. A confirmed removal closes the drawer and replaces the member detail with the
removed outcome. Removal ends access at the saved event; IAM and content progress are
separate. The current status route has no clean-up field, so the outcome says that
computer clean-up has not yet been reported. `npm run visual:screen-p4-3-departure`
captures intercepted desktop and phone states in `docs/process/screen-p4-3-departure`.
The role modal starts from a detail reply with `permissions.changeRole`. It sends
`commandId`, `expectedSequence` and `newRole` to POST `/api/members/:memberId/role`.
After a receipt, GET `/changes/:commandId` checks content and IAM progress. An unknown
reply stays tied to that id and offers GET only. A current result refreshes the member;
a minimal reply clears email, groups and access. A refused read clears the whole page.
`npm run visual:screen-p4-3-role` captures the role states with intercepted replies.
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

`/` checks `/auth/me` and shows the SSO-first card or the current session with a
native sign-out form. A signed-out reply focuses Continue with single sign-on.
The email field is read-only and explained; it has no submit action.
`/signin/handoff` focuses Cancel and announces “Opening single sign-on…” for 2.5 seconds
before opening `/auth/login?returnTo=/`. Cancel returns home and stops the timer.
`/signin/rejected` never reads `/auth/me`. It selects one fixed message from the
reason lookup, focuses the heading and announces one polite status. Sign in again
opens the same handoff. No reason or session value is stored or logged.
The public `opencrane-org` meta tag in `src/index.html` supplies the organisation
name. A non-empty `?invitation=…` shows invitation copy but does not grant membership.
These views use one dog-eared card on the paper page at desktop and 390px widths.

`npm run visual:screen-p4-19-signin` builds the web app and writes twelve
intercepted-reply captures with a [receipt](../../docs/process/screen-p4-19-signin/README.md).
It checks card width and gutters, overflow, 44px controls, focus, Enter/Space Cancel
and the redirect timer. It does not run a dev stack or qualify real sign-in.
The earlier live journey is recorded in [sign-in evidence](../../docs/process/signin-evidence.md).

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

A budget stop row marks only its own turn. A turn that never started ends as stopped.
The notice reads saved stop details once when it appears, when the socket reconnects,
and when the first turn end report arrives. A queued stop has its own time, so an end
report still refreshes a failed or earlier read. Check again is a GET. A failed read
keeps the stop visible;
lost access clears reasons and amounts. A `not_stopped` reply keeps the older generic
notice because the saved row gives no scope or reset. A reset adds a dated line but
never restarts the old turn. `npm run visual:screen-p3-14-stop` captures both widths.

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
the composer. Cards with a turn id lose both decision actions when that turn has a
budget stop. A card cancelled by that stop still shows its review and why it cannot
continue. A separately recorded approval outcome stays visible as its own result.
Enter cannot send a decision. Every participant sees the reviewed fields and
consequence. Only the requester sees Approve and Deny. Other participants see
that the requester must decide. Folded cards show only what the server proves.
A used approval says that its result is unknown. A lost decision reply leads to
one status read. The browser never repeats the POST by itself. A 503 can also
mean the server refused before recording the choice. If a
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

The detail shows Forget only when its current reply has `canForget: true` and the selected
scope is the person's own scope. The review uses `oc-modal-sheet` and contains no fact text.
It sends one `POST /api/memory/:scopeId/facts/:memoryId/forget` with a fresh `mem_` command id
and the current detail revision. An accepted receipt removes the list row and detail text
immediately. It also clears search and stops older list and detail reads. A fresh detail read
that reports a forgotten fact removes its old list row and clears search too. Each selected
fact has its own command and review. A pending outcome for an earlier fact remains available
while another fact is selected. `cleanupStatus` controls the pending, forgotten and unavailable
labels. Pending and unknown outcomes use `GET /api/memory/:scopeId/changes/:commandId`; they
never POST again. Only one status read runs at a time, and a late pending reply cannot replace
a final outcome. Conflict offers one fresh detail read. A 401, 403 or 404 clears protected
state. Late replies after a scope or requester change are ignored. The command remains in component memory
only. Group and assistant-notes forget, edit, unpin and store Undo have no controls here.
`memory-panel-forget.spec.ts` covers the review, one POST, safe outcome and refusals.
`npm run visual:screen-p4-13-forget` captures both widths with intercepted replies;
see [the receipt](../../docs/process/screen-p4-13-forget/receipt.md).

`LiveView.open` obtains admission and loads the viewer. `connectViewer` connects
the socket and lease channel; `startViewer` attaches the desktop display.
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

## Model access editor

Each active registry model and task route opens a shared drawer. It uses the
[model grant API](../../docs/api/providers.md#changing-model-grants) and validates replies
with the shared protocol schemas. One selected row produces one command. Only a proved
pre-append failure offers Try again, with identical bytes. Uncertain outcomes retain
that command in memory across drawer closes and offer GET-only status checks.
Before each POST, sessionStorage keeps one strict record per model with only modelId,
commandId and operation (grant or revoke). Opening Access after reload reads this
reference without a request body, reads access and checks the original command.
Unknown replies, including 404 and 503, cannot offer another save. Bad entries are
dropped; blocked storage does not interrupt the editor. Saved, conflict, no_effect
and proved unavailable replies remove the record. Access loss clears every model record.
Each check makes at most three status reads. Saved waits for content and IAM to be
current and for a fresh grant list. Access refusal clears details and ignores late replies.
Either parent provider or registry GET returning 401/403 clears the page and drawer
immediately, without waiting for the other GET. Both parent and drawer reads are aborted.
The browser checks hold the other parent GET and a candidate GET pending, then release
successful replies after refusal to prove that names and controls cannot return.
Run `npm run visual:screen-p4-22-access -- --check` to check without rewriting captures.
The picker reads 50 candidates of one kind at a time. Load more uses next as after,
keeps existing rows on failure and removes duplicate ids. Switching kind resets paging.
Names never enter storage or addresses.
Configured uses and grant paging are absent from the API, so no Missing rows are inferred.
`npm run visual:screen-p4-22-access` uses intercepted HTTP replies and the web build.

Provider setup keeps one inline editor per selected model. Each editor reports its
model, command, operation, grantee and phase to `ProviderSetupAccess`. Setup keeps
these outcomes in memory only. Chosen assistants stay Missing until Saved. Done
shows provider facts and confirmed grants; the enabled count waits for a current
models_selected receipt at the same provider revision and counts the server's
`enabledModels`, never the draft. A newer provider revision hides the count's tick.
Back to Access keeps the original pending commands. Saved models cannot be unticked;
setup does not offer reviewed removal or rely on a failed or unsupported use inventory.
A model with an applying or unknown grant cannot be unticked either. These grants
block closing setup, including Escape and the footer buttons, until status resolves.
Access loss still clears protected content immediately.
The step markers show navigation, not successful saves. No overall completion is claimed.
`npm run visual:screen-p4-22-setup-access` uses intercepted replies.
The [setup receipt](../../docs/process/screen-p4-22-setup-access/receipt.md) records its limits.

## Models table

The table joins active registry ids and task routes with enabled OpenAI connections.
It reads one access list per enabled model, bindings only for connections that enable
one, and shared names from `/api/assistants`. A current, complete grant list permits a
missing assistant-grant warning. An applying list says Still updating. The bindings
reply counts personal assistants as well as shared ones. When that count differs from the
assistants the page can check, it says Assistant access not checked. Failed reads keep
the same unchecked status.
The table clears on any 401 or 403 and ignores pending replies. A failed parent refresh
keeps dated rows and locks provider actions. Closing Access rereads that model's list.
`npm run visual:screen-p4-22-tables` captures the table states at both widths.
The [receipt](../../docs/process/screen-p4-22-tables/receipt.md) records visual limits.

The existing screen receipt records its limits.
Adding `-- --part2` writes only the new paging and reload captures.
The [original screen receipt](../../docs/process/screen-p4-22-access/receipt.md) and
[reload and paging receipt](../../docs/process/screen-p4-22-access2/receipt.md) record the limits.
