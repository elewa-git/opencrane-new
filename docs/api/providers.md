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

Statuses are `needs_key`, `saved_unverified`, `connected_not_tested` and `ready`.
Ready needs both reachability and model-answer PASS for the saved key. Skip never
creates PASS. Pending requests and consumed attempts without a result remain
`outcome_unknown`; retries only reconcile them. Failures retain the saved fact.
A priced test requires the exact current quote and explicit consent. Unknown
usage or transport results keep the existing budget hold; there is no timeout
refund or automatic retry. Budget refusal is recorded before any provider call.
Verification uses the installation's default paying group and existing ceilings.

## Authority, replay and remaining bindings

Each configuration, request, dispatch and result command makes one conditional
append to one provider stream. The HTTP adapter saves an immutable secret reference
before the key event, following the existing connection custody rule. The dev
secret-store adapter uses exclusive private files in `PROVIDER_SECRETS_DIR`, shared
by the server and models process; it is separate from projections and gateway
configuration. An interrupted save can leave an orphan reference, never an active
connection without a recorded key event. Configure both processes explicitly;
missing custody or verification infrastructure fails closed.

Gateway admission rechecks the signed exact command, live Owner/Admin membership,
IAM receipts, configuration revision, fixed test body and reservation. It consumes
one attempt before forwarding. Keys are injected after admission; internal tokens
and command headers never reach the provider. Authority reads use exact subjects
and the shared two-second fence/deadline. Changes during reads fail closed.

The members worker projects metadata; `npm run replay -- providers --verify`
rebuilds beside the live table and switches atomically. Replay never reads keys,
reserves money or calls a provider. OpenFGA derives provider `manage`/`read` from
current silo Admin (including Owner); this creates no model `use` grant.

401 means no session; 400 invalid input; 403 insufficient authority or unpriced
model (`reason: "unknown_price"`); 409 stale revision, changed quote or command conflict; 503 unavailable
infrastructure. Status reads use 404 for an absent command. Accepted asynchronous
work can still have a refused, failed or unknown recorded outcome.

`access.grantsAvailable` is false with `reason: "p4_22_required"`. Access grants,
requester/assistant intersection explanations, ordinary model route replacement
and retirement/dependency review belong to P4-22. Do not show invented users,
assistant counts, retirement consequences or access completion. The Claude Design
screens and fresh-install qualification remain pending on the UI foundation.
