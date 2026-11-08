# Welcome survey and persona review contracts

For people, read [README.md](README.md) first.

`/welcome/survey` reads `/api/onboarding` and saves each step with
`POST /api/onboarding/survey`. The completed survey links to `/welcome/persona`.
The review route reads `/api/onboarding`, then
`/api/onboarding/persona/revisions`, then detail by the current revision id.
Only four saved steps and matching current revision, id and generation show
`Approve this version`. A stale or failed read hides that action.

The approval POST sends `operation: approve`, a new `commandId`, survey
`generation` and `expectedPosition`, and the displayed `revision` and
`revisionId`. A 409 reloads the saved version. An unknown result keeps the
original id and reads `/api/personal/changes/:commandId`; it never repeats
the POST. The welcome link appears after a matching confirmed receipt or an
already approved revision in checked progress. A 401 or 403 clears private
text and invalidates earlier replies. Reads and writes use `no-store` and
keep private text out of addresses, storage and error messages.

Editing, replacement and restart are unavailable on this screen. The server
supports those commands, but their browser review and confirmation states
belong to the next part. The Assistant settings page remains unavailable.
