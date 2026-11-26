# Onboarding route contracts

For people, read [README.md](README.md) first.

`GET /api/onboarding/entry` checks current membership and returns only `next`.
It uses saved survey history without decrypting any content. New and part-finished
surveys send the member to `survey`. A completed survey without approval sends
them to `persona`. Approval or a started welcome sends them to `welcome`. A saved
skip or welcome completion sends them to `workspace`. An unconfigured service
returns 204. An expired session returns 401. Membership refusal returns 403.
The sign-in callback uses the same progress for a workspace return path. It
honours an invitation return path so the person can accept it first.

`POST /api/onboarding/survey` accepts `operation: skip` with the same command id,
generation and expected position as other survey changes. It saves one
`onboarding.survey_skipped` event without removing answers or creating a key.
Later survey changes keep the skip choice. The first saved answer can prepare the
member's key when it does not already exist. Once an answer has used a key,
a missing key still refuses reads and writes that need it.

`POST /api/onboarding/persona` accepts `operation: approve`, `commandId`,
`generation`, `expectedPosition`, `revision` and `revisionId`. The number and id
must identify the current candidate in the member's personal stream. The server
loads that history before the two-second member access check. One accepted command
appends one `onboarding.persona_approved` event to that stream at its expected
sequence. Competing edits and changed retries return 409.

The event stores the member id, survey generation, revision number and revision
event id. It stores no persona text. `GET /api/onboarding` returns the current
candidate separately from the approved revision and approval time. Revision list
and detail reads mark the approved version. `GET /api/personal/changes/:commandId`
returns the original approval receipt after a lost reply without writing again.
POST retries and post-append receipt checks read the saved event, then check
current membership before decrypting any saved survey answer or persona text.
Removal during the saved event read returns 403 without decrypting.
Persona generation checks current membership after loading survey history and
before decrypting saved answers. Removal during that read returns 403 without
decrypting or appending a revision.
The approval survives a later revision, survey edit, restart and projection replay.
Only a later explicit approval changes the approved reference.

See [apps/server/README.robot.md](../../README.robot.md) for the shared member
guard, response codes and private key custody rules.

`GET /api/onboarding/welcome` returns `assistantAssigned` and `requiredStep`
before a start. `requiredStep` is `survey` until all four steps are saved,
`persona` when an assigned assistant still needs approval, or `null` when
the offered start is ready. It
checks the same `assistant.created` event as the start command, so a delayed
computer projection cannot change the offered choice. Once started, it returns
the saved variant, frozen references, next question, answer count and pending
status. It checks membership after loading
history and before opening an answer. `POST /api/onboarding/welcome` accepts
`start` or `answer`. Start requires four survey steps. An assigned assistant
also requires the exact approved persona revision. The server checks the
deterministic assistant stream and saves its assignment status with `welcome-v1`.
The no-assistant choice can start while provisioning is pending, but an
unavailable assignment read refuses the request. Answer requires the exact
welcome id, generation, script, first step and expected personal position.
Its private bytes use the personal key. The last answer returns
`completion_pending`; no completion event is written by these routes. The
`complete-welcome` worker handles the saved answer separately. Once it saves
`onboarding.completed`, welcome reads return `completed` and `completedAt`.
Survey restarts and later assignment changes retain this frozen welcome. The
original answer command receipt still reports its saved pending result.

`POST /api/onboarding/welcome/archive` accepts `commandId`, `welcomeId`,
`archived` and `expectedArchivePosition`. It checks the member's completed
welcome in personal history, then checks current membership before one
conditional append of `onboarding.welcome_archive_set`. The archive position
starts at zero and changes to the saved event position. A stale opposite choice
returns 409. An unknown or foreign welcome id returns 404 without its content.
An identical command returns its original receipt after a lost reply; changing
its choice or expected position returns 409. `GET /api/personal/changes/:commandId`
reads that original event and appends nothing. Completion, answer and frozen
assistant choice stay the same after archive and restore.
