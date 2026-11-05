# Container prerequisite checks

5 November 2026. Part of #97. Base: `79afe7aff`. Test-first commit: `39b94cc67`.
This is the first bounded part. It applies the orchestrator's container default;
the owner has not answered and no owner approval is claimed.

The existing safe-host path remains. The alternative proves only the runner's
own cgroup v2 limits and process protection. It returns NOT RUN without starting
server or native journeys. Other plaintext-bearing processes and guest kernels
still need equivalent proof. Both complete qualifications remain NOT RUN and
memory admission remains disabled. Cgroup v1 is deliberately refused in this part.

| Own check | Result | Evidence |
| --- | --- | --- |
| npm ci and tool links | PASS | Installed in this worktree; no dependency changed. |
| Failing first | PASS | Two suites failed to import the missing probe before implementation. Tests were committed first. |
| First targeted run | PASS | 85 tests, including real image-owned measurements in disposable restricted containers. |
| Final changed tests twice | PASS | 88/88 on each final run, including six real container tests. |
| Host/refusal/cleanup regressions | PASS | 205/205 in the wider run; 108/108 later included the memory journey fixtures. |
| Event security rules | PASS | 460/460; the test file is unchanged. |
| Package image | PASS | Complete build and a protected non-root runner in a disposable restricted container. |
| Repository and collector typechecks | PASS | All workspaces, package, dev-stack and collector. |
| Events and changelog | PASS | 158 event types agree; the branch fragment passes. |
| Lint and Knip | PASS | Final full lint completed: zero errors, 36 existing warnings. |
| Deployment qualifications | NOT RUN | No installation, native journey or persistence scan. |

The initial collector typecheck found a narrowed helper type; an explicit helper
type fixed it. Focused lint then rejected the native-module type assertion; the
loader now checks its shape and requires actual boolean results. Full lint then
passed. Knip excludes only the image-generated native import. One repeated
container test exceeded Vitest's five-second default. Its Docker work finished
within the existing fifteen-second command bound; the fixture now has the same
thirty-second outer limit as neighbouring container tests. Final repetitions pass.
Fixtures use made-up values and cannot qualify a deployment. The
real image test builds the package's helper stage and reads effective controls
inside read-only, network-free containers with all capabilities dropped. A negative
identity-change fixture adds only SETUID to test that transition. Cleanup removes
each test container with its volumes and removes the test image.

All tests, lint, typechecks and builds run under `nice -n 10`. Selected suites use
`PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres`; they do not use
PostgreSQL projections. No full root suite, stack, model call, image promotion or
host setting change is part of this work. Authority and security-rule tests stay
unchanged. No event or public API field is added. Failure forwarding, withdrawal,
challenge/install binding and supervision retain their existing contracts.

## Protection refusal fixes

5 November 2026. Rebased onto `7570a266c`. Failing-test commit: `eea9604fc`.
Implementation: `64bb8c776`; portable fixture expectations: `7c703b1b4`.
Environment: shared development host and disposable Docker containers, not a
fresh deployment. No live qualification was attempted.

The runner now keeps a fixed failure category instead of reducing every failure
to false. The collector saves that category and its plain message. The launcher
keeps both when it withdraws earlier evidence. Unknown categories, extra fields
and private paths are refused. The native helper still measures the actual runner.
Request fixtures now build named objects before serialising them.

The first tests reproduced the missing detail: 43 probe, journey and collector
assertions, 17 helper assertions, and 15 selected Docker assertions failed before
the implementation. The tests were committed first.

The first wider run had two failures. One expected the wrong category for the
local host. Its replacement checks the exact refusal against the fixed allowlist
and requires the matching saved message; the controlled launcher fixture now
makes its missing cgroup explicit. The other failure was the native `shell_tool`
case's existing cleanup assertion, which found an app-server process or a private
home after refusal. No cleanup assertion, production check or timeout was relaxed. The unchanged
native suite then passed twice, including that cleanup assertion.

| Own check | Result | Evidence |
| --- | --- | --- |
| Rebase | PASS | `origin/main` at `7570a266c` is an ancestor; rebase finished. |
| Failing first | PASS | The test-only commit precedes the implementation. |
| Final combined collector run | PASS | 298/298 tests across ten selected suites. |
| Changed suites repeated | PASS | Every changed suite passed twice; the corrected 77-test collector suite also passed separately. |
| Native package image repeated | PASS | 41/41 in the final combined run and 41/41 in the last standalone run. |
| Local launcher | PASS | 42/42 twice after making the missing cgroup explicit. |
| Repository and collector typechecks | PASS | All workspaces, package, dev-stack and collector; changed fixtures checked again. |
| Full lint and Knip | PASS | Zero errors; 37 existing lint warnings. |
| Events and changelog | PASS | 158 event types agree; the branch fragment passes. |
| Full root suite | NOT RUN | Excluded from this task. |
| Deployment qualifications | NOT RUN | No fresh installation or live memory journey. Memory remains disabled. |

The selected collector suites were `container-probe`, `journey`, `deployment`,
`runner-protection`, `runner-image`, `container-process`, `journey-container`,
`native-image`, `host-probe` and `result`, using the collector's Vitest config.
The launcher used `infra/dev-stack/memory-qualification.config.mjs`.
All checks, builds and tests used `nice -n 10`. Test runs used the requested
`PG_TEST_URL`; none used PostgreSQL projections. Fixture containers and images
were removed by their test cleanup. No stack, model call, image promotion or
host configuration change ran.
