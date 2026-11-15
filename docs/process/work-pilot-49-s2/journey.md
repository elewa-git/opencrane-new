# Concurrent personal tool accounts

Date: 14 November 2026.
Application source: `3c1ea9595a730cdb921b22e10cae441b3a2d3bca`.
Journey on a fresh dev stack: PASS.

Two members used the same personal-key tool server through their own assistants.
Both simultaneous calls returned their own accounts at 1280 px and 390 px.
B then revoked their connection. B's next completed turn could not use either
account; A's next call still returned account-a at both widths.

## Fresh environment

Claimed secondary slot 1 through `infra/dev-stack/claim.sh`. Kept its ownership
and fleet guards enabled. Ran `nice -n 10 infra/dev-stack/up.sh --fresh` and
`nice -n 10 infra/dev-stack/status.sh`. Startup qualification passed. The bundled
approval journey was explicitly skipped by its runner: NOT RUN, outside this slice.
Fetched main again; the completed rebase includes `1e85888428e91cec9a39bfada3b7f99649b61766`.
Main had not moved.

Checked the one-minute load before claiming, startup, fixture preparation, the
guarded launcher, installation and the browser batch. Waited while it exceeded 10.
The final browser batch started at 7.31. Load subsequently rose during that batch;
no separate test batch ran alongside it. See [load records](prepared-loads.csv).
Tests, typechecking, lint, builds and qualification ran under `nice -n 10`.

Used the existing setup key by file path only. Prepared B's synthetic membership
through events with personal-assistant provisioning. Configured two distinct,
private synthetic keys with permission in the real demo server. Ran
`infra/dev-stack/stage-b-live.ts` with the claimed id and its private accounts-file
path. Its guarded local TLS transport and free model ran the real server and
models processes, NATS, PostgreSQL, OpenFGA and credential custody. Used real
sign-in, separate browser contexts and product controls. Browser API responses
were not replaced.

## Observed journey

| Step | 1280 px | 390 px |
| --- | --- | --- |
| Admin reviews personal keys, identity tool and saved audience | PASS | PASS |
| Original publication confirmed ready | PASS | PASS |
| A enters, verifies and explicitly selects their own key | PASS | PASS |
| B enters, verifies and explicitly selects their own key | PASS | PASS |
| Both personal assistants complete their plain warm-up turn | PASS | PASS |
| Simultaneous calls return account-a and account-b respectively | PASS | PASS |
| B revokes and their next completed turn cannot use a key | PASS: 11,542 ms | PASS: 10,260 ms |
| A still calls as account-a after B's revocation | PASS | PASS |

1. Registered the demo once. Followed the original discovery through three status
   reads. Waited for the initial unchanged catalogue-check event before taking
   the audience snapshot. All four intended grants returned HTTP 200: two people
   and their own two personal assistants. No grant was resubmitted.
2. Reviewed `read_fixture_quote` and `who_am_i`, selected personal keys and named
   `who_am_i` as the identity tool. Submitted publication once. Four reads of that
   original reference confirmed it ready.
3. At each width, both members entered their own keys in My tools, verified the
   named account and chose Use this key. Checked that secret inputs were empty
   before capture. Both personal assistants completed a plain warm-up turn.
4. Submitted the two read turns together. Both completed with the expected account,
   12,500 euro cents and zero recorded effects. Neither returned the other account.
5. Revoked B's selected profile through My tools. B's next turn completed with the
   connect-key guide and no account result. Measured from the revoke submission
   through that completed refusal, including the intervening browser steps.
6. Submitted A's next read. It completed as account-a. Repeated the whole member
   connection, simultaneous-call and revocation path at 390 px.

[Browser observations](prepared-run/observations.json) retain conversation and
profile ids, UTC times and refusal durations. The [saved-event readback](prepared-run/release-readback.json)
confirms distinct personal assistants owned by the respective requesters, overlapping
started/completed turns, one personal release per simultaneous conversation and
leases no longer than 30 seconds. It also confirms no B release between each
revocation and that width's final observation, none in B's refused conversation,
and an A release appended after B's revocation. Scanning the saved events found no synthetic key material.
`leaseIssuedAt` records the event's lease timestamp; append ordering uses positions.

## Screenshots

Inspected screenshots at both widths. Capture checks required empty secret inputs,
masked email text and no horizontal page overflow.

| Screen | 1280 px | 390 px |
| --- | --- | --- |
| Review | [Review](prepared-run/review-1280.png) | [Review](prepared-run/review-390.png) |
| Publication ready | [Ready](prepared-run/published-1280.png) | [Ready](prepared-run/published-390.png) |
| A's verified own key | [A connected](prepared-run/a-connected-1280.png) | [A connected](prepared-run/a-connected-390.png) |
| B's verified own key | [B connected](prepared-run/b-connected-1280.png) | [B connected](prepared-run/b-connected-390.png) |
| A's simultaneous result | [A result](prepared-run/a-concurrent-1280.png) | [A result](prepared-run/a-concurrent-390.png) |
| B's simultaneous result | [B result](prepared-run/b-concurrent-1280.png) | [B result](prepared-run/b-concurrent-390.png) |
| B revokes | [Revoked](prepared-run/b-revoked-1280.png) | [Revoked](prepared-run/b-revoked-390.png) |
| B's next turn refused | [Refused](prepared-run/b-next-call-refused-1280.png) | [Refused](prepared-run/b-next-call-refused-390.png) |
| A after B revokes | [A still works](prepared-run/a-after-revoke-1280.png) | [A still works](prepared-run/a-after-revoke-390.png) |

## Own source checks

See [check records](prepared-checks.json).

- PASS: changed tests twice, 348 tests in six files each time, in 884.69 and
  848.99 seconds. These include the original 400 ms receipt delay, queued
  permission change, unchanged live-window expiry, serial writer ownership,
  private broker binding, no-key dispatch and first-frame tool-offer regressions.
- PASS: 20 final fresh concurrency pairs, 40 HTTP 200 responses. Kept the original
  assertions and real 400 ms receipt delay; no failed sample was retried.
- PASS: deliberately removing the queued access positions or extending the live
  window makes the corresponding guard test fail. Restored both rules.
- PASS: workspace, package and dev-stack typecheck; event catalogue, 174 types;
  Knip; changelog lint; changed-file ESLint; Markdown lint. ESLint reports zero
  errors and three existing enclosing-function size warnings. Their counted sizes
  decreased: 325 to 307, 306 to 288 and 331 to 315. New leaf functions have none.
  Knip retains two existing configuration hints. No limit was raised or disabled.
- PASS: privacy and full-range secret scans before push.
- NOT RUN live: rotation, admin disable, lease attacks, paid/external models,
  public third-party servers, company-account turns or per-assistant consent.
  Automated tests do not qualify those live conditions.

## Earlier failures and collector corrections

The [previous source receipt](journey-before-preparation.md) and
[diagnosis](diagnosis.md) retain the earlier failed concurrency journeys and timing
measurements. The owner's preparation decision replaces the receipt-cache approach.
Those earlier runs do not qualify this source.

A complete source gate after helper extraction passed 346 tests and failed one:
no-key dispatch still repeated receipt reads after removing the cache. A new
400 ms receipt test reproduced HTTP 403 after 2,257 ms. Preparing those facts
before admission fixed it while retaining the original no-key access deadline.
The final 348-test runs above include that regression.

An earlier latency-series fixture failed before dispatch with “Gateway delivery
unavailable”. Its exact child-exit cause remains unproved. A separate control
showed that overlapping Vitest commands could choose the same worker port; that
is not proof of the historical exit. Final Vitest commands ran sequentially.

An initial startup command referenced a key-file path absent from this worktree.
Released its slot and used the existing key's path. Three subsequent fresh setup
attempts were also retained as failures before the target calls:

- [Audience applying](prepared-setup-attempt/failure.json): the collector waited
  on disabled Person instead of using the existing Refresh audience action.
- [Grant conflict](prepared-conflict-attempt/failure.json): HTTP 409 in
  212.65 ms. The initial catalogue renewal was processed 112 ms later. A moving
  server stream can explain that conflict; the exact response reason was not
  captured, so this remains an inference. Subsequent setup waited for the initial
  catalogue check before taking the audience snapshot. The grant guard is unchanged.
- [Publication collector](prepared-publication-attempt/failure.json): four grants
  succeeded, but the collector expected an invented `pending` status instead of
  the API contract's `applying`. A failing-first collector fixture reproduced it.
  The collector now reads the shared protocol status schema. All four fixture
  cases pass, including disabled and changed-reference refusals and rejection
  of the invented status. The original publication is never submitted again.

Each failed setup released its stack. No failed setup or skipped step is counted
as a passing capability journey.

## Made right and cleanup

Removed the receipt cache. Shared authority facts, permission checks, the broker
context schema and request preparation. Kept prepared credential evidence private
inside the broker. Split request handling from dispatch, named the new steps and
removed replaced copies. Updated affected package contracts and the release note.
Shipped source: 629 changed lines, 451 added and 178 removed.

Closed browser contexts, stopped the guarded launcher and ran
`nice -n 10 infra/dev-stack/down.sh` for every claimed attempt. The final slot's
private directory and Compose containers were absent after cleanup. Preserved
25 generated core files and two new core captures outside this slice, then
restored their tracked files. Kept this worktree for review. This is an account
of the builder's checks, not an independent-review result.
