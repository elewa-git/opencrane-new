# P2-4 model gateway evidence

2 October 2026, branch `work/models`. The sections below through “Review fixes”
record the original P2-4 qualification before the lifecycle rebase. The final
integration receipt records the current source, stub-only journeys and restoration.
No push or merge was performed.

## Real call — PASS

Exactly one OpenAI Responses call through checksum-pinned agentgateway v1.5.0,
with the real decision service, NATS reservation and PostgreSQL handler runtime:

| Model | Input tokens | Output tokens | Reserved cents | Settled cents |
| --- | --- | --- | --- | --- |
| `gpt-5-nano` | 9 | 19 | 2 | 1 |

Prompt: `Say OK.` Output bound: 128 tokens; minimal reasoning. The gateway's
streamed usage log supplied both counts, joined to reservation
`5de71f3a-5bb3-45d0-8134-936bd9c170bd`. The unused 1 cent was released.
The provider key was read only by agentgateway's native file secret loader
from `.keys/.openai-key`. It was never read by the runner, printed, placed in
arguments/events, or sent to a computer. Raw gateway output is discarded;
the durable log filter permits only UUIDs and whole token counts. Stub evidence
also compares the injected credential hash and proves identity-header removal.
The receipt is retained locally at `.tools/models-real-receipt.json`.

## Repeatable real-service tests

`libs/models/test/gateway.test.ts` uses real NATS, PostgreSQL 17, OpenFGA,
agentgateway v1.5.0 and a scripted Responses SSE provider. The control database
is `PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres`; fixtures create
and remove their own databases, ports, keys, logs and service instances.

- Streamed 1,000 input / 120 output tokens settle exactly to 1 cent; unused
  reservation is released. Dropping/replaying the projection restores it.
- Cross-thread, expired computer/turn, forged and cross-silo tokens never reach
  the provider. Malformed bounds, unknown models, hosted tools, premium tiers,
  media, stored history, multiple completions and duplicate keys are refused.
- Live membership revocation, OpenFGA outage and decision-service outage fail
  closed. The stub sees the gateway credential, never computer/turn tokens.
- Eight concurrent calls compete for the last reservation; exactly one reaches
  the provider. Separate daily and monthly tiny caps refuse the next call with
  a clear spending-cap message.
- Killing/restarting agentgateway during a held provider stream leaves the
  reservation charged. Timeout emits `effect.uncertain`; actor recovery and
  PostgreSQL replay retain the reservation. The replacement fences the old actor.
- A failed settlement append from a stale actor leaves money reserved. A new
  actor settles the recorded observation; replaying it cannot charge twice.
- UTC day/month rollover clears settled period totals without dropping pending
  reservations. Those still prevent a new call.
- `apps/server/test/integrations.test.ts` checks `/api/org/models`: owners/admins
  can read the registry and caps; members, unknown people, missing sessions and
  another organisation cannot.

## Gates

| Gate | Result |
| --- | --- |
| `npm run lint` | PASS; two existing function-length warnings |
| `npm run typecheck` | PASS, all workspaces |
| `npm run check:events` | PASS, 70 event types and handler subscriptions |
| `npm test` | PASS, 49 files; 890 passed, 1 skipped (the opt-in real call) |
| Web build | PASS; existing CSS size warning |
| Web tests | PASS, 3 files / 36 tests |
| Dev-stack TypeScript check | PASS |

The first full suite found the new table-reference name lacked its `Id` suffix
and the credential-name guard did not yet recognise integer usage counts. Both
were fixed; explicit string/fraction/negative-count rejection checks were added.
The final full run passed in 109 seconds. The real call ran separately once,
passing in 12 seconds; it was not repeated during the gates.

## Qualification limits

Dev-stack integration, k3d relay reachability, computer/Codex chat integration,
a fresh silo installation, production HA/credential rotation and independent
review: **NOT RUN**. The supplied k3d manifest was not applied. Group/delegated
model access, media, hosted tools, price administration and manual uncertain-effect
resolution remain outside Phase 2. Budget reservations are not auto-refunded.

## Review fixes — 2 October 2026

Source: `2657b24` plus this review-fix commit on `work/models`; Linux, Node
22.23.3, disposable NATS/OpenFGA/gateway instances and PostgreSQL databases.
The running dev stack was not changed or restarted. `MODELS_REAL_CALL=0`
explicitly disabled real provider calls throughout these checks.

Each blocker first failed at its public boundary, then passed after the fix:

| Blocker | Red evidence | Passing regression |
| --- | --- | --- |
| Stale lifecycle | B's generation-2 token received 200 after A's delayed ready event | 403 with no reservation/provider call; ready/resumed also reject stale or missing generation and accept the matching live generation |
| Observed rejection | Provider 400 never settled its reservation | 400/401/404/429/500 record an error observation, settle at zero cents, and leave cap available; 408/504/lost connections remain uncertain |
| Issuer JWKS | Actual issuer JWKS failed with unrecognised `alg`/`use` | Startup reaches gateway binary verification; private keys, wrong algorithm/curve/type/use fail before budget startup |
| Two-stream cap refusal | Security outage returned 503; after dropping that append, retry duplicated exhaustion | Only one durable exhaustion event; no security event; lost append acknowledgement and actor recovery do not duplicate exhaustion |

The startup test deliberately supplies an untrusted gateway binary and stops at
its digest check, before loading provider credentials. It fetches public JWKS
from the actual S0.1c issuer code, rather than hand-building a narrower key.
Lifecycle generation remains optional in the event schema for historical replay;
authorisation requires it. Cap exhaustion is recorded once per unchanged budget
per UTC day, including across leadership changes.

| Fix gate | Result |
| --- | --- |
| `npm run lint` | PASS; two existing function-length warnings |
| `npm run typecheck` | PASS, all workspaces; initial JWK optional-property typing failure fixed with ES256/signing defaults |
| `npm run check:events` | PASS, 70 event types |
| `MODELS_REAL_CALL=0 PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres npm test` | PASS, 50 files, 909 passed / 1 skipped, 159 seconds; no load-related timeouts |
| `npm run build -w apps/web` | PASS; existing CSS size warning |
| `npm run test -w apps/web` | PASS, 3 files / 36 tests |

Real OpenAI calls, running-stack integration/restart, fresh-install qualification,
production HA/credential rotation, hosted CI and a second independent review:
**NOT RUN** in this fix task. Nothing was pushed or merged.

## Lifecycle integration — 2 October 2026

Source: `work/models`, rebased from `c869499` onto lifecycle main `f5c4eef`;
rebased parent `441f82f`, plus the integration commit containing this receipt.
Environment: `ocn-dev`, Node 22.23.3, local PostgreSQL 17/NATS/OpenFGA,
k3d Agent Sandbox/gVisor and agentgateway 1.5.0. This task made **no real
OpenAI call**; `MODELS_REAL_CALL=0` and the stack's explicit loopback SSE provider
keep both test paths off paid upstreams.

### Wiring and regression evidence

The former ops `computerCredentials` implementation now lives in `libs/auth`.
Lifecycle delivery, turn issuance and model admission share ES256 audiences,
issuer and strict lifetime checks. The decision process receives only the public
JWKS derived from the lifecycle signing key. Admission reads the current claim,
rotated token id, computer id/generation and matching Ready event from NATS,
then checks the conversation, active turn, personal ownership and live membership
before reserving integer cents. `session-id` binds the conversation.

- **RED → GREEN:** real lifecycle credentials initially received 401 at the
  spike-configured gateway. They now receive a completed stub response.
- **PASS:** expired computer/turn, suspended, pre-resume, pre-loss, wrong computer
  and wrong/missing generation credentials leave the budget stream unchanged.
- **RED → GREEN:** review reproduced failure after a legacy resume without a
  generation and a newly observed Ready event. The shared check now inherits that
  legacy grant's claim generation while retaining explicit signed/Ready matching.
- **PASS:** a temporary untrusted veth/network namespace could not reach port
  43000 over IPv4 or IPv6; loopback reached its 401 JWT gate. The real computer
  reached the gateway through the separately namespaced k3d relay. Startup
  installs the port firewall before launching agentgateway; shutdown removes it
  after stopping the process.

The first combined server fixture exceeded its old ten-second setup deadline
while provisioning real services. Its bound is now thirty seconds. Two fresh
attempts failed during browser login probes; neither is recorded as a passing
fresh run. The complete diagnostic journey passed between those attempts.
The final fresh and repeat runs completed after the competing checks stopped.
Both model reservations also reached `budget.settled` through the combined
dispatcher. Final repeatable receipts follow below.

### Final qualification

| Check | Result |
| --- | --- |
| `lint`, `typecheck`, `check:events`, dev-stack TypeScript | PASS; 70 event types; three existing lint warnings |
| `PG_TEST_URL=… LIFECYCLE_K3D=1 MODELS_REAL_CALL=0 npm test` | PASS; 53 files, 922 passed, 1 real-call skip; 176 seconds |
| Web production build | PASS; existing CSS size warning |
| `npm run test -w apps/web -- --watch=false` | PASS; 4 files, 41 tests |
| Models `up.sh --fresh` | PASS; join→Ready 12,348 ms, resume 8,415 ms; model stub, replacement/disk and browser journey passed |
| Models plain `up.sh` | PASS; join→Ready 236 ms, resume 6,569 ms; all browser/model/lifecycle/replay checks repeated |
| Restore main stack and ownership marker | PASS on main `92bff32`: fresh startup, then plain startup; services left running |
| Independent review | PASS; one compatibility blocker reproduced and fixed, second pass verified strict refusals |

Main advanced to `92bff32` (#37) during qualification. The model branch remains
rebased onto the requested lifecycle main `f5c4eef`; restoration uses the owner’s
current main code. Its older event catalogue cannot replay the new model fields,
so restoration uses fresh disposable data. The private model usage receipt was
retained outside the stack directory before cleanup; the extra relay namespace
and model firewall/listeners were removed. Retained Zitadel file hashes matched
before and after restoration. Main’s first extra repeat journey hit a WebSocket
join timeout while its services remained healthy; the retry passed every check.

Zitadel access stayed within organisation `393311211338337681`; its retained
files are excluded from every fresh cleanup. The model stub uses a placeholder
credential, never `.keys/.openai-key`. No secrets were printed, and no push or
merge was performed.

**NOT RUN:** real OpenAI calls in this integration task, hosted CI, production HA
and signing-key rotation, the complete Codex/chat product journey, group/delegated
model access and full conversation OpenFGA projection. The latter remains an
existing unimplemented reaction that retries on `conversation.created`; this
personal-assistant decision path enforces ownership directly from events and
live membership. This receipt qualifies the requested lifecycle-to-model path,
not the complete Phase 2 product.
