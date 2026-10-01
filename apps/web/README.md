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
[proxy.conf.json](proxy.conf.json) forwards `/auth` and `/ws` to port 8080.
Configure the provider callback and server `OIDC_REDIRECT_URI` for the browser origin,
including `/auth/callback`. Local HTTP development requires local-only cookie settings
as described in the [server README](../server/README.md).
The browser uses same-origin auth and WebSocket URLs; no credentials are built into assets.

## Contract and verification

The client validates the register response and incoming messages with
[protocol](../../libs/protocol/README.md).
Register refresh failures keep old rows and their load time visible. A retry replaces
the notice in place. Non-admins see that the Owner or Admin role is required. Adding an
MCP server is explicitly unavailable; no setup flow or mutation is simulated.
Socket closure updates state and schedules reconnect with jitter;
there is no durable outgoing message queue. Logout posts to the server, then follows
a validated provider URL when available or returns home. Page navigation ends the
current socket; the shell does not explicitly disconnect it first. The server checks
the session and Origin on every WebSocket upgrade.

```sh
npm run typecheck -w apps/web
npm run build -w apps/web
npm run test -w apps/web
npm test -- apps/web/test
```

The Angular suite covers components, messages and reconnect timing; the root suite
checks theme contracts. Both suites are needed. A real provider/browser journey on a
fresh silo is not qualified by these tests.
The build produces static assets in `apps/web/dist/web/browser`; serve them with
same-origin `/auth` and `/ws` routing and TLS in a deployment. The app needs no server
filesystem or database permission. Reload discards local UI state and reconnects;
durable history and event replay belong to the future server implementation.

Dependencies are Angular, RxJS, tslib, the shared protocol schemas and self-hosted
DM Sans/DM Mono font files from Fontsource (OFL-1.1). Playwright is build-time only.
See the [repository architecture](../../README.md) and [plan](../../plan.md).
