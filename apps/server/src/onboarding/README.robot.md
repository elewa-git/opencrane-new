# Onboarding route contracts

For people, read [README.md](README.md) first.

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

`GET /api/onboarding/welcome` returns the saved variant, frozen references, next
question, answer count and pending status. It checks membership after loading
history and before opening an answer. `POST /api/onboarding/welcome` accepts
`start` or `answer`. Start requires four survey steps. An assigned assistant
also requires the exact approved persona revision. The server checks the
deterministic assistant stream and saves its assignment status with `welcome-v1`.
The no-assistant choice can start while provisioning is pending, but an
unavailable assignment read refuses the request. Answer requires the exact
welcome id, generation, script, first step and expected personal position.
Its private bytes use the personal key. The last answer returns
`completion_pending`; no completion event is written by these routes.
