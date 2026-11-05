# Remember on a private thread

For people, read [README.md](README.md) first.

Part of #97, P4-15 PR 4n. Rebased base: `8d4de0b0a`.
Merged prerequisites: PR 4m (#867), `64586a95c1b0b5d1c38126b017561520981af09c`;
PR 3k (#871), `6031183ebb29f8023edf914adb04913a58088884`.
The later production recall/backend work (#883) is included in the base.

## Contract and limits

This is the authorised Remember-only split. All three writes, their receipt recovery,
invalidation journeys and refusal cases would exceed 590 changed lines.
The saved loader uses the combined personal builder but filters policy to Recall and
Remember. Correct and Forget stay excluded even if reviewed. Public discovery is unchanged.
The existing launcher, native thread, authenticated discovery and private result delivery remain.
No consent bypass, new event, API field, dependency or admission enablement is added.
Shell, file, browser, external MCP, skills, plugins and spawning remain unavailable.

Remember retains complete loaded-reference lineage. A turn with saved native initial
loading now remeasures deployment qualification before the write handler's access check.
It confirms qualification and loaded references before saving and before releasing a receipt.
The common reference validator reuses the captured access positions and checks later events.
Remember uses the full `rights.confirm()` after those checks and at the final event append.
It checks later turn, Stop and computer events with the original access positions and
deadline. A saved Stop or replacement generation prevents a write while local caller
withdrawal is delayed, including when the call has waited for its database lock.
Older governed protocol fixtures without native initial loading retain their existing contract;
they do not qualify native deployment. History still loads before the short access check.
The existing agent-command status reader now recognises saved Remember revisions and checks
current references and keys. Unknown status does not submit anything.

## Own checks

Failing-first commit: `b3835055c`. The production fixture could not complete discovery
with Remember offered. Three later regressions failed for unknown saved-command status
and qualification withdrawal before the call and during saving. A further failing regression
changed a loaded fact during saving; the final check now withholds that receipt too. The first test attempt
lacked the pinned gateway binary; that setup attempt is excluded from test evidence.

The tests extend the existing real NATS, PostgreSQL, OpenFGA, gateway, backend and proxy
fixture. Only native protocol and deployment observations are scripted. Discovery reads
no facts. The actual write event, receipt, later recall and original-command status are checked.
The saved-load refusal matrix now carries Remember too. Native notifications admit only
the loaded Recall/Remember definitions, and two sessions retain independent catalogues.

Checks run under `nice -n 10`, with one Vitest worker and `--no-file-parallelism`.
PostgreSQL uses a task-owned disposable container and its assigned loopback port.
Selected suites: `remember-backend-delivery`, `recall-backend-delivery`,
`personal-memory-tools`, `private-recall-runner`, `private-recall-preflight`,
`private-proxy`, plus the unchanged event security rules.

- PASS: final six-suite run, 219 tests; all 15 Remember cases passed twice.
- PASS: changed loading suites repeated, and 460 unchanged event security cases once.
- PASS: workspace typecheck, then final server/computer typechecks; event and changelog checks.
- PASS: all lint stages, including Knip. A full code scan found one new complexity error;
  the corrected files passed focused lint. Documentation links were also corrected and rechecked.
- FAIL in an earlier run: one same-user session did not start before the fixture deadline.
  The final complete run passed that case. Early type errors and reference-check timeouts were fixed.

NOT RUN: full root suite, model calls, development stacks and fresh-install qualification.
Correct/Forget production delivery and the complete journey remain held. Admission stays off.

## Stop and replacement regression checks

Date: 5 November 2026. Failing-first commit: `0e9e63abc`, after rebasing onto
`8d4de0b0a`. The rebase completed and the base is an ancestor of the branch.

The four new backend cases first failed: each found one saved memory write where zero
were required. Two hold a real PostgreSQL command lock, save Stop or a replacement
computer generation, then release it. Two save those events before the event store's
final append check. All keep the local caller registered. With full confirmation
restored, all four pass with zero saved writes and no returned memory receipt or text.

These checks use the existing local NATS, PostgreSQL, OpenFGA, gateway, backend and
proxy fixture. They use a scripted native peer and deployment observations, rather
than a fresh installation. PostgreSQL for this run is the supplied test service at
`127.0.0.1:55432`. All commands use `nice -n 10`; Vitest uses one worker and
`--no-file-parallelism`. Logs on the task host are `/tmp/p4-15-pr4n-red.log` and
`/tmp/p4-15-pr4n-green.log`.

The test schemas and expected responses now have names. The notification branches
use braces, and the permission assertion has separate expected and observed values.
An initial typecheck found an unchecked `unknown` event in the new append test hook;
the hook now validates it with the existing event schema.

An initial full-confirmation change passed the four refusal cases but failed four normal
Remember cases in the six-file run (219 passed, 4 failed). The reference validator was
repeating the full permission check. The final ordering keeps the captured access check
inside reference validation, then runs full turn, computer and access confirmation.
It also uses full confirmation at append. The normal-save control and all four refusal
cases pass with this ordering. No timeout or assertion was relaxed.
