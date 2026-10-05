# Model provider HTTP interface

P4-21 backend for MOD in handoff 08-mod. All routes require a verified silo
session and current Owner/Admin authority. Writes require the configured Origin.
Claimed session roles grant nothing. Replies use `no-store`; errors and events
never contain key values, upstream error bodies or model answer text.

## Routes the screens bind to

| Method and route | Input | Result |
| --- | --- | --- |
| `GET /api/org/providers` | None | `{ rows, loadedAt, access }` |
| `GET /api/org/providers/:providerId` | None | Same envelope, zero or one row |
| `POST /api/org/providers` | `{ action: "create", commandId, providerId, expectedRevision: 0, provider, name }` | Durable append receipt |
| `POST /api/org/providers/:providerId/key` | `{ commandId, expectedRevision, key }` | Receipt plus `clearKey: true` |
| `GET /api/org/providers/:providerId/verify?model=:model` | Registry model id | `{ providerId, revision, model, priceTableId, reservedCents, consentRequired: true }` |
| `POST /api/org/providers/:providerId/verify` | `{ commandId, expectedRevision, action: "reachability" }` or `action: "skip"` | Original attempt receipt |
| Same verification POST | `action: "test"` plus `model, priceTableId, reservedCents, consent: true` | Original attempt receipt; reservation precedes gateway dispatch |
| `POST /api/org/providers` | `{ action: "models", commandId, providerId, expectedRevision, models }` | Selected registry model ids, without granting access |
| `GET /api/org/providers/:providerId/changes/:commandId` | Original ids | Receipt, content and IAM projection status, current revision, verification validity and recorded attempt outcome |

Provider is `openai` or `anthropic`. Names are trimmed, required, at most 200
characters and cannot contain NUL. Entity and command ids contain 1–200 letters,
digits, underscores or hyphens. Model ids come from the existing registry and
may contain dots. Bodies reject unknown fields. A key is 1–4096 visible ASCII
characters; the HTTP body is capped at 8192 bytes.

Use the existing `GET /api/org/models` registry/routing interface for Models.
There are 11 active OpenAI models. Anthropic can be saved and checked for
reachability, but has no registry models or tariff: model selection and paid
verification are refused. No prices, exchange rates or models are invented.

## Evidence and recovery

Receipts contain `status: "appended"`, `providerId`, `revision`, `sequence` and
`changeId` and the recorded `operation`. Check that operation before confirming
a lost reply. Clear the key field on acceptance, including a reconciled accepted
save; keep keys out of browser storage. On a lost reply, show Outcome unknown
and read the original change route. A 404 does not prove an in-flight write will
never complete. Check status never saves or verifies again. A repeated accepted
key command returns the original receipt and ignores the transient replacement
value; another rotation requires a new command id and the current revision.

Rows contain name, provider, revision, position and enabled model ids. `saved`,
`reachable`, `modelAnswer` and `modelsChanged` are independent recorded facts with
actual event time, revision and change id. Model evidence also carries the model,
reservation id, reserved cents and settled cents when known. `lastReachable` and
`lastModelAnswer` retain the previous successful evidence during a failed check.
`reservedCents` is the requested quote; it alone does not prove a budget hold.
An actual reservation has a `reservationId`; budget refusal has none.
Rotation clears all current-key verification evidence. Original history remains
available by its command reference, with `verificationValid: false` after rotation.
Model selection advances the configuration revision without changing key custody.

Statuses are `needs_key`, `saved_unverified`, `connected_not_tested` and `ready`,
plus `model_test_fail`, `model_test_unknown`, `model_test_budget_refused` and
`model_test_outcome_unknown` when reachability passed and a model test has failed,
is uncertain, was budget-refused or is still pending. An explicit Skip retains
`connected_not_tested`. The separate facts remain available with each status.
Ready needs both reachability and model-answer PASS for the saved key. Skip never
creates PASS. Reachability `fail` or `unknown` maps to `saved_unverified`, including
a re-check of a previously ready provider. Only an upstream 401 or 403 records
reachability `fail`; other non-OK replies record `unknown`, because rate limits,
provider outages and gateway timeouts do not prove that the key was rejected.
Pending requests and consumed attempts without a result remain
`outcome_unknown`; retries only reconcile them. Failures retain the saved fact.
A priced test requires the exact current quote and explicit consent. When no
`provider.verification_dispatched` event exists, the provider was never
sent the check: the outcome is `unknown` and a priced reservation is released at
zero cents. A failure before calling the gateway also records `unknown` and
releases any reservation as undispatched, without requiring an allow decision.
After dispatch, priced tests settle definite upstream 401, 403 and 429 rejections
at zero cents and record `fail`. Other non-OK replies, unknown usage or transport
results keep the budget
hold; there is no timeout refund or automatic retry. Invalid JSON is recorded as
unknown immediately. A configuration or role change during the call cannot block
recording its result at the original revision. A late result only updates the same
attempt's current-key fact; it cannot replace evidence after rotation or a newer
attempt. Budget refusal is recorded before any provider call.
Verification uses the installation's default paying group and existing ceilings.

## Authority, replay and remaining bindings

Each configuration, request, dispatch and result command makes one conditional
append to one provider stream. The HTTP adapter saves an immutable secret reference
before the key event, following the existing connection custody rule. The dev
secret-store adapter writes private temporary files and publishes complete keys
with an exclusive link in `PROVIDER_SECRETS_DIR`, shared by the server and models
process; it is separate from projections and gateway
configuration. Repeated exclusive writes keep the first key without reading it
to compare. Save reconciliation deletes retired references and obsolete candidates
only after reading the recorded configuration. A candidate remains while its
revision can still accept an in-flight retry. Once configuration advances, a
rejected save or its original retry can safely delete that obsolete reference.
A lost append acknowledgement preserves an accepted key. If history is unavailable,
cleanup waits for a later retry. A process crash can leave private temporary files
requiring secret-store
cleanup, or a published reference that is reconciled by its original command.
Configure both processes explicitly; missing custody or verification
infrastructure fails closed.

Gateway admission rechecks the signed exact command, live Owner/Admin membership,
IAM receipts, configuration revision, fixed test body and reservation. It consumes
one attempt before forwarding. Its token has the separate `provider-verification`
type and audience, bound to the command digest; budget tokens cannot admit it.
The key is read after request, attempt, reservation and freshness checks.
Provider reservations use a `provider-` conversation id; user conversation commands
reject that reserved prefix. Internal dispatch/result command ids contain `:` so
they cannot collide with validated user command ids.
Provider routes use their own attempt events rather than unrelated native gateway
observations. Provider-route 401 log lines remain in the gateway audit as
`jwt_failed` observations. Keys are injected after admission; internal tokens
and command headers never reach the provider. Authority reads use exact subjects
and the shared two-second fence/deadline. Changes during reads fail closed.

The members worker projects metadata; `npm run replay -- providers --verify`
rebuilds beside the live table and switches atomically. Replay never reads keys,
reserves money or calls a provider. OpenFGA derives provider `manage`/`read` from
current silo Admin (including Owner); this creates no model `use` grant.

401 means no session; 400 invalid input; 403 insufficient authority or unpriced
model (`reason: "unknown_price"`); 409 stale revision, changed quote or command
conflict; 503 unavailable infrastructure. Status reads use 404 for an absent command. Accepted asynchronous
work can still have a refused, failed or unknown recorded outcome.

`access.grantsAvailable` is false with `reason: "p4_22_required"`. Access grants,
requester/assistant intersection explanations, ordinary model route replacement
and retirement/dependency review belong to P4-22. Do not show invented users,
assistant counts, retirement consequences or access completion. The Claude Design
screens and fresh-install qualification remain pending on the UI foundation.

## Known design and dev-stack gaps

- MOD-04 needs non-admin read-only provider state. Current event-backed authority
  and OpenFGA `read: manage` restrict all reads to Owner/Admin; that state is not
  implemented yet.
- Provider verification shares `MODEL_UPSTREAM` with ordinary model traffic.
  The dev-stack model stub does not implement `GET /v1/models`; its 404 produces
  failed reachability after dispatch. This stack cannot qualify real provider
  reachability until the upstream binding is separated or the fixture implements it.
- `PROVIDER_SECRETS_DIR` is not wired into the dev stack. Both the server and models
  process need the same private secret directory before a fresh-install provider
  journey can run. Missing wiring denies verification rather than proving it works.
