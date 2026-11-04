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
