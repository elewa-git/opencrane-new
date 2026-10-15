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
| `GET /api/org/models/:modelId/access` | Registry model id | Current grant rows and direct, group or assistant source labels |
| `GET /api/org/models/:modelId/access/candidates?kind=member\|team\|assistant` | Optional `after` id and `limit` from 1 to 100 | Bounded same-silo choices; group rows include current joined-member count |
| `POST /api/org/models/:modelId/access` | `{ commandId, expectedSequence, action: "grant"\|"revoke", granteeKind, granteeId }` | Saved grant receipt, or `{ status: "no_effect" }` |
| `GET /api/org/models/:modelId/access/changes/:commandId` | Original ids | Original receipt, current stream position and content/IAM status |

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

A configuration request and a provider-choice request that use the same command
id on one provider cannot both succeed. The saved request returns its receipt;
the other request gets 409. The changes GET returns the saved operation and its
original event id. An unavailable read of that saved event returns 503, so the
reply cannot confirm a change that was never saved.

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
reachability `fail`. Other non-OK replies, redirects (which are never followed) and
replies that are not a model list record `unknown`, because rate limits, provider
outages, gateway timeouts and odd replies do not prove that the key was rejected.
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

`access.grantsAvailable` is true with `reason: "model_access_routes"`. The browser
opens the model access editor from each enabled model's Access button. The Models
table reads configured assistant uses from provider bindings and shared assistant
names. It warns about a missing assistant grant only when the grant list is complete.
The access GET still marks its own configured uses and connection availability fields
as not available yet. The editor does not infer missing users.

## Changing model grants

A model grant write has a strict body of at most 2 KiB. The server checks current
Owner/Admin access before reading grant history. A grant requires an active
registry model and a same-silo person, group or assistant. The person must be a
joined member. Revokes can remove a departed person's grant and grants on retired
registry models. A model id absent from the registry is refused for both actions.

Target problems return 409 with `status: "refused"` and a `reason`:

- `model_unavailable`: the model is unknown, or a grant names a retired model.
- `target_unavailable`: the grantee is missing, in another silo or has the wrong kind.
- `target_changed`: the person or assistant changed during the grant check.

Caller authority problems return 403 with `{ status: "refused" }`. A stale
`expectedSequence` or a changed repeat returns 409 with `{ status: "refused" }`.
Group membership activity does not refuse a grant: the server reads only the
group's creation event before checking the caller and does not watch that stream.

A revoke with no current grant returns `{ status: "no_effect" }` without saving an
event. There is one exception: revoking a starting grant before its worker has
saved it records the revoke, so that worker cannot restore access later. Starting
grants cover active registry models for joined people and personal assistants,
and the selected models of shared assistants and their owning groups. A second
revoke with a new command id returns `no_effect`. An identical repeat of a saved command returns its original
receipt. A `no_effect` reply has no change receipt to recover through GET.

A typed revoke changes only the named grantee kind. Older revokes without a kind
still cover all kinds with the same id. Grant writes make one conditional append
and never write OpenFGA tuples. The status GET checks current caller access once
and reports whether content and IAM have applied the saved event. A missing
command returns 404 `unknown`; a request still running may yet save it. An
uncertain append returns 503 `unknown`, while a failed check before append returns
503 `unavailable`. The browser grant editor now supports one-row grant and remove saves. It checks
content and IAM status, then reads a fresh list before reporting Saved. After reload, it checks the saved command reference without repeating the POST.
The candidate picker uses the returned next value for Load more. The fresh-install journey is NOT RUN.

## Model calls during grant changes

Model calls catch up their model's saved grant facts before checking access.
OpenFGA still decides whether the requester and assistant can use the model.
The complete decision has two seconds; a cold catch-up can outlast the call and
help a later retry.

Two cases can refuse a call even while OpenFGA still allows it:

- A relevant grant change is saved after the call captures the log position for
  catch-up. The current call is refused even if the summary includes that change
  and OpenFGA has applied it.
- An older revoke has no `granteeKind` and names an id ever granted as a team on
  this model. The current call is refused even if that team does not own the
  assistant or currently include the requester.

These checks are stricter than the earlier grant check; they never grant new
permission. Unrelated typed member grant changes still allow a call to proceed.
The [models contract](../../libs/models/README.robot.md#grant-memory-budget-and-queue)
records the cache budget and the limits on cold reads.

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

## Saved provider choices

`GET /api/org/providers/:providerId/bindings` returns saved `rows`, `expectedProviderSequence`, real `assistantCount` values and `ordinaryCallsAvailable: false`.
Its `routines.status` is `absent` after checked empty history, otherwise `unsupported`. Reader failure or changing history returns 503.
`POST` accepts `commandId`, `expectedProviderSequence`, `expectedRevision`, `kind` (`assistant` or `silo_default`), `dependantId`, `task: chat_turn`, `expectedBindingSequence`, and `action: select|pause`.
Select requires `model`; a move also requires `expectedSourceRevision`. Pause keeps the provider and model. The existing changes GET recovers the original receipt; retry uses the same body and id.
Saved choices do not yet control ordinary calls. Retirement remains unavailable.

Identical concurrent retries return the saved event id and sequence. A different actor or
changed request reusing a command id on the same provider gets 409. The automatic default
uses a reserved internal command id that user requests cannot supply. It chooses the
first verified provider only when there is no saved default or pause, and waits for that
provider to enable the chat model. An administrator can explicitly choose any eligible
verified provider as the initial default.

## Switching on managed calls

`POST /api/org/providers/:providerId/switch-on` takes `commandId`, `expectedRevision`,
`expectedProviderSequence` and `expectedDrainSequence`. The drain GET supplies these
positions and the revision. Current Owner/Admin access, provider management permission,
an applied creation receipt and the configured Origin are required.

Switch-on requires an active drain, an explicit active silo default on this connection,
and a saved key, successful reachability evidence and an enabled supported model for
every active binding. Automatic defaults need an explicit administrator choice first.
Legacy chat turns must have closed or have a later computer loss, retirement or claim.
Success saves one `provider.managed_calls_enabled` event on `budget-<silo>` and ends draining.

The existing changes GET returns its original receipt. A missing receipt remains
`not_found`: the outcome is unknown while a request is in flight. Retrying the same
id and body returns the original receipt, including after a lost reply. Changed retry
input or stale positions return 409. Missing prerequisites, denied access and a new
switch-on id after success return 403. Refusals save nothing. Any event saved between
the initial history position and the append causes 409; reload before trying a new id.

New turns use their own or the silo default choice. Calls stay refused after switch-on
until managed admission is completed and PR 5b supplies gateway startup and fallback-key
refusal. The optional gateway route has passed its per-call key test, but no process
starts it and the production decision service refuses its path. The budget actor
also refuses all new reservations after switch-on; that guard needs a checked managed
call path before activation. Switch-off,
retirement and screens remain unavailable. This command never reads a key or calls a provider.
