# Auth

For people, read [README.md](README.md) first.

Auth provides OIDC login/logout, encrypted session and login-flow cookies, and
step-up freshness checks for the [server](../../apps/server/README.md). It also signs
and checks short-lived computer and chat-turn passes. It does not grant product
permissions or store membership projections.

The OIDC flow was adapted from OpenCrane 1's Express auth library for Fastify. The
current library keeps the sign-in and pass functions used by the server and workers.

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
requires a server-owned first `computer.turn_started` and refuses a
`computer.turn_closed` from any source
and checks live permissions before reserving money. A closed turn cannot reopen.
`check(headers, activeTurnId, deadline)` also accepts an absolute `performance.now()`
deadline so its event reads stop retrying with the caller's authority check.
Old readiness events without a generation fail closed until the reconciler observes
and records readiness again. Token values never enter events or projections.

## Computer summary

`computerSummary` is the shared `SummaryKind<ComputerSummary>` used by credentials
and server turn commands. The event store keeps up to 64 computers per store
connection. Each use reads new events before copying facts; a dropped summary
rebuilds from the first event. Credentials use the caller's deadline, or `Infinity`
for issuance. They still check every assistant id, computer id, generation and token id.
A suspension, loss or rotated grant saved through another connection affects the
next check. A wrong silo keeps the existing `Computer silo mismatch` error.

The summary stores the newest non-turn lifecycle row, newest claim and newest
claim or resume grant. An open turn keeps its first start, newest start execution
mode and start command keys. Its first close replaces those fields with `hasStart`
and the close's position and status. A later start still sets `hasStart`.
Each thread keeps at most two owners, started turn ids and restricted turn ids.
Two distinct values always answer whether any value differs from the one checked.
Callers copy needed facts in `take`; they never keep the mutable summary itself.

`test/computer-summary.test.ts` checks rebuilding at five cuts, first and newest
facts, compact closed turns, bounded thread sets and checking before changes.
`test/computer-summary-memory.test.ts` checks oversized turn/thread maps and
open start-command keys, including correct old facts after rebuilding.
`test/credentials.test.ts` checks warm reads on 500 earlier turns and suspension
through another store connection. The gateway credentials test in `apps/ops`
also covers races, expiry, resume, loss and generation changes.

The computer kind also limits all retained turn entries, thread entries and open
start-command keys to 30,000 facts per store connection. Counts are updated as
events are added, so checking the budget does not scan the turn history. Least recently
used summaries are dropped whole. A dropped computer rebuilds from the first
event; its old closed turns and thread owners cannot be forgotten. An individual
computer above the entire budget is not retained after use. Catch-ups and caller
copies can temporarily exceed the retained budget. More busy computers than the
cache holds can cause repeated rebuilds and refusals within the decision limit.

Turn data uses the full `computerTurnStartedDataSchema` and
`computerTurnClosedDataSchema` from `@opencrane/events`, including the close status
type. Auth depends on this existing local event package; it adds no third-party
runtime component.

The server and models processes must restart after an event-store restore before
serving requests. Without that restart, the computer summary can skip a suspension
or loss saved at a position reused after the restore, and keep that computer allowed.
The restore drill must check the restarts as well as projection rebuilding.

### Computer summary memory measurement

The synthetic reader in `libs/models/test/summary-memory.ts` creates rows on demand
and releases them after use. Node runs with `--expose-gc` and a 256 MiB heap cap.
It measures collected heap before and after releasing the store, so loaded packages
are outside the retained-cache figure. `unbounded` disables only the fact budget
for comparison; the 64-computer count limit still applies.

| Shape | Retained cache bytes | Total heap bytes |
| --- | ---: | ---: |
| One computer, 10,000 closed turns, one thread per turn, no fact budget | 8,519,632 | 42,032,272 |
| One computer, 10,000 closed turns, five turns per thread, no fact budget | 3,391,952 | 36,907,984 |
| One computer, 1,000 chats with 200 closed turns each, no fact budget | 41,559,032 | 70,940,864 |
| 64 computers, 10,000 closed turns each, one thread per turn, budget enabled | 8,640,680 | 35,901,344 |
| 64 computers, 10,000 closed turns each, five turns per thread, budget enabled | 6,636,376 | 33,895,312 |
| One computer, 1,000 chats with 200 closed turns each, budget enabled | 3,032 | 28,371,752 |

The first two rows imply about 211 bytes per closed turn and 641 bytes per thread
in this fixture. String lengths and V8 versions change those costs. The last row
has no retained computer summary: its 201,000 facts exceed the budget, and its
next read starts at sequence 1. The remaining bytes are cache bookkeeping.
This is a retained-cache measurement, not a complete running service or peak heap.

A repeatable command from the repository root is:

```sh
nice -n 10 npm run measure:summaries:memory -w libs/models -- computer 64 10000 1
```

The last argument is turns per thread. Add `unbounded` to compare without the fact
budget. Use `computer 1 200000 200` for the 1,000-chat shape.
