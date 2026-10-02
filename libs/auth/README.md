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
Pass the encrypted session’s `idToken` to `buildLogoutUrl` for RP-initiated logout.
The server uses that URL only in a 303 `Location` header after a native form POST;
never return it in JSON or expose it to page JavaScript or logs.
Zitadel ends all accounts in the current browser, not just the hinted account.
Older sessions without a token and provider discovery failures yield `null`.
The server requires the exact Origin and a valid, correctly pinned session before
clearing its cookie. `/auth/me` exposes only public identity fields.

## Configuration and verification

The [configuration source](src/config.ts) owns variable names, required settings and defaults.
Defaults include secure cookies, a 12-hour session, five-minute step-up freshness,
`oc_session`/`oc_auth_flow`, `openid profile email`, and `org_id`/`roles` claims.
Zitadel needs its provider-specific claim names and matching scopes.
Production requires an organisation pin. Keep the cookie key in the secret store;
`OIDC_CLIENT_SECRET_ENV_VAR` names the variable through which a client secret is injected.
`OIDC_EXTRA_IDENTITIES` is an environment-specific JSON array of `{ "issuer", "subject" }`
objects and defaults to empty. An entry bypasses only the organisation mismatch: the
token must still be signed by the configured issuer, and both strings must match exactly.
Never put email addresses, usernames or roles in this list. Servers must use
`isIdentityAllowed` when rechecking an encrypted session as well as at callback time.
Insecure HTTP and non-secure cookies expose credentials and are only for local tests.

```sh
npm test -- libs/auth
npm run typecheck -w libs/auth
```

Tests exercise cookies, expiry, malformed config, PKCE, exact issuer/subject exceptions
and cross-organisation refusal
against a disposable loopback provider. The [dev-stack journey](../../infra/dev-stack/README.md) also exercises real Zitadel,
including logout, a mismatched organisation pin and a short-lived session.
There is no database state to replay here; rotating the cookie key invalidates old cookies.
Runtime dependencies are jose, openid-client, Zod and the event-store contract. See the [plan](../../plan.md) for
identity boundaries and [server](../../apps/server/README.md) for the logout response contract.

## Computer and turn credentials

`tokenIssuer` signs ES256 computer grants (10 minutes) and turn grants (2 minutes).
It exports public `jwks`; `tokenVerifier(jwks, issuer)` applies the same strict
signature, audience and lifetime checks without loading a private key.
`computerCredentials(store, tokens, silo)` issues a turn for a Ready computer and
checks both headers against its event-backed assistant, computer id, generation
and rotated token id. The signed `thread` must match the actual Codex `session-id`;
`conversation`, `requester`, `task` and allowed `model` are also signed. Issuance
requires `threadId`, `task` and the model chosen by the server from its routing
table. Model admission refuses a request whose model differs from the grant.
An optional active turn token id further narrows `check`; model admission
reads only server-owned `computer.turn_started` / `computer.turn_closed` authority
and checks live permissions before reserving money. A closed turn cannot reopen.
Old readiness events without a generation fail closed until the reconciler observes
and records readiness again. Token values never enter events or projections.
