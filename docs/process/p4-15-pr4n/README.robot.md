# Remember on a private thread

For people, read [README.md](README.md) first.

Part of #97, P4-15 PR 4n. Base: `7570a266c41110bb9b94595c4596817ec13487b2`.
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
