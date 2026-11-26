# Provider requests

For people, read [README.md](README.md) first.

## Chat default

`GET /api/org/providers/:providerId/bindings` returns `chatDefault` for the silo.
It is `null` until a default exists. A saved default gives `position` and, if it
uses another connection, that connection's current `sourceRevision`. The `rows`
list still describes only the requested connection.

`POST /api/org/providers/:providerId/bindings` accepts `select_chat_default` with
`commandId`, `model`, `expectedRevision`, `expectedProviderSequence` and
`expectedBindingSequence`. The last field is zero for a first choice. A move
also supplies `expectedSourceRevision`. Only a move records this revision.
The server takes the default's identity from the signed-in session's
installation. Both this action and a `select` for `silo_default` need a current
reachability pass and a passing model answer. The server checks admin access,
permission on both connections for a move, current positions, the saved key and
the enabled model before appending `provider.model_binding_set`. A write
refusal can name `permission_denied`, `connection_not_ready` or
`model_not_enabled`. HTTP 425 means membership is still being applied and
this attempt saved nothing.

## Retirement preview

`provider.retired` is readable through provider detail and change status. Detail
reports `status: retired` before considering any late check result. The event's
reviewed choices are safe metadata; the key reference and value stay out of the
reply. The POST retirement route remains absent. Existing preview routes still
append nothing and keep their late routine and payer checks.

`GET /api/org/providers/:providerId/dependencies` reads saved provider and
assistant events, then indexed routine progress. It checks current admin and
provider permission after loading. The `no-store` reply has at most 50 bindings
per page. Later pages supply `after` and the returned provider and routine
positions; changed positions refuse.

`POST /api/org/providers/:providerId/dependencies/preview` checks a strict
`{ expectedProviderSequence, choices }` body. Each binding needs one saved
position and an explicit pause or replacement. A replacement needs another
provider, its current revision, a supported priced model, a configured payer
and spending limits, and live grants. Candidate work is limited to 200 checks
and ten seconds; an incomplete check cannot validate a proposal.
Origin and current admin rights are checked. Neither route saves an event,
calls a provider or reserves money. `canRetire` stays false.

A routine checkpoint must cover its event position to prove absence. The route
checks that position again after preparing replacements. Existing
routines have no model binding; safe names, ids and positions appear as
unresolved records. Failed or lagging reads report `unavailable`. Private
instructions, arguments and results never appear.

Focused fixtures: `apps/server/test/provider-bindings.test.ts` and
`apps/server/test/provider-routine-presence.test.ts`.
