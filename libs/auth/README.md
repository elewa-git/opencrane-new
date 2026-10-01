# Auth

Auth provides OIDC login/logout, encrypted session and login-flow cookies, and
step-up freshness checks for the [server](../../apps/server/README.md).
It does not grant product permissions or store membership projections.

## Public contract

Import `@opencrane/auth`; [src/index.ts](src/index.ts) is the public entrypoint.
`@opencrane/auth/testing` exposes the loopback provider used by server contract tests.
From the repository root, this example demonstrates same-origin return-path handling:

```sh
node --experimental-strip-types --input-type=module -e "import { sanitizeReturnTo } from '@opencrane/auth'; console.log(sanitizeReturnTo('https://untrusted.example/'))"
```

It prints `/`. Callers must load validated settings with `loadAuthConfig`, preserve the
flow cookie through callback, and check session expiry and operation authority.
Use `hasRecentAuth` for freshness based on the provider's `auth_time`, not login time.
The provider verifies PKCE, state and nonce through openid-client.
`SessionInvalidError`, `SessionExpiredError`, `FlowInvalidError` and `OidcLoginError`
identify rejected data. Configuration errors stop startup; callers sanitise public errors.
Provider logout discovery failure can yield `null`; local logout must still clear cookies.

## Configuration and verification

The [configuration source](src/config.ts) owns variable names, required settings and defaults.
Defaults include secure cookies, a 12-hour session, five-minute step-up freshness,
`oc_session`/`oc_auth_flow`, `openid profile email`, and `org_id`/`roles` claims.
Zitadel needs its provider-specific claim names and matching scopes.
Production requires an organisation pin. Keep the cookie key in the secret store;
`OIDC_CLIENT_SECRET_ENV_VAR` names the variable through which a client secret is injected.
Insecure HTTP and non-secure cookies expose credentials and are only for local tests.

```sh
npm test -- libs/auth
npm run typecheck -w libs/auth
```

Tests exercise cookies, expiry, malformed config, PKCE and cross-organisation refusal
against a disposable loopback provider. Real Zitadel and fresh-silo journeys remain unqualified.
There is no database state to replay here; rotating the cookie key invalidates old cookies.
Runtime dependencies are openid-client and Zod. See the [plan](../../plan.md) for
identity boundaries and [protocol](../protocol/README.md) for the logout response contract.
