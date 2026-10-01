# Web

This Angular shell shows connection state, signs users in and out, and opens the
authenticated WebSocket. Its socket service can send typed messages, but the current
shell has no message input or send control. The [server](../server/README.md) owns
sessions; this package owns presentation and reconnect state, not business truth.
Chat history, uploads and assistant work are unfinished.

## Entrypoint and usage

[src/main.ts](src/main.ts) bootstraps the standalone application.
From the repository root, with the server configured and running:

```sh
npm run dev -w apps/web
```

Open `http://localhost:4200` and use Sign in. The shell then shows the socket's
connection state.
[proxy.conf.json](proxy.conf.json) forwards `/auth` and `/ws` to port 8080.
Configure the provider callback and server `OIDC_REDIRECT_URI` for the browser origin,
including `/auth/callback`. Local HTTP development requires local-only cookie settings
as described in the [server README](../server/README.md).
The browser uses same-origin auth and WebSocket URLs; no credentials are built into assets.

## Contract and verification

The client validates incoming messages with [protocol](../../libs/protocol/README.md).
Socket closure updates the visible state and schedules reconnect with jitter;
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

Dependencies are Angular, RxJS, tslib and the shared protocol schemas.
See the [repository architecture](../../README.md) and [plan](../../plan.md).
