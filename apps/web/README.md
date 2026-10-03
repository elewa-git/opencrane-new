# Web

This Angular app provides the organisation settings shell and MCP register. It opens
the existing authenticated WebSocket, but the [server](../server/README.md) owns
sessions and all register truth. The browser retains the last successful register
read only while the page remains open.

## Entrypoint and usage

[src/main.ts](src/main.ts) bootstraps the standalone application.
From the repository root, with the server configured and running:

```sh
npm run dev -w apps/web
```

Open `http://localhost:4200/org/integrations`. The shell shows only Integrations:
Overview, Models & providers, Skills & workflows, People & groups and Change history
are not built and therefore are not navigation links. `/org/states` renders the shared
nine-state vocabulary for development and visual checks, but is not a destination.
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
Register refresh failures keep old rows and their load time visible. The always-available
refresh button stays in place and keeps keyboard focus while retrying. Non-admins see that the Owner or Admin role is required. Adding an
MCP server is explicitly unavailable; no setup flow or mutation is simulated.
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
`/signin/handoff` focuses Cancel and announces a five-second countdown before
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

P3-1 adds Tools & access at `/org/integrations/:serverId/tools`, linked from the
existing register. Native radio groups offer Allow automatically, Ask and Block
for reads and writes. Pending saves disable edits; uncertain replies require Check
status; 401/403 clears protected tool details. Desktop and 390px browser evidence
comes from `apps/server/test/integrations.test.ts` with real API dependencies.

`/org/models` is the Owner/Admin Models & budgets screen. It displays global and
configured paying-group/assistant monthly ceilings, current charges and held
reservations, and edits safe integer EUR cents. Conflicts or an unknown save
outcome require a status read before another edit; access loss clears the details.
The authenticated browser journey covers 1280px and 390px.

The chat's 8g approval cards restore from the authenticated approval endpoint above
the composer. Requested cards show every reviewed field, expiry and conditional
sign-in; decided, expired, cancelled and consumed cards collapse. A consumed card
says outcome unknown, not success. Submitting disables both actions; uncertain
transport offers Check status before any safe retry. No arguments or authority are
sent back by the browser. Polling every three seconds restores updates without
introducing another business-state store. Chromium qualification and images are in
[the P3-2 receipt](../../docs/process/p3-2-approvals.md).
