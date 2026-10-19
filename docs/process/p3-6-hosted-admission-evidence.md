# Hosted MCP namespace checks

19 October 2026. Tests used claimed secondary slot 1 with its services stopped;
slot 2 was free. The owner stack was untouched. Disk space was 91 GiB before testing
and 90 GiB afterwards; DiskPressure was false. Disposable namespaces and policies
were removed. Images were two label-only variants per run of the existing local
computer image, pushed through the private registry without a public pull.

PASS — final live file: 29 tests twice, at 18:37:58 and 18:38:51 UTC (50.15s and 51.38s).
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
Privileged and device fixtures are rejected by Kubernetes validation before CEL;
those cases do not independently prove the matching CEL checks.

PARTIAL — hosted execution remains unavailable. Quota moved to 8b under the size
exception, alongside network isolation and secondary startup installation.
