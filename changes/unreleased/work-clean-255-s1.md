Approval listing always uses the supplied approval request rows, so a direct caller
cannot fall back to scanning the whole silo history. Read-count checks cover idle
listing, a stopped audit projection and a conversation with 50 approvals.
Gateway approval checks discover every candidate request, so changed call arguments
cannot hide an unwanted second approval behind the original request stream.
