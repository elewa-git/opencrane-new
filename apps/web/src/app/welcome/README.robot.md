# Welcome survey and persona review contracts

For people, read [README.md](README.md) first.

`/welcome/survey` reads `/api/onboarding` and saves each step with
`POST /api/onboarding/survey`. The completed survey links to `/welcome/persona`.
When all four steps are saved but `currentRevision` is null, the review route
sends `POST /api/onboarding/persona` with `operation: revise`, `mode: generate`,
the survey generation and expected position. A confirmed creation reloads progress.
A 409 reloads without sending another command; an unknown result keeps its id and
checks `/api/personal/changes/:commandId` without resending.
After creation, the review route reloads `/api/onboarding`, then reads
`/api/onboarding/persona/revisions` and detail by the current revision id.
Only four saved steps and matching current revision, id and generation show
`Approve this version`. A stale or failed read hides that action.

The approval POST sends `operation: approve`, a new `commandId`, survey
`generation` and `expectedPosition`, and the displayed `revision` and
`revisionId`. A 409 reloads the saved version. An unknown result keeps the
original id and reads `/api/personal/changes/:commandId`; it never repeats
the POST. The approved screen shows the server's saved time and links to
`/workspace`. It appears after a matching confirmed receipt or an already
approved revision in checked progress. A 401 or 403 clears private
text and invalidates earlier replies. Reads and writes use `no-store` and
keep private text out of addresses, storage and error messages.

Editing, replacement and restart are unavailable on this screen. The server
supports those commands, but their browser review and confirmation states
belong to the next part. The Assistant settings page remains unavailable.

Run `npm run visual:screen-p4-19-persona` for intercepted captures at both
desktop and phone widths.
