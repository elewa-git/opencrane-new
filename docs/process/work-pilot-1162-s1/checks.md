# Own checks for pilot VM bootstrap

Date: 20 November 2026. Environment: development box, no host changes.
Source and complete gate results are recorded below once the run finishes.

## Failing first

- `4e44f7e75`: nine new tests failed because the bootstrap and shared helper did
  not exist. The [red log](logs/red.log) retains the missing-script failure.
- `1bbf2b733`: the simulated rerun failed because the guard rejected the kubelet
  directory created by its own k3s installation. The
  [failure log](logs/idempotent-red.log) names that refusal. The fix permits this
  directory only for the recorded installation with a matching k3s checksum.
- An intermediate ShellCheck run reported unused shared constants and an unknown
  OS-settings source. Exporting the externally used constants and declaring the
  trusted OS-settings input resolved those diagnostics without suppressing a rule.

## Test scope

Run `nice -n 10 node --test infra/vm/bootstrap.test.mjs` twice after final cleanup.
It checks ShellCheck, complete dry-run output without writes, existing Docker,
Kubernetes, containerd and microk8s refusals, invalid arguments/distribution,
identical configuration on rerun and a replaced k3s executable.

Each container has no network, all capabilities dropped, no extra privileges and
only a read-only source mount. A Debian image with a synthetic Ubuntu distribution
record exercises the script branch. Stubbed apt, downloads, archive extraction,
swap, sysctl and systemd do not prove their actual Ubuntu behaviour.
The first real bootstrap and reboot on a pilot VM remain NOT RUN.

## Make it right

Share the existing release pins, verified download function, RuntimeClass and
Agent Sandbox installation functions in `infra/devbox/runtime.sh`. Import them
from both bootstraps and remove the replaced copies from the developer setup.
Use local variables in shared functions rather than leaking intermediate names.
Keep validation, node protection, payload installation, service configuration and
file/command output in separate named functions. Test callbacks have named
function declarations. No dependency, size limit, event type, business rule,
image-approval rule, runtime retry or readiness deadline is weakened.

Repository ESLint excludes infrastructure. Record that exclusion explicitly;
a supplementary temporary recommended JavaScript configuration applies complexity
15, depth 4, function length 80 and five-parameter limits to the changed test file.
ShellCheck covers all three changed shell files. No independent review is claimed.

## Live qualification

See the [journey receipt](journey.md). Package and browser journeys, measurements,
a VM minimum and measured headroom remain NOT RUN. There were no screenshot or
service-log artefacts to lose at teardown because no stack was claimed.
