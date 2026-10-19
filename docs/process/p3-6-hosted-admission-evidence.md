# Hosted MCP namespace checks

19 October 2026. Tests used claimed secondary slot 1 with its services stopped;
slot 2 was free. The owner stack was untouched. Disk space was 91 GiB before testing
and 90 GiB afterwards; DiskPressure was false. Disposable namespaces and policies
were removed. Images were two label-only variants per run of the existing local
computer image, pushed through the private registry without a public pull.

PASS — final live file: 29 tests twice, at 18:57:51 and 18:58:33 UTC (40.03s and 40.66s).
Command: `MCP_HOSTED_K3D=1 DEV_STACK_ID=1 nice -n 10 npx vitest run apps/ops/test/mcp-hosted-k3d.test.ts --maxWorkers=1`.
PASS — lint (including knip and changelog), typecheck, check:events (145 types),
and security-rules (438 tests). Tests used `PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres`.
Lint, typecheck and tests ran under `nice -n 10`. The full root test suite was NOT RUN.

Each scratch policy copy was selected through `MCP_ADMISSION_SCRIPT`, with one guard removed:

| Removed guard | Selected test | Result |
| --- | --- | --- |
| Image/spec binding | `binds image` | Expected FAIL: the wrong image was admitted |
| StatefulSet requester | `denies the admin creating` | Expected FAIL: the admin was admitted |
| Immutable spec update | `creates a Pod` | Expected FAIL: an image update was admitted |
| Required runtime class | `denies gVisor` | Expected FAIL: no runtime class was admitted |

FAIL — the first test commit had no template yet. Earlier implementation attempts
failed on CEL compilation, Pod creation timeout and scale-to-zero validation.
The final runs above passed after fixing field checks and Kubernetes defaults.
The earlier privileged and device fixtures were rejected by Kubernetes validation
before CEL. The follow-up below replaces them with discriminating fixtures.

PARTIAL — hosted execution remains unavailable. Quota moved to 8b under the size
exception, alongside network isolation and secondary startup installation.

## Resize and refusal checks

19 October 2026. The branch was rebased onto `c8e931d081a2594182486dfd250882c9802ac689`.
The rebase completed. Secondary slot 1 was claimed through `claim.sh` after `df -h /`
reported 89 GiB available. The same slot was retained for every run. The owner stack
was untouched.

Both Pod policies now match `pods/resize`. The computer policy also checks Pod
resources against its template; it previously had no Pod resource comparison.
The live tests first created an admitted Pod, then sent a server-dry-run CPU-limit
patch through `/resize`. Before the fix, both patches were accepted and both refusal
tests failed. These tests were committed in `508d7c56b` before the policy changes.

Privileged and block-device fixtures are now valid for Kubernetes. Each tests its
actual generated validation in a separate disposable policy, with an accepted control
request first. This prevents the other template checks from masking the guard.
The missing-limits test uses the same approach to exclude the resource-map-size
check. The tag fixture matches the approved-image entry and explicitly uses
`IfNotPresent`, avoiding Kubernetes' `Always` default for `:latest`.
All refusal fixtures require the policy's own message. The missing-ConfigMap test
still checks the admission system's denial because no validation can run without it.

Scratch copies of the admission script removed one guard at a time. Each run used
the whole live file. The intended result was one failed refusal assertion and
32 passing tests, with no Kubernetes validation error counted as a policy refusal.

| Removed guard | Only failing test | Result |
| --- | --- | --- |
| `privileged` field refusal | `denies privileged` | PASS: expected FAIL, 32 others passed |
| `volumeDevices` field refusal | `denies devices` | PASS: expected FAIL, 32 others passed |
| Image digest format | `denies an approved image tag` | PASS: expected FAIL, 32 others passed |
| Required limits (keep checks when limits exist) | `denies missing limits` | PASS: expected FAIL, 32 others passed |
| `env` field refusal | `denies Secret-sourced env` | PASS: expected FAIL, 32 others passed |
| `ports` field refusal | `denies hostPort` | PASS: expected FAIL, 32 others passed |

The first tag mutation did not fail its test: the default pull policy still refused
it. The explicit pull policy fixed the fixture, and the mutation then failed only
the intended test. An earlier device fixture helper also failed before reaching
admission; correcting top-level field replacement fixed that setup error.

PASS — final unmodified live file: 33 tests twice, starting at 21:39:38 and 21:42:00 UTC
(64.51s and 57.03s). This includes separate hosted and computer resize tests.
PASS — repository lint, including knip and `lint:changelog`; repository typecheck;
`check:events` (147 types); and a final lint/typecheck of the changed ops tests.
All tests used `PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres`.
Lint, typecheck and every test run used `nice -n 10`. Full root suite: NOT RUN,
as requested. Slot 1 was released with `down.sh --id 1`; disk space remained 89 GiB.
No application start path was added. Hosted execution remains PARTIAL for the
same deferred quota, network isolation and startup work described above.
