# Personal memory qualification

25 October 2026. Part of #94. Part of #95. Both tickets remain PARTIAL.

The journey uses this worktree's claimed secondary slot 1, an empty installation,
real SSO and the existing local model stub. Native memory is off. Browser search
does not qualify governed MCP recall: that path is NOT RUN.

Prerequisites merged: #646 `59a81b70f9a66fb6597ec3027065eb292c0c8c28`;
and #641 `105071aaa08e82c638276886936c8538c007a9f3`.
Stage B live3's final task report records release of its slot before this claim.
Product source: `105071aaa08e82c638276886936c8538c007a9f3`, including Edit UI `b3953fccb`.
No Stage B or memory product files changed. Both authority tests are unchanged.

The first test commit is `77aaeb8c2`. Its first run failed because the checker
module did not yet exist. The implemented checker rejects missing receipts, stale
revisions, forgotten text, repeated writes during recovery and replay effects.

The first startup attempt could not find the SSO setup credential in this worktree.
Supplying its existing path through `ZITADEL_KEY_FILE` allowed startup to finish.
No credential values were logged. No private memory custody files were inspected.

Run command: `DEV_STACK_ID=1 MEMORY_CLAIMED_ID=1 nice -n 10 node
--experimental-strip-types infra/dev-stack/memory-personal-live.ts`.
The setup credential path must also be supplied for retained restarts.

Original observations are saved in [observations.jsonl](observations.jsonl).

## Live result: PARTIAL

- PASS: empty membership history, real SSO, token claim and owner confirmation.
- FAIL: the first Memory panel load returned HTTP 503 and displayed
  “Memory is unavailable”. Store was not reachable. The cause is not established.
- PASS: later read-only diagnosis on the same installation returned HTTP 200 with
  the personal scope and an empty list. This does not replace the first-load failure.
- PASS: the local model counter reported zero requests. No paid calls were made.
- NOT RUN: store, search with a saved fact, detail, correction, forgetting,
  lost accepted reply, GET-only recovery, retained restart and stopped-worker rebuild.
  Cleanup receipts, retained revisions and absence of forgotten text remain unproved live.
- NOT RUN: governed MCP recall, native memory, other scopes, keyboard and assistive technology.

The [safe server extract](scopes-log.json) keeps only request ids, method, path and
status. It confirms the first 503 and later 200 reads. The initial collector did not
save that first response body. The tracked helper now records the scopes reply before
checking its status. A read-only diagnostic exercised that helper successfully.

The implementation is deliberately split. This first part supplies the acceptance
checker and fresh baseline collector. Completing the browser writes, response-loss
check and offline rebuild in a reproducible collector remains in the next part.
Memory replay refuses `--verify`; that part must use `--confirm-memory-stopped`
and compare rebuilt reads, original receipts and event/model counts.

## Pictures

All four saved images were inspected. Email masking is enabled. The original
[desktop failure](failure-1280.png) shows the unavailable panel. The original
[phone capture](failure-390.png) shows the closed panel after resizing, so it does
not establish the phone failure state. Later read-only captures show the empty panel
at [1280](later-read-only-1280.png) and [390](later-read-only-390.png).
The phone picture caught the opening transition; it is not a layout pass.
The helper now disables screenshot animations.

All ten supplied MEM-30/33/34/40/41 reference images were inspected. Their form and
receipt comparisons remain NOT RUN because the first journey stopped before Store.
Changing width recreates the panel. The later write collector must keep submitted
forms at their original width and qualify both widths through separate browser steps.

## Local checks

PASS: eight checker tests twice; CI test-selection guard; 438 event security tests;
event catalogue; full lint; full workspace typecheck; knip; documentation and changelog checks.
All tests, lint and typecheck commands ran under `nice -n 10`.
Lint reported 25 existing function-length warnings outside this change and no errors.
The event security run used a disposable PostgreSQL 17.6 database on port 37120
with `PG_TEST_URL` set. Its container and volume were removed afterwards.
The full root suite was NOT RUN, as requested.

Replacing the checker with an empty function in a temporary fixture gave seven
expected assertion failures and one passing positive case. No repository mutation
was left behind. These are acceptance-checker tests, not live product guarantees.

PASS: `down.sh --id 1` completed. Only this worktree's claimed resources were released.
