# Review fixes for long-conversation decisions

Round 1 of 2, slice 1 of 1. The PR remains a draft.

## Findings and reproductions

| Finding | Reproduction before the fix | Fix |
| --- | --- | --- |
| 1 — incomplete index | Removing a saved stop, completion, failure or conversation-close reference, while retaining its event and checkpoint, returned HTTP 200 and sent the approved call. | Prove a complete range of global positions before selecting conversation facts. Keep the separate conversation coverage checks. Refuse before approval consumption, dispatch or spending when either proof fails. |
| 2 — offline replay | The real offline entrypoint failed with PostgreSQL `42P01` because the index table did not exist. | Create the index and coverage tables through the shared table-creation function used by offline replay. Test installations missing both tables, missing coverage alone, and repeated replay. |
| 3 — projection lag | The unchanged cost tests failed on 3,000 messages and cold catch-up. The new lag case returned an upstream timeout. | Read at most 64 global positions after the projection during a decision. For larger gaps, use an already complete event-store summary or refuse with `Conversation history is catching up`. Catch-up runs separately from the refused request. |
| 4 — browser journey | The previous receipt marked approval NOT RUN; CORE explicitly skipped the approval driver. | Connect the existing approval driver and seed one chat with 3,000 valid encrypted messages for both widths. The attempt fails at the first gateway request with HTTP 404. Approval, one send, single use and denial remain unqualified; finding 4 remains open. |
| 5 — read baseline | `lint:reads` found four reads against five recorded in `approvals.ts`, and one unrecorded read in `approval-invalidation.ts`. | Keep the pre-existing fallback in `approvals.ts`, where its baseline belongs. The invalidation helper receives prepared rows. No new unbounded product path or baseline entry is admitted. |
| 6 — insensitive guard tests | Creation and turn guards survived individual removal in the review. | Add isolated subject, silo, type, position, cached-id, missing and duplicate creation cases. Supply unprojected other-turn terminal facts and a snapshot without the bound start. |
| 7 — reply batching | Individual application stored both reply-delta references; batched application omitted them. | Index every reply delta in both paths. Compare the full reference rows and coverage counts across individual and batched application. |

## Why the completeness proof covers omitted facts

A per-conversation count alone was insufficient. An additional test removed a stop
and reduced the saved count as a partial restore might do. That version still sent
the approved call. The failing test was committed before replacing that assumption.

The index now records every global event position. An event outside a conversation
keeps an empty conversation id and cannot enter selected conversation facts.
Positions have a unique index. The covered read position is the lower of the
projection checkpoint and the captured event position. Before using the table, the reader checks that the
number of positions through the covered read position equals that position and
that the first position is one. Unique integer positions in this range must then
cover every position, including any omitted stop or terminal fact.

The reader also checks each conversation's independent count and latest position,
and verifies selected references against real saved NATS events. These checks run
before using either projected facts or an already caught-up summary. A projection
beyond the available history refuses too.

The lag refusal preserves the original two-second decision deadline. It consumes no
approval, admits no upstream call and creates no reservation. The existing cold-process
test then waits for separate catch-up and succeeds using only the remaining tail.

## Operator action

Stop conversation readers and workers. Run:

```sh
npm run replay -- conversations --confirm-conversations-stopped
```

Keep readers stopped until replay completes. The release note names this action.
Fresh installations create the tables normally. The index stores references only;
SQL locates and counts them, while TypeScript decides access and tool behaviour.

## Guard removal evidence

Each removal used an isolated Vitest source transform; saved product files retained
the guards. Each focused test failed with its guard removed, and the normal source
passed afterwards.

- Creation: subject, silo, type, exact position, cached event id, missing creation
  and duplicate creation.
- Approval: terminal turn matching, missing bound start and missing prepared history.
- Index: complete global range, missing coverage, conversation count and latest
  position, separation of other streams, upgrade refusal and batched reply inclusion.
- Activity: the 64-position limit and restored-history refusal.
- Summary: missing and incomplete cached prefixes, a ready prefix and one pending
  catch-up per conversation.

An early missing-start mutation hit a fixture heartbeat failure and was not counted.
Its later isolated run failed the intended assertion. A first missing-coverage test
used an invalid infinite database deadline; it was corrected to the ordinary
finite two-second deadline before counting the removal result. A new foreign-silo probe initially named the wrong error; it was corrected to the
existing participation assertion, `Missing conversation in silo`. No pre-existing
assertion, access check, spending check or memory check was loosened.

The new unique position index also exposed validation ordering: malformed subjects
and foreign-silo events reported a reference conflict before their original
validation error. Two isolated tests reproduce this. Apply the existing conversation
validation and changes first, then write the reference in the same runner transaction.
The unchanged participation tests must keep their original errors.

## Own checks

The final check results and live conditions are recorded in [the journey receipt](journey.md).
Earlier contended checks remain failures in the private logs. Tests used the shared
disposable PostgreSQL database and normal NATS, OpenFGA and gateway fixtures.
Every test, lint, build and typecheck command ran under `nice -n 10`.

The full root suite, paid-provider qualification and second independent review are
NOT RUN. No dependency, event type, API field, gateway timeout, access timeout or
size limit was added or increased. The PR is not ready for merging.
