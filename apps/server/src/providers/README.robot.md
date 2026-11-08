# Provider requests

For people, read [README.md](README.md) first.

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
