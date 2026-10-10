# Tool approvals and dispatch records

`GET /api/conversations/:conversationId/approvals` returns `cards` and a
conversation-bound `csrf` token. It requires chat access and keeps cards within
the person's latest period of participation.

Cards name absent reviewed arguments in `missingFields`. An incomplete review
has `canApprove: false` and `canDeny: true` for its requester. Its target may be
empty; other review text remains required. `canDecide` stays false for older clients.

`POST` to the same route accepts `{ approvalId, decision }`, with decisions
`approved`, `rejected` and `retry`. Only the requester can act. Origin, CSRF and
any required recent sign-in checks still apply. Missing fields block approval
and permit consumption, while requester denial remains available.

`canRetry` requires recorded proof of failure before dispatch. A `retry` command
records `approval.retry_requested` and allows one replacement permit. The original
live turn must submit the unchanged call again. Access, tool policy, expiry and
the bound turn are checked again. Concurrent commands cannot both succeed.
A changed request, missing observation or uncertain outcome cannot grant a retry.

Conversation HTTP and socket rows include `tool.dispatch_recorded`, with
`requestId`, `logicalRequestId`, `callId`, `serverId`, `toolName`, `startedAt`,
`durationMs`, `outcome`, `evidence` and an `approvalId` for Ask calls. The row's
`time` is the gateway's UTC observation time. Equal `logicalRequestId` values link
attempts; Ask calls use their saved approval id. `responded` means an HTTP reply
arrived; it does not claim success.
Only the pinned Linux gateway's refused TCP connection proves `not_dispatched`.
An HTTP error, tool error text or zero charge never proves this.

`agent.native_consent_refused` rows record `mcpServer/elicitation/request`, naming
the native request, server and bound turn. A known offered server supplies `serverId`.
The native protocol supplies no tool call id, so none is invented. Consent text,
schemas, arguments and credentials are excluded. The computer returns an
unsupported-request error and grants no permission.
