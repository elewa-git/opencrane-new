# Own checks for pilot VM bootstrap and sizing fixes

Date: 20 November 2026. Branch: `work/pilot-1162-s1`.
Runtime exercised in the PARTIAL journey: `9ff04e9da075f687472a6754359fb19ace7b9a41`.

## Rebase and failing tests

Fetched `origin/main` and finished a clean rebase onto
`ed3662d8530338cde94d557713264f1ebf1057ae`. Fetched again before the final
qualification; main had not moved. The original bootstrap test-first history is
retained as `e0d6dcfdd` and `a2617292c`, followed by implementation `5cc6a276b`.
The original [missing-script](logs/red.log) and
[managed-kubelet rerun](logs/idempotent-red.log) failures remain available.

The second fresh packaged attempt exposed an unhandled viewer `write EPIPE`
that stopped the website. Test commit `5c332d5d7` exercises the actual packaged
entrypoint, injects that error at its real client socket and fails when the
process exits. The [failure](logs/fix-1/web-proxy-red.log) precedes the fix.
The regression requires both peers to close, the process to survive and a
subsequent HTTP request to succeed. Error/close handlers now attach before writes;
package and development servers share the implementation in `web.mjs`.
The original error is retained through the structured logger.

The first image build correctly rejected an extra helper outside its strict
runtime file allowlist. Commit `f44f132c1` retains the
[existing check's failure](logs/fix-1/runtime-files-red.log). Commit `8e1e76a38`
removes that file and exports the shared function from the approved entrypoint.
The runtime allowlist and assertion are unchanged.

CI then reported four native image fixture deadlines. All 19 affected native
configuration/supervisor tests passed locally with two workers. Test commit
`ddf74b5e5` [fails for the missing worker bound](logs/fix-1/ci-workers-red.log).
Commit `828b9c865` applies two workers to image fixtures, matching the existing
ordinary-shard budget; browser fixtures retain one worker. The image CI job on
`9ff04e9da` passed 59 tests, with one existing opt-in test skipped, in 115.71 seconds.
No deadline, assertion, access check, money check or memory limit changed.

The final fixture cleanup names HTTP request and control-message values and
splits chained calls. Both focused repeats still pass 24/24, and supplementary
lint passes. This changes neither runtime code nor journey assertions or deadlines.

## Safe bootstrap scope

PASS: the host dry run refused its existing Docker socket before writes.
[Host refusal](logs/fix-1/rebased-host-dry-run.log).
The [complete dry run](logs/fix-1/container-dry-run.log) uses an unprivileged,
network-isolated container with a synthetic Ubuntu distribution record.
The 11 bootstrap tests include ShellCheck, existing-runtime refusals, identical
configuration on rerun and replacement-binary refusal. Their system operations
are stubs. No fixture starts another Kubernetes or container daemon.

No swap, sysctl, iptables, bridge, route, Docker-daemon or host-package setting
was changed. The first real Ubuntu VM bootstrap and reboot remain NOT RUN.

## Gate results

All tests, builds, lint and typecheck commands ran under `nice -n 10`.
No full local root test suite or fleet batch ran.

| Check | Result | Evidence |
| --- | --- | --- |
| Changed focused tests, first run | PASS | [24/24, no skips](logs/fix-1/clarified-tests-1.log) |
| Changed focused tests, repeat | PASS | [24/24, no skips](logs/fix-1/clarified-tests-2.log) |
| Development static server | PASS | [3/3, including browser/build checks](logs/fix-1/final-dev-web-tests.log) |
| Native configuration/supervisor reproduction | PASS | [19/19 with two workers](logs/fix-1/native-fixtures-reproduction.log) |
| Workspace, package and dev-stack typecheck | PASS | [Output](logs/fix-1/worker-typecheck.log) |
| Event catalogue | PASS | [174 event types](logs/fix-1/worker-events.log) |
| Knip | PASS | [Two existing configuration hints](logs/fix-1/worker-knip.log) |
| Changelog lint | PASS | [Output](logs/fix-1/worker-changelog.log) |
| Markdown lint | PASS | [Output](logs/fix-1/worker-markdown.log) |
| Scoped repository ESLint | PARTIAL | [CI scripts checked; infrastructure excluded by repository rules](logs/fix-1/qualified-eslint.log) |
| Supplementary infrastructure ESLint | PASS | [Recommended JS rules and repository complexity/size limits](logs/fix-1/qualified-eslint-extra.log) |
| README, process privacy and ledger checks | PASS | Run after the final receipt update |

## Make it right

Reuse the verified runtime setup in `infra/devbox/runtime.sh` and remove the old
copies. Keep host validation, protection, installation and command output in named
functions. Share WebSocket connection handling between both website entrypoints.
Name request options and logging fields; expand connection cleanup steps. Keep
one worker-budget decision in the CI launcher. Add no dependency, event type,
business rule, runtime retry or readiness extension. Raise no lint limit or baseline.

Production changes total 464 added/deleted lines, including two workflow lines.
Tests, documents, release notes and receipts are excluded. Public privacy and
staged/full-range secret scans run before each push. Full CI and exact-source
image results are recorded in the [journey receipt](journey.md).
Receipt copies replace private paths and normalise line endings without changing
the observations. No independent-review result is claimed.

## Short work log

1. Rebased, ran source gates and obtained exact-source CI/image approvals.
2. Claimed and tore down two fresh packaged attempts, retaining their failed
   conditions, startup logs, service logs and measurements before teardown.
3. Committed the viewer-crash and missing-worker-bound failures before fixes;
   retained the strict runtime-image rejection and removed the extra helper.
4. Repeated source gates, waited for approved source and the exclusive resource
   window, then recorded the fresh qualification outcome and released its slot.
