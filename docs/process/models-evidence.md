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

## All models and task routing — 2 October 2026

Source: `work/bridge`, parent `d024a38`, plus the commit containing this receipt.
Owner decision: “allow all models but keep optimising. Choosing the right tool
for the job is more important than cost.” Node **22.23.3**, PostgreSQL 17,
disposable NATS/OpenFGA/agentgateway 1.5.0 fixtures. The shared dev stack was
neither restarted nor modified. No third-party dependency was added.

### Contract and test evidence

The eleven requested models share one pinned price registry, with integer euro
cents per billion tokens at the existing EUR 95/100 USD planning FX. Nano and
mini are refused. The [official pricing](https://developers.openai.com/api/docs/pricing)
sets short context at **≤272,000 input tokens** and long context at **>272,000**;
long rates apply to the whole call. The registry retains every requested input,
cached-input, cache-write and output rate, with `null` for unavailable rates.
BigInt settlement rounds up once per call, including reported cached usage.

The explicit task table follows [OpenAI's guidance](https://developers.openai.com/api/docs/guides/model-selection):
chat turns use 6.1 Sol, demanding work Astra, and scoped work / frequent automations
Luna. The bridge applies the table to each turn, including resumed threads;
owners/admins can read the same table, tariffs and threshold in `/api/org/models`.
Refining the table from measured success, latency and spend is the optimisation
hook. It does not infer a task kind from message text.

- **RED → GREEN:** the first public pricing test refused Astra; it now prices
  the worked short-context example correctly.
- **RED → GREEN:** the cached gateway fixture charged 100 cents instead of 32;
  it now records native cache-read counts and settles at 32 cents. A subsequent
  long-context fixture with cache writes settles at 454 cents.
- **RED → GREEN:** the bridge omitted a model from `turn/start`; it now selects
  Sol through the task table. Routing tests cover every task kind.
- **PASS:** pricing arithmetic for all eleven models, both tiers, supported cache
  rates, the exact threshold, upward rounding and invalid/removed-model refusal.
- **PASS:** all eleven models admitted through the fixture decision/gateway;
  expensive Astra refused before the provider under both daily and monthly caps.
- **PASS:** the existing cap, refusal, crash, uncertainty, retry and replay tests.
- **PASS:** usage counters reject bearer strings, fractions, negative and unsafe
  integers. The first full run caught the two new counter names in the secret-field
  guard; narrow exceptions retain these numeric-only restrictions.
- **PASS:** independent read-only review by GPT-6.1 Sol, within two passes;
  no blockers. The first pass ran the pricing/routing tests (25 passed), the
  second verified packaging and the numeric-only counter guard (264 passed).
  The reviewer made no provider calls.

Reservations deliberately retain a conservative full 1,050,000-token context
bound, at long rates and the greater input/cache-write rate. Both existing caps
still apply: this can refuse an expensive model even for a tiny prompt. A future
trusted server-side token bound can reduce the reservation and prove short
context; no computer-supplied count is accepted. Historical reservations retain
their recorded tariff id on replay; unresolved older tariffs stay reserved.

### Exactly three authorised live calls

**PASS**, 2026-10-02 16:49 UTC: exactly one real call each to the following models.
Each returned HTTP 200 and `response.completed`; the response model id matched
its request. The returned usage counts matched the gateway observations and the
recorded `effect.observed` / `budget.settled` events.

| Model | Input tokens | Cached input | Cache writes | Output tokens | Settled euro cents | Calls |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `gpt-6-luna` | 9 | 0 | 0 | 6 | 1 | 1 |
| `gpt-6.1-sol` | 9 | 0 | 0 | 5 | 1 | 1 |
| `gpt-6-astra` | 9 | 0 | 0 | 5 | 1 | 1 |

Prompt: **`Say OK.`** Bound: **16 output tokens**, the
[documented minimum](https://developers.openai.com/api/reference/java/resources/beta/subresources/responses/methods/create),
with low reasoning, streaming, `store: false` and standard service tier.
Total settled charge: **3 euro cents**, rounded up independently per call.
The isolated live fixture had 20,000-cent daily/monthly ceilings so that its
conservative reservations fit; it did not change the shared silo's ceilings.
The gateway read `<worktree>/.keys/.openai-key` by path;
the builder never read its contents. No provider key or raw gateway diagnostics
were persisted or printed. Attempt receipts were written before sending, and
an existing receipt prevents accidental reruns. There were no retries or other
real provider calls in this task.

Selected test command: `MODELS_REAL_CALL=1`, `MODELS_REAL_KEY_FILE` set to the
above path, `PG_TEST_URL` set to the local test database, and
`npx vitest run libs/models/test/gateway.test.ts -t 'exactly three approved real'`.
Result: **1 passed / 26 skipped**, 15.31 seconds. Safe local receipts remain in
`.tools/models-real-attempts.json` and `.tools/models-real-*.json` (ignored).
Normal gates explicitly use `MODELS_REAL_CALL=0` and never repeat these calls.

### Final gates and qualification limits

| Check | Result |
| --- | --- |
| `npm run lint` | PASS, all five checks; five existing function-length warnings |
| `npm run typecheck` | PASS, every workspace |
| `npm run check:events` | PASS, 71 event types agree |
| `PG_TEST_URL=… MODELS_REAL_CALL=0 npm test` | PASS, 57 files passed / 2 skipped; 993 tests passed / 3 skipped; 168.26 seconds |
| Selected paid gateway test | PASS, exactly three calls; 15.31 seconds |
| Independent review | PASS, two passes, no blockers |
| Isolated Node 22 runtime routing import | PASS, chat / analysis / summary; only routing code and package metadata present |

The extra runtime packaging probe first failed with Node 22's
`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING` when `routing.ts` lived inside
`node_modules`. The image now copies the dependency-free routing entrypoint
under `/app/libs/models` and links the package from `node_modules`, matching a
workspace install. The same isolated layout passes under Node 22.23.3. Package
metadata names the existing **AGPL-3.0-or-later** licence and the image carries
its full licence file; no server dependency is copied. This is a loader proof,
not a computer image build or fresh-install qualification.

Computer image rebuild, shared-stack deployment, a fresh-install complete chat
journey and hosted CI: **NOT RUN**. Real long-context/cache-hit calls and real
calls to the remaining eight models: **NOT RUN**; their arithmetic/admission
are tested with pinned data and scripted provider usage. The three real calls
qualify model ids and usage parsing through the complete gateway/settlement path.
Nothing was pushed or merged.

## Registry review fixes — 2 October 2026

Source: `6207df7` plus these fixes on `work/bridge`. Linux, disposable NATS,
PostgreSQL, OpenFGA and agentgateway with a scripted provider; no shared-stack
change or paid call. Independent pass 1 identified both blockers below.

- **PASS, red then green:** a `chat_turn` submitting `gpt-5.5` first returned
  200, then returned 403 with no budget reservation or provider access. The
  signed grant carries task `chat_turn` and allowed model `gpt-6.1-sol`; a
  matching request still succeeds and settles. The server chooses that model
  from the task table before signing; admission checks it before reserving.
- **PASS, red then green:** replaying pending old-tariff nano/mini reservations
  first threw `Unknown model` from usage ingestion. Retained, retired price rows
  now settle one million input plus one million output tokens at **43 cents**
  for nano and **214 cents** for mini, using their original tariff id. Both
  remain refused for new calls even with a matching signed grant.
- **PASS:** an unknown model between those usage lines records
  `effect.uncertain` with `unknown_tariff`, retains its 100-cent reservation and
  allows later ingestion, new Sol admission and settlement to continue.
  An unknown-model rejection line first settled at zero cents; the extra
  regression now keeps that second 100-cent reservation charged too.
  Repeated ingestion is idempotent, and the budget projection rebuild matches
  the recovered actor.
- **PASS:** focused models, signed-token and proxy checks: 5 files passed,
  58 tests passed / 1 paid test skipped.

| Final check | Result |
| --- | --- |
| `npm run lint` | PASS, all five checks; five existing function-length warnings |
| `npm run typecheck` | PASS, every workspace |
| `npm run check:events` | PASS, 73 event types agree |
| `MODELS_REAL_CALL=0 npm test` | PASS, 57 files passed / 5 skipped; 981 tests passed / 31 skipped; 243.27 seconds |
| Staged secret scan | PASS |

An earlier full run caught the API assertion that still expected eleven rows;
it now verifies the two retained rows are retired and carry the old tariff id.
One overlapping run also saw agentgateway exit during fixture startup, before
an existing readiness assertion. All three readiness cases passed in isolation,
and the final full run above passed without overlap.
Fresh-install live upgrade, shared-stack deployment, paid calls, hosted CI and
independent review pass 2: **NOT RUN** in this fix task.

## Initial request-sized reservations — 4 October 2026

Issue #75, source `50307c0` on `work/reservation-sizing`. This records the initial
byte-only implementation; the rendering correction below supersedes its sizing proof.
Linux, Node 22.23.3; disposable NATS, OpenFGA, agentgateway and PostgreSQL
databases through `PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres`.
The SSE provider is scripted. No shared stack was changed and no paid call ran.

- **PASS, red then green:** a Sol turn with a 2,000-token output bound was
  refused under a three-cent cap with the full-context reservation. Measuring
  the complete request now admits it, reserves three cents and settles one.
- **PASS:** pure reservation tests cover exactly 272,000 bytes (short),
  272,001 bytes (long), long context and input-plus-output context overflow.
  Gateway tests verify a near-threshold request, instructions pushing it into
  long context, a long request and clear refusal before dispatch or reservation
  when no tier can fit the request's bounds.
- **PASS:** the seeded random-body property covers UTF-8, instructions, input
  items, tool schemas, grammar definitions, function arguments and outputs.
  Each tier's maximum proves the bound for all smaller tokenisations and
  outputs, including cached reads and supported cache writes. Removing request
  text from sizing makes the property fail; restoring sizing makes it pass.
- **FAIL, independent review pass 1:** request bytes bound their own tokenisation,
  but do not bound provider-rendered roles, boundaries and formatting. Admission
  could select short rates while settlement uses long rates near 272k. Cached-input
  discounts remain settlement-only, and reservation rates still cover cache writes.
- **PASS, red then green:** the eight-call daily/monthly cap races timed out
  under shared-host load before any admission. Model grants now await readability,
  and the eight requests run in concurrent pairs to fit the normal admission
  deadline. Exactly one request is admitted and seven are refused.
  The two audit restart cases now await their expected log records before
  stopping the gateway; response arrival alone did not guarantee those records
  had been written. All four regressions pass without changing production deadlines.

| Final gate | Result |
| --- | --- |
| `npm run lint` | PASS; five existing function-length warnings |
| `npm run typecheck` | PASS; every workspace |
| `npm run check:events` | PASS; 79 event types agree |
| `PG_TEST_URL=… npm test -- --maxWorkers=2` | PASS; 70 files passed / 2 skipped, 1,191 tests passed / 11 skipped; 1,070.11 seconds |

Safe local logs:
`/tmp/reservation-sizing-lint.log`, `/tmp/reservation-sizing-typecheck.log`,
`/tmp/reservation-sizing-test-complete.log` and `/tmp/reservation-sizing-fixtures-final.log`.
Fresh-install live chat, paid provider tokenisation and hosted CI: **NOT RUN**.

## Rendering correction for request-sized reservations — 4 October 2026

Issue #75, fixing the pass-1 blocker on source `50307c0`. The input bound now adds
2,048 tokens per request and 64 per JSON object, covering messages, content/input
items, function outputs and nested tool/schema definitions. The code cites the
[provider token-counting documentation](https://developers.openai.com/api/docs/guides/token-counting).
Above 244,800 padded input tokens, admission uses long rates; settlement still
selects the tier from actual usage.

- **PASS, red then green:** pure reservation tests exercise the 90% safety-band
  boundary, per-item headroom and refusal when rendering headroom exceeds context.
- **PASS, red then green:** the independent property tokenises individual text
  fields and generates separate request/role/boundary/tool overhead. Restoring the
  old byte-only sizing and tier selection makes it fail at seed 75, trial 3.
- **PASS, red then green:** an observed 115-cent charge against a one-cent
  reservation raises an alert naming the model and both amounts. Each of the daily,
  global monthly, paying-group and assistant ceilings refuses later admission;
  actor recovery preserves the actual charge and does not duplicate the alert.
- **PASS:** an alert append outage leaves the full charge in the budget, so later
  admission is refused. Actor recovery retries the recorded effect and repairs the
  alert, with one settlement and one alert after duplicate delivery.

| Final gate | Result |
| --- | --- |
| `npm run lint` | PASS; five existing function-length warnings |
| `npm run typecheck` | PASS; every workspace |
| `npm run check:events` | PASS; 79 event types agree |
| `PG_TEST_URL=… npm test -- --maxWorkers=2` | PASS; 70 files passed / 2 skipped, 1,201 tests passed / 11 skipped; 805.02 seconds |

The first full run passed 1,200 tests but failed when agentgateway exited during
fixture startup, before the existing multiplicity test ran. That test passed in
isolation; the final full run passed without overlapping checks. Production
readiness checks and admission deadlines were unchanged. Safe local logs:
`/tmp/reservation-sizing-lint.log`, `/tmp/reservation-sizing-typecheck.log`,
`/tmp/reservation-sizing-test.log`, `/tmp/reservation-sizing-test-startup-failure.log`
and `/tmp/reservation-sizing-validation.log`.

Fresh-install live chat, paid provider tokenisation, hosted CI and independent
review pass 2: **NOT RUN** in this correction task.
