# Own checks for pilot VM bootstrap

Date: 20 November 2026. Environment: development box, no host changes.
Implementation source: `412bb98758bd8c37a2c6686c0a0c38aeb3803b35`.
The final repeats exercised those source files before the implementation commit.
The test image was `node:22.23.1-bookworm-slim`, locally recorded as
`node@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3`.
This is a test fixture image, not an approved application package.
Receipt copies replace the checkout and temporary-check paths and trim trailing
whitespace. A whitespace check initially found trailing spaces in captured tool
output; the normalised copies pass without changing their observations.

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

PASS: `nice -n 10 node --test infra/vm/bootstrap.test.mjs` twice after final cleanup,
11/11 each, no skips: [first run](logs/final-1.log), 25.82 seconds, and
[second run](logs/final-2.log), 24.89 seconds.
The [complete dry-run output](logs/dry-run.log) was captured separately in the same
unprivileged, isolated container setup.
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

## Gate results

All test, lint and typecheck commands ran under `nice -n 10`.

| Check | Result | Evidence |
| --- | --- | --- |
| Changed tests twice | PASS | 11/11 each, linked above |
| Full workspace, package and dev-stack typecheck | PASS | [Output](logs/typecheck.log), exit 0 |
| ShellCheck, all three changed shell files | PASS | [Output](logs/shellcheck.log), also asserted by both test runs |
| Event catalogue | PASS | [174 types](logs/events.log) |
| Knip | PASS | [Output](logs/knip.log), two existing configuration hints |
| Changelog lint | PASS | [Output](logs/changelog.log) |
| Markdown lint | PASS | [565 files](logs/markdown.log) |
| Repository scoped ESLint | NOT RUN for infrastructure | [Ignored by repository configuration](logs/eslint-scoped.log) |
| Supplementary JavaScript lint | PASS | [Output](logs/eslint-extra.log), recommended rules and standard size/complexity limits |
| README structure, process privacy and ledger checks | PASS | Commands completed without violations |
| Web tests/build | NOT RUN | No website source changed |

No full root test suite, live-view batch or independent review ran.

Shipped code: **325 lines**, 268 added and 57 deleted: VM bootstrap 205 added,
shared helper 60 added, developer setup 3 added and 57 deleted. Tests, documentation,
release notes and receipts are excluded. The CI change adds the test file to the
existing Node test job and is one additional workflow line.
New/changed production functions have at most 38 counted lines and three parameters;
no in-file size limit or lint baseline was raised.

## Short work log

1. Checked main/open PRs and owner comments before building; installed worktree
   dependencies and the requested tool symlinks.
2. Committed missing-script and rerun failures before their fixes; shared the
   verified runtime setup and added guarded VM preparation.
3. Ran container and source gates. Retained the real image-approval refusal and
   resource-window observations instead of substituting unapproved images.
4. Recorded the missing live sizing outcome for the draft; left the worktree for review.

## Live qualification

See the [journey receipt](journey.md). Package and browser journeys, measurements,
a VM minimum and measured headroom remain NOT RUN. There were no screenshot or
service-log artefacts to lose at teardown because no stack was claimed.
