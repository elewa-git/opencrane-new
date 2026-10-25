# Company account opt-in

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
start no account, provider, credential release or tool work.

## Save or remove opt-in

`POST /api/org/integrations/:serverId/company-opt-in` records an explicit choice.
It requires the same signed session and current owner or admin membership as GET,
plus an `Origin` exactly matching the configured sign-in redirect origin.
The server takes the member and silo from trusted context and the server id from
the path. Query fields and identity overrides are refused.

The JSON body is limited to 4096 bytes and accepts exactly these required fields:

```json
{"enabled":true,"expectedSequence":0,"connectionId":"installed","registrationRevision":42,"changeRef":"enable-company"}
```

`enabled` is a boolean. `expectedSequence` is the last company control position
returned by GET, or zero when absent. `registrationRevision` is the positive
registration position returned by GET. Both positions must be safe integers.
`connectionId` and `changeRef` accept 1–200 letters, digits, underscores or hyphens.
Removing opt-in uses `enabled: false`, the current position and a new change reference.

A successful save returns HTTP 200 with the original receipt:

```json
{"enabled":true,"sequence":43,"changeRef":"enable-company"}
```

The receipt confirms that one event was saved. It grants no account or tool use.
An exact retry recovers the same receipt after restart, later changes and broker
deduplication expiry. Reusing a change reference with different input conflicts.
After an unavailable or lost reply, the caller keeps the original input and
reference for recovery; the failure is not proof that nothing was saved.
GET reports current state, which may differ from the original receipt.

Missing sessions return 401. Refused membership, silo or Origin returns 403.
Malformed, oversized, non-JSON or extra input returns 400 `invalid_request`.
Stale registration or control positions and conflicting retries return 409 `conflict`.
Dependency failures and uncertain appends return 503 `unavailable`. Every result,
including body parser failures, has no-store and contains no dependency error details.

The unchanged command prepares history within its own ten-second limit, then checks
current admin access and the installation before one conditional append. Access
changes during the write check prevent saving. Changes detected inside the append
callback return the command’s fixed 503 unavailable result. No outer two-second limit includes
history preparation. Re-registration invalidates earlier opt-in even when discovery
reuses the connection id. Company profiles, company selection, OAuth, credential
release, dispatch and screens remain later work. Live company-account use is NOT RUN.
