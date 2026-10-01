# Stub qualification evidence — 1 October 2026

Tested locally on macOS 15.7.4 arm64, Node 22.15.0, npm 11.3.0,
Codex 0.159.2, agentgateway 1.5.0, Vitest 3.2.7. No Docker, cloud deployment,
provider request or credential access. Existing pinned dependencies were reused;
a fresh dependency installation and Linux execution are NOT_RUN.

The final suite ran three consecutive times, with a new runtime state for every
test: fresh ports, signing keys, counters, upstream, gateway and Codex home.
Each afterEach stops its services, asserts the native child PIDs no longer exist,
and removes the test directory. Source: `tests/smoke.test.ts`.

| Round | Local start time | Test result | Duration |
| --- | --- | --- | --- |
| 1 | 10:03:57 | 10/10, PASS | 13.61 s |
| 2 | 10:04:11 | 10/10, PASS | 11.25 s |
| 3 | 10:04:23 | 10/10, PASS | 12.83 s |

The ignored `.state/stub-validation.log` holds the full local test output.
TypeScript strict/NodeNext checking also completed three times with no errors.
No repository-wide lint, test or event-catalogue check was run: work and
verification were scoped to this spike while other agents changed other folders.

Assertions cover bounds and legacy names, hosted/nested/case-variant tools,
model allowlist, six concurrent reservations, malformed and oversized bodies,
both token signatures/expiry/audiences/binding, routes/methods and ext_authz
outage, upstream errors without gateway retries, real/stub config parity,
price preflight, header removal, live Codex tool use and streamed output,
streamed gateway usage and integer costs, missing usage, isolated home and
spawn environment, safe log filtering and native child shutdown.

Stream observations: 1000 input / 120 output tokens and 1100 input / 121 output
tokens, two different reservation IDs, 1 cent each at fixture prices. The
truncated-stream assertion retains PARTIAL status instead of inventing usage.

The standalone list-models helper also returned `stub-model` and
`stub-model-large` through its own stub gateway, then exited.

`run-real.sh` and `leak-check.sh` were reviewed line by line and parsed with
`bash -n`; neither was executed. The leak scanner was syntax-checked, not run.
The true credential's path was only written inside `run-real.sh` and the file
was never accessed. Real provider behaviour, actual-key leak checking, real
pricing/account access and OS process-environment inspection remain NOT_RUN.
The last was attempted for our own stub child but blocked (`ps` EPERM); the
suite instead asserts the exact environment used in the actual spawn call.

All test processes were stopped. Probe files and temporary homes were removed.
Remaining footprint is about 450 MiB, mostly the existing pinned binaries and
node_modules. No files outside this task folder were deliberately edited;
no git add, commit, checkout, stash or push was run.
