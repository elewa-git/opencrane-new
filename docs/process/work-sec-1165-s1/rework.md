# Refusal audit rework

Product source: `3d0fda81e`. Test-first commit: `3b993bb93`.
Final capacity fixture: `1e83bf257`.
Own source checks: PASS. Fresh journey results are recorded in [journey.md](journey.md).

## Findings and proof

1. **Anonymous WebSocket refusals — PASS.** The initial direct and forced-capacity
   probes returned 403 but moved the real event-store global head from 8 to 9.
   The final capacity fixture issues 16 valid tickets and holds real start-audit
   replies after NATS saves their events. A signed-in probe proves capacity is
   full by saving one refusal with reason `capacity`. On the reviewed source, an
   anonymous request then moved head 26 to 27; an invalid-session request moved
   head 28 to 29. Both final tests now leave it unchanged, without mocking the
   capacity decision. Cleanup waits for all 16 stop audits.
   Every refusal caller supplies the session-validity boolean explicitly; the
   refusal helper has no authenticated default.
2. **Origin refusals — PASS.** The failing-first POST probe observed head 8 where
   9 was required for a valid session with missing Origin. WebSocket and capacity
   probes observed an extra event for an invalid session. Session validation now
   happens separately from the Origin decision. The tests cover missing and
   hostile Origins on POST, WebSocket upgrade and capacity paths: a valid
   organisation session adds exactly one `computer.view_refused`; an invalid
   session adds none. All requests remain refused.
3. **Registration size — PASS.** ESLint's size rule measured 374 counted lines on
   the pre-slice base, 387 on the reviewed head and 361 after this fix. The probe
   with a maximum of 374 failed on the reviewed head. Refusal creation and logging
   now live in the module-level `createViewRefusal` helper. Session validation is
   also a module-level helper. No size limit or suppression was raised.
4. **Test clarity and strength — PASS.** A TypeScript syntax-tree probe found two
   inline scenario callbacks before the rewrite and zero afterwards. All seven
   scenarios are named functions. Session and request arguments use named
   constants. The original global-head assertions remain. Disabling the anonymous
   guard made only the anonymous scenario fail (head 9 instead of 8); disabling
   the signed-in marker made only the signed-in scenario fail (head 8 instead of
   9). Both probes ran the two original scenarios together, and both mutations
   were restored.

The failing-first run reported five failures and two passes. The final focused
run passed all 73 tests across `live-view-anonymous`, `live-view`,
`live-view-admission` and `view-lease` (113.58 s). After the shared event parser
was added to the fixture, the seven changed scenarios passed twice separately
(32.47 s and 28.17 s). All final runs used the corrected product
source above, the shared disposable PostgreSQL database, `nice -n 10` and
`--maxWorkers=2`.

## Own gates

- PASS: workspace, package and dev-stack typecheck; server typecheck passed again
  after strengthening the fixture.
- PASS: `check:events`, with all 174 event types matching.
- PASS: Knip; its two existing configuration hints remain.
- PASS: changelog lint and scoped ESLint, with no warnings on the changed code.
- PASS: README and whole-stream-read checks; no new whole-stream read.
- PASS: Markdown lint, public privacy check and secret scan.

The branch contains the fetched `origin/main` at `c791103b3`; no rebase was needed.
The PR remains a draft. This receipt reports only the builder's own checks.

## Fresh-stack startup correction

Fresh startup reached a PostgreSQL connection termination before CORE. A separate
Docker fixture held PostgreSQL's temporary init server open. The inherited probe
returned 0 (ready), although TCP was not available; the failing-first test commit
is `77f3c54ed`. Secondary stacks now use a TCP readiness probe, leaving the owner
configuration and all timeout/retry settings unchanged. The test then passed twice
(14.18 s and 13.81 s), including both initial refusal and final readiness. Scoped
ESLint, Knip, event, changelog and README checks passed again after the correction.
