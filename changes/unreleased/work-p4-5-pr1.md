Group chat events now record an explicit audience and rebuild each person's periods
of participation. Participant changes use a separate small stream and stay in order
with creation when permissions are applied. Group commands and screens are still pending.

Conversation writes now refuse mismatched ids. New groups fit OpenFGA’s default limit
with at most 97 people, including the creator. Existing conversation tables need an
offline replay when upgrading; the worker names the command. Member ids such as
`ext:jane` are accepted, and older saved participant events remain readable.
