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
`/welcome`. It appears after a matching confirmed receipt or an already
approved revision in checked progress. A 401 or 403 clears private
text and invalidates earlier replies. Reads and writes use `no-store` and
keep private text out of addresses, storage and error messages.

Editing, replacement and restart are unavailable on this screen. The server
supports those commands, but their browser review and confirmation states
belong to the next part. The Assistant settings page remains unavailable.

Run `npm run visual:screen-p4-19-persona` for intercepted captures at both
desktop and phone widths.

`/welcome` reads `GET /api/onboarding/welcome`. A `not_started` result offers
the assistant or no-assistant start from the event-backed `assistantAssigned`
field on that same read. It does not use the chat projection. Start reads
`/api/onboarding` for the current survey generation, position and approval
reference, then posts
`operation: start`. Active welcome uses the saved script version, question,
step and position. The welcome read does not include generation, so the page
reads `/api/onboarding` to obtain it before an answer. One answer POST uses
`operation: answer`; no-assistant sends the scripted acknowledgement. A 409
reloads saved progress and requires review. An unknown reply keeps the command
id and only checks `/api/personal/changes/:commandId`. Completion is shown only
after a saved `completed` read. The composer is absent in pending and completed
states. A 401/403 clears saved private words and aborts late replies. The
active question shows a welcome-back notice after a fresh page load. A start
confirmed in the current page opens the question without that notice. Completed
confirmation and crease show the saved `completedAt` time. The desktop page
includes the session rail; the phone composer has one frame around the text and
action. The archived display uses `/welcome?section=archived` and remains read-only; list
navigation belongs to the next chat-list change. No browser storage is used.

Run `npm run visual:screen-p4-20-welcome` for intercepted desktop and phone
captures. It does not start the development stack.
