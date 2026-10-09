# Invitation assistant choices

Part of #85. This is the first of two changes for the work left after #279.

## Scope

Bound invitations can record `personalAssistant: provision|none`. The existing
join command copies that choice into its one join event. Older invitations mean
`provision`. The accepting person cannot change the choice in the request.
The assistant reaction skips `none`. Older joins and bootstrap retain their
existing behaviour. A join receipt proves membership; assistant creation and
computer readiness are later, separate results.

The second change will add Owner/Admin email invitation create/renew and
acceptance that binds the account and selects its admission id. It must settle
two accounts with the same verified email using one invitation's stored outcome.
It will keep the verified-email, recent-sign-in and organisation checks from #279.
The current command uses the same member stream for invitation and acceptance;
the final admission id is not known when an email invitation is created.
Adding those commands, their stored outcomes and every requested guard test
would exceed the requested 600-line change limit. They are not enabled here.

## Failing-first evidence

- Event schema tests failed twice: `provision` was refused for invitation and join events.
- Three HTTP cases failed because the saved join lacked the invitation's choice.
- The `none` reaction test failed: one assistant event existed instead of zero.

These tests inspect real saved events. HTTP and reaction tests use disposable
NATS; reaction tests also use disposable PostgreSQL transactions. The crash test
kills a separate Node process after assistant creation and before delivery can
acknowledge completion. A repeated delivery after restart keeps the same event.
It does not test the full dispatch queue or live computer readiness.

## Checks

The first regression run passed 92 tests, including the four requested server files.
The repeat run passed 272 tests, including the generated event examples.
The restored code passed all 76 changed tests after the mutations.

| Check | Result |
| --- | --- |
| `npm run lint` | PASS, including docs, links and dependency checks |
| `npm run typecheck` | PASS; updated ops and server checked again |
| `npm run check:events` | PASS, 98 event types |
| `npx knip` | PASS |
| `npm run lint:changelog` | PASS |
| Changed tests twice and requested server regression files | PASS |
| Independent review and CI | Pending on the draft PR |

All eight temporary mutations caused assertion failures. They allowed invalid
invitation/join choices, allowed a bootstrap choice, ignored the invitation choice,
changed the older-event default, accepted a body override, removed the `none`
check or changed the stable assistant id. Each original file was restored before
the next mutation. No mutated code is part of this change.

No full root test suite or fleet batch was run. Test, lint and typecheck commands
use `nice -n 10`.

Fresh-install invitation journey: NOT RUN.
Email invitation create/renew and same-email acceptance race: NOT RUN; deferred.
The full remaining invitation outcome is PARTIAL until the second change lands
and its fresh-install journey passes.
