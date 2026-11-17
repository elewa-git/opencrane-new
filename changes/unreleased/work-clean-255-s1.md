Approval listing always uses the supplied approval request rows, so a direct caller
cannot fall back to scanning the whole silo history. Read-count checks cover idle
listing, a stopped audit projection and a conversation with 50 approvals.
