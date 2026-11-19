Tool calls in long chats can request approval and accept the person’s decision without
replaying earlier messages. Gateway decisions and approval reads use saved event
positions while keeping the existing access, payer, turn and approval checks and timeouts.
Foreign approval ids receive the same refusal as missing ids before their conversation
history is loaded or cancellation is prepared.

Decisions refuse if conversation index rows or coverage proof are missing. Long
projection gaps refuse with a visible catch-up message until saved history is ready.
Individual and batched replay build the same index. Before upgrading an existing
installation, stop conversation readers and workers, then run
`npm run replay -- conversations --confirm-conversations-stopped` to rebuild it.
Keep readers stopped until replay completes.
