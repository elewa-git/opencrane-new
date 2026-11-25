Operators can verify a scheduled pilot backup and use it to recover a chat in
an empty installation. Recovery keeps the chat readable while refusing writes.
The backup closes its own checkpoint readers before it checks for other writers.
The pilot switch checks foreground and background Funnel sessions, the full
Serve configuration and the process listening on the pilot port. Rollback treats
`localhost` and `127.0.0.1` on the same port as the same address.
