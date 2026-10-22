# Tool approvals and dispatch records

`GET /api/conversations/:conversationId/approvals` returns `cards` and a
conversation-bound `csrf` token. It requires chat access and keeps cards within
the person's latest period of participation.

Cards name absent reviewed arguments in `missingFields`. An incomplete review
has `canApprove: false` and `canDeny: true` for its requester. Its target may be
empty; other review text remains required. `canDecide` stays false for older clients.

Cards carry `requestedAt`, `decidedAt`, `usedAt` and `endedAt` when the corresponding
saved event exists. Each value is the saved event's time, converted to UTC. `decidedAt`
and `usedAt` retain the first decision and use through retries. `uses` lists each
consumed permit and its own `usedAt`, in event order. Use means `outcome_unknown`;
it never proves that a tool succeeded. `endedAt` dates denial, expiry or cancellation.
Expiry keeps its original `expiresAt` as well as the time expiry was recorded.

`cancelReason` is an optional fixed code copied from `approval.cancelled`.
Old cancellations have no reason. New cancellations distinguish stopped or ended
turns, a new message or turn, conversation closure, unpublication, changed connection,
policy, schema or profile, and a revoked direct requester or assistant tool grant.
A missing turn or elapsed catalogue check without a saved cause has no reason.
Removing a grant and later restoring it does not revive the old approval.
These reasons contain no review values, arguments, tool results or credentials.

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
`time` is the gateway's or models process's UTC observation time. Equal `logicalRequestId` values link
attempts; Ask calls use their saved approval id. `responded` means an HTTP reply
arrived; it does not claim success.
The pinned Linux gateway's refused TCP connection proves `not_dispatched` with
`evidence: connection_refused`. The models process also records `not_dispatched` with
`evidence: dispatch_refused` when a check refuses after a confirmed saved start and
before opening the upstream connection. This latter evidence does not enable an approval
retry. For a remote HTTPS call, `adapter_dispatch_refused` carries the exact saved
start and permit details and proves that no connection was opened. This evidence
enables one requester retry. A lost start reply remains unknown. An HTTP error,
tool error text or zero charge never proves non-dispatch.

`agent.native_consent_refused` rows record `mcpServer/elicitation/request`, naming
the native request, server and bound turn. A known offered server supplies `serverId`.
The native protocol supplies no tool call id, so none is invented. Consent text,
schemas, arguments and credentials are excluded. The computer returns an
unsupported-request error and grants no permission.
