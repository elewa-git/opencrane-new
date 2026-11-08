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
The approval survives a later revision, survey edit, restart and projection replay.
Only a later explicit approval changes the approved reference.

See [apps/server/README.robot.md](../../README.robot.md) for the shared member
guard, response codes and private key custody rules.
