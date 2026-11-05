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
