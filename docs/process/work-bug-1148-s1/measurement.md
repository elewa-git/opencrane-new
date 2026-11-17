# Long-conversation decision measurements

Measured with the real NATS event store, PostgreSQL, OpenFGA and pinned gateway.
The tool requires approval. A successful decision therefore returns HTTP 403 and
creates a requested approval card. HTTP 503 is the reproduced bug.
No timeout or retry setting changed. Tests ran at reduced CPU priority on a shared host.

## Before

The first commit imports the failing test from `951939bb0`. It fails at the gateway
call in `prepareLongConversation`: expected 403, received 503, `upstream call timeout`.
Measurements below precede product changes. Each size uses a fresh fixture and cold
conversation summary. Counts cover returned event rows, including a summary read that
continues after the gateway has returned its two-second timeout.

| Earlier messages | Decision ms | HTTP | Total events read | Conversation events read | Conversation read ms |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 100 | 1,149.59 | 403 | 126 | 103 | 619.30 |
| 1,500 | 2,023.50 | 503 | 1,506 | 1,503 | 5,846.08 |
| 5,000 | 2,012.00 | 503 | 2,155 | 2,152 | 10,000.18 |

At 5,000 messages the summary's existing ten-second background catch-up deadline
ends the read before all 5,003 conversation records can be returned. The decision
already timed out at two seconds. The increasing read is `readTurnActivity` loading
`decisionChatSummary` for `conversation-conversation` from position 1. It fetches
one NATS message at a time. Approval logic has not yet run when the gateway times out.

## After

Final bounded measurements are recorded in the qualification ledger. The regression
observes both `readStream` and `readEvent`, counts every returned event during one
real gateway decision and requires at most eight conversation events and forty total
events. It also requires HTTP 403 and one requested approval card. Earlier message
seeding happens before measurement and uses bulk fixture projection rows.

The projection indexes event positions. A decision loads creation, participation,
closing and current-turn records, the queued message, and the latest message and
turn start needed for approval invalidation. Output reports are excluded. It reads
unprojected activity only from the saved projection position. Access confirmation
then reads only activity saved after the request's captured position.

## Strength checks

- PASS: restoring the original whole-conversation path makes the 5,000-message test
  fail its read-count assertion: 915 conversation events, against a limit of eight;
  HTTP 503 after 2,017.02 ms. The bounded reader was restored.
- PASS: the held-call status regression first failed after reading 2,873 conversation
  events. It now answers HTTP 200 and stays within eight conversation events.
- PASS: bypassing creation validation made the first-event test accept another silo.
  Its refusal assertion failed. Validation was restored.
- Existing assertions remain unchanged. Read observers forward the new optional
  upper position so instrumentation preserves the event-store contract.
