# Server

The Node service exposes sign-in routes, a health check and an authenticated WebSocket
skeleton. It does not serve static files: `GET /` returns 404. The [web app](../web/README.md)
is built and served separately; during development Angular's server runs on port 4200 and
proxies `/auth` and `/ws` here on port 8080. Event persistence, projections and business
commands are not implemented here. No business state is stored by this skeleton.

## Entrypoint and operation

[main.ts](src/main.ts) starts Fastify and attaches `/ws`. From the repository root:

```sh
npm start -w apps/server
curl --fail http://localhost:8080/healthz
```

Provision OIDC settings first; startup rejects missing or invalid configuration.
Required: `OIDC_ISSUER_URL`, `OIDC_CLIENT_ID`, `OIDC_REDIRECT_URI` and
`OIDC_COOKIE_SECRET` (at least 32 bytes, injected from the secret store).
Production also requires `OIDC_EXPECTED_ORG_ID`. The callback is `/auth/callback`.
See [auth configuration and defaults](../../libs/auth/src/config.ts), including
client-secret indirection, scopes, cookie settings and provider claim names.
`HOST` defaults to `0.0.0.0`, `PORT` to `8080`, `LOG_LEVEL` to `info`.
`OTEL_EXPORTER_OTLP_ENDPOINT` enables optional trace export when set.
Disabling secure cookies or allowing insecure OIDC HTTP is only for local testing.

## Contract and verification

`GET /auth/login` redirects to the provider; `GET /auth/me` reports the session.
`POST /auth/logout` clears the local cookie and returns a validated provider logout URL or `null`.
Invalid callbacks return 400; `/ws` upgrades require a valid cookie and matching Origin.
The socket echoes `hello` and validates events; it never appends them.
See [protocol schemas](../../libs/protocol/README.md) for real request examples.

```sh
npm test -- apps/server
npm run typecheck -w apps/server
```

Tests include real Node startup, a loopback OIDC provider, refused upgrades and redaction.
A deployed fresh-install sign-in journey remains unqualified by these local tests.
The process needs a listening port and outbound access to its OIDC provider and optional
collector; it needs no database permissions. Restart discards connections; clients reconnect.
Cookies survive only while their signing/encryption configuration and expiry remain valid.
Business recovery and replay belong to the future event core.

Dependencies: Fastify, ws, and the [auth](../../libs/auth/README.md),
[events](../../libs/events/README.md), [observability](../../libs/observability/README.md)
and protocol packages. See the [architecture and plan](../../plan.md).
