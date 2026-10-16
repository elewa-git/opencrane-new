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
`OIDC_EXTRA_IDENTITIES` is a development and test JSON array of `{ "issuer", "subject" }`
objects and defaults to empty. Production startup refuses the variable whenever it is
set, including an empty string or empty array. Production detection ignores case and
surrounding spaces in `NODE_ENV`, as it does for `OIDC_EXPECTED_ORG_ID`.
An entry bypasses only the organisation mismatch: the
token must still be signed by the configured issuer, and both strings must match exactly.
Never put email addresses, usernames or roles in this list. Sign-in uses
`isIdentityAllowed`. Server session routes use `isOrganisationSession`, which also
refuses access when no organisation is configured. The first-owner claim still
requires the installation's own organisation, even in development.
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
Shared child passes also sign `sharingClass: shared_only` separately from the
restricted execution mode. The issuer validates this optional claim before signing;
unknown values are refused. Initial and renewed passes use the same issuer.
`libs/models/test/shared-child-credentials.test.ts` exercises signing, verification,
model calls and MCP/memory refusal for both passes with real service fixtures.
The models process compares it with the saved computer
start before allowing a call, and refuses shared turns on MCP and memory routes.
An optional active turn token id further narrows `check`; model admission
requires a server-owned first `computer.turn_started` and refuses a
`computer.turn_closed` from any source
and checks live permissions before reserving money. A closed turn cannot reopen.
`check(headers, activeTurnId, deadline)` also accepts an absolute `performance.now()`
deadline so its event reads stop retrying with the caller's authority check.
Old readiness events without a generation fail closed until the reconciler observes
and records readiness again. Token values never enter events or projections.

## Computer summary

Native descendant start/close records parse but do not enter the authority summary's
turn or thread maps. `computerCredentials.turn` refuses `task: native_descendant`
before issuance. This keeps saved delegation records separate from executable chat turns.

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

The computer kind has a 48 MiB estimated memory budget per store connection.
It counts 256 bytes per turn, 768 per thread and 2,048 per open start-command key.
The extra allowance for open keys covers the first saved start event as well as
its command key. The closed-turn and thread estimates leave room above the
UUID measurements below. Counts are updated as events arrive, so checking the
budget does not scan old turns. A 10,000-turn team assistant with one private
thread per turn uses about 9.8 MiB of this allowance. Four fit together.

Least recently used summaries are dropped whole. A dropped computer rebuilds
from the first event; old closed turns and thread owners cannot be forgotten.
A computer above the entire budget is dropped on its own. Other computers stay
warm. Catch-ups and caller copies can temporarily exceed the retained budget.
More active computers than fit can still cause rebuilds and decision refusals.

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
and releases them after use. Ids are 36-character UUIDs. Events include request,
conversation and turn correlation ids. Strings are copied as they would be when
decoding a saved event. Node 22.23.3 runs with `--expose-gc` and a 256 MiB heap cap.
Collected heap before and after releasing the store gives the retained-cache
figure, excluding loaded packages. Heap is sampled every 100 rows and at the end
of the read. The sampled peak covers the build before the final repeat read;
it can miss shorter peaks. `unbounded` disables only the memory budget.

| Shape | Retained cache bytes | Total heap bytes | Sampled peak heap bytes |
| --- | ---: | ---: | ---: |
| One computer, 10,000 closed turns, one thread per turn, unbounded | 9,159,728 | 42,820,736 | 58,870,208 |
| One computer, 10,000 closed turns, five turns per thread, unbounded | 3,510,320 | 37,166,456 | 53,586,240 |
| One computer, 10,000 open private turns, budget enabled | 23,962,760 | 57,500,160 | 67,411,984 |
| Three computers, 10,000 private turns each, budget enabled | 27,479,448 | 61,142,320 | 77,451,912 |
| One oversized computer, 60,000 private turns, budget enabled | 5,272 | 27,412,912 | 107,849,752 |

The first two rows imply about 210 bytes per closed turn and 706 bytes per thread.
String lengths and V8 versions change those costs. The last row keeps no computer
summary: its estimate exceeds 48 MiB, and its next read starts at sequence 1.
The remaining bytes are cache bookkeeping. The sampled peak includes the complete
oversized summary before it is dropped. These measurements cover one kind at a
time, not a live service or simultaneous rebuilds.
The open-turn measurement includes saved first starts and command keys; its
estimated allowance is 30,720,000 bytes, above the 23,962,760 bytes retained.

A repeatable command from the repository root is:

```sh
nice -n 10 npm run measure:summaries:memory -w libs/models -- computer 3 10000 1
```

The last argument is turns per thread. Add `unbounded` to compare without the
memory budget. Use `computer 1 60000 1` for the oversized rebuild.
Use `computer-open 1 10000 1` to keep every turn open.

## Sign-in email claims

`completeLogin` copies the signed ID token's string `email` into the encrypted
session, with a maximum of 320 characters. `emailVerified` is true only for the boolean claim `email_verified=true`;
missing, string or false values become false. Both session fields are optional
so older cookies still decode. No request body supplies these claims.
`test/oidc-client.test.ts` checks them through the loopback provider and a cookie
round trip. The server uses them for fresh bound-invitation acceptance.

Invitation acceptance depends on the
[Zitadel deployment requirements](../../docs/api/members.md#zitadel-deployment-requirements):
self-registration off in the silo's organisation, no external identity providers
that assert verified emails, only trusted admins setting verified emails, and
`idTokenUserinfoAssertion=true` on the app. Emails are not unique in Zitadel.
The server limits the complete session cookie header to 3,800 bytes and refuses
larger sign-in sessions with a clear error.

`tokenIssuer.memoryContext(payload, expiresAt)` signs ES256 passes for `memory-mcp`.
Expiry is the earlier of the supplied deadline and two seconds from issuance.
The memory server checks claims and lifetime separately from computer/turn credentials.

## Signed provider choice

Turn issuance accepts optional `providerId` and `bindingSequence` together.
`computerCredentials.turn` compares them, the model and task with the first saved
start of that turn before signing. A missing or different choice is refused.
`tokenIssuer.turn` validates the pair and signs both claims; it never signs a
provider configuration revision. Legacy turns remain valid without these claims.

`test/provider-turn-validation.test.ts` checks provider-id syntax and length,
fractional binding positions and positions above the safe integer limit at signing.
These tests call the signer directly, so a recorded-turn comparison cannot hide a
missing input check.

## Computer control summary

`ComputerSummary.control` is separate from `lifecycle`, `claim` and `grant`.
`takeover.requested` records requested phase, command id, position, requester,
computer/generation/Pod, lease reference, affected turns and requested time.
`readComputerControl` returns a copy after catching up with saved events. It is
an internal reader; callers must check access before exposing any private fields.
Generation replacement preserves control until a later checked recovery contract.
Old `takeover.started` and `takeover.ended` shapes become unverified control and
refuse work passes. Neither shape restores work or grants a writer.

## Signed takeover gates

`tokenIssuer.takeoverGate` signs ES256 with `kid: lifecycle`, payload
`typ: takeover-gate`, audience `takeover-gate` and a thirty-second lifetime.
Its input names `silo`, `computer`, `assistant`, `generation`, `podUid`,
`takeoverId` and `affectedTurnIds`. The gateway and decision-service audiences
refuse it. Only trusted server code may call this signer after saving intent;
there is no server caller or delivery path yet. Token values must never enter
logs, errors, events, receipts or API responses. `test/tokens.test.ts` checks
the signature, claims, expiry and audience separation with a real issuer key.

## Saved budget admission refusals

The computer summary retains a chat close's optional `budgetStopId`. The server
uses it to finish recording a refused start after a lost connection, even if the
ceiling has since risen. The field grants no pass and cannot reopen a closed turn.
