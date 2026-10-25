# Company account opt-in read

`GET /api/org/integrations/:serverId/company-opt-in` returns the current saved
company account opt-in for this installation. It requires a signed organisation
session and current owner or admin membership. Cookie role claims grant no access.

The server id accepts 1–200 letters, digits, underscores or hyphens. No query
fields or body are accepted. The session and server configuration supply the
member and silo; callers cannot override them.

A successful response contains exactly:

```json
{"enabled":false,"sequence":0,"connectionId":"installed","registrationRevision":42}
```

`sequence` is the latest company control stream position, or zero if absent.
`registrationRevision` is the latest registration event position. `connectionId`
is the current discovered installation id, or null before discovery completes.
Absent opt-in is disabled. Re-registering invalidates earlier opt-in, even when
later discovery reuses the same connection id. Removal keeps its saved sequence.
The response describes saved state, not tool access, account selection or provider
readiness. It contains no credential profile or account identity.

Every outcome uses `Cache-Control: no-store`. Missing sessions return 401; wrong
silo, missing membership and ordinary or removed members return 403. Invalid or
extra input returns 400 `invalid_request`. Current admins get 404 `not_found` for
an absent registration. Unavailable history, membership lookup or permissions
return a fixed 503 `unavailable`, without dependency details.

The server reads the exact registration and company control streams within a
separate ten-second history limit, then checks current admin access once. Access
refusal takes precedence over failed history. Slow history and unrelated chat
activity do not create a two-second refusal. Reads and replay save nothing and
start no account, provider, credential release or tool work. This route has no POST.
