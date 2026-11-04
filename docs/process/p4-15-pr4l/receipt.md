# Checked private launches

Part of #97. This is the first launch part only. Catalogue assembly/discovery is deferred.
Server production, protocol and runner code are unchanged. Private admission stays disabled.

- PASS: failing-first commit `f834bb11b`. Two production native children shared one
  caller on the base; the regression expected two.
- PASS: 280 focused tests twice across supervisor-identity, private-codex-launch,
  private-proxy, routine-threads, private-stop, private-thread-loads, supervisor-stop
  and bridge-credentials. The final same-thread stale-close case passed twice too.
- PASS: 460 unchanged security-rule tests once; full typecheck, check:events,
  knip and lint:changelog.
- PASS: lint. The first run found an unsafe test assertion; the corrected runtime
  shape check passed both focused lint and the complete rerun.

Production fixtures use the real bridge, supervisor, proxy and pinned native Codex
with a local scripted provider. The fixture supplies the server acknowledgement;
no model request precedes it. The older debugger and Stop fixtures now request a
private turn through that same bridge instead of opening the launch socket directly. Tests check caller separation, control refusal,
capacity, ordinary/routine starts and cleanup. A scripted native child checks invalid
and already-bound IDs, disconnect and expiry. Existing proxy cases check old bindings;
a stale close also leaves a replacement usable. No paid model calls were made.

All test, lint and typecheck commands used `nice -n 10`. Focused tests used one worker
and the requested PG_TEST_URL; none needed a projection database. No dependency was
added. The protected authority/security tests and every #837/#838 path are unchanged.
Full root suite, development stack, host isolation and fresh-install qualification:
NOT RUN. Fixtures do not qualify a host.

## Cancellation before connection

The session opener now lives in `apps/computer/src/private-session.ts`. Closing its
socket cancels the connect wait as well as removing the caller. Cleanup runs once.
The existing runner can then finish its failure path and release the conversation
reservation and preparation count.

- PASS: failing-first proof in commit `783704e3d`. This commit moved the unchanged
  opener into its own module and added the regression. All three cases failed because
  the cancelled turns never finished: Stop, disconnect and socket closure before connect.
- PASS: 309 focused tests across 11 files twice, including every changed test file.
  The runs took 329 and 301 seconds, with no failures.
- PASS: 460 unchanged security-rule tests, full typecheck and check:events.
- PASS: full lint, including Knip and `lint:changelog`. The 34 existing code-length
  warnings remain; the changed files pass focused lint without warnings.

The regression uses the real channel, session opener and proxy caller registry. It
holds two sockets before connect, cancels them, then opens two new sessions over a
local Unix socket in the same conversations. Repeated Stop keeps the replacements
reserved and a third launch remains refused. After cleanup, the signed bridge gate
returns `bridge_quiet` with no preparing or running turns.

The production caller checks are now four small scenarios with named frames and
request payloads. They retain the caller refusal matrix, admission ordering,
two-launch limit, control refusals and ordinary/prepared-routine starts after Stop.
Reading captured requests, trimming whitespace and splitting lines are separate steps.

Both focused runs use one worker, the requested PG_TEST_URL and `nice -n 10`.
The selected tests do not need a projection database. Lint and typecheck also use
`nice -n 10`. Full root tests and fresh-install qualification: NOT RUN.
Admission remains disabled. No development stack was started.
