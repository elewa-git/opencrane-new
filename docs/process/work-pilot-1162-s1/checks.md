# Own checks for pilot VM bootstrap and sizing fixes

Date: 20 November 2026. Branch: `work/pilot-1162-s1`.
Candidate runtime source: `e0c4a9b063f5cfcdd189134eaa145592727110fb`.

## Rebase and test-first fixes

PASS: fetched main at the start and before the source push. It remained
`ed3662d8530338cde94d557713264f1ebf1057ae`, already contained in this branch.
No rebase was needed or left in progress.

The production build exposed the CommonJS noVNC import as an object whose
`default` is the constructor. The old re-export passed the object to `new Rfb`.
A browser debugger captured the constructor TypeError; its caller closed the
WebSocket before a desktop frame. This reproduces without ingress or a computer.
The unchanged viewer passed both widths in a fresh CORE stack, including a turn
while viewing and clearing pixels after a grant was revoked. Both the automatic
CORE run and its explicit repeat passed, and teardown released the slot.

Test-first `de6cc73ef` fails through the production build, Chromium and the real
website WebSocket proxy: Disconnected instead of Viewing. `1bd7ff9d5` corrects
only the fixture's requested pixel format and still fails against the old product
code. The exact red-pixel assertion is unchanged. Fix `dfd8aa424` describes both
import shapes and selects the constructor in the existing viewer module.

CI correctly rejected two unqualified browser `document` references in the new
test driver. `5e21fdc0f` records the existing ESLint command failing for both
`no-undef` errors before fix `e0c4a9b06` uses `globalThis.document`. It also expands
the protocol and cleanup statements. No lint rule or globals exception changed.
The earlier scoped-lint progress statement was premature: that process had not
finished. Only the confirmed final process exit is reported as PASS below.

## Own source gates

All tests, builds, typecheck and lint commands ran under `nice -n 10`. Vitest had
at most two workers; the selected Angular checks also had two build workers.
No full local root suite or fleet batch ran.

| Check | Result | Evidence |
| --- | --- | --- |
| Focused branch tests | PASS | 24/24 twice, no skips |
| Full browser file | PASS | 5/5, including production desktop pixels at both widths |
| Final production viewer repeats | PASS | One selected case twice; four unchanged cases deselected each time |
| Real noVNC and viewer unit checks | PASS | 20/20 in three files, twice |
| Clean install | PASS | npm ci; same installed MIT-licensed ws 8.22.0 now declared for root test tooling |
| Workspace, package and dev-stack typecheck | PASS | Process exited 0 |
| Event catalogue | PASS | 174 event types |
| Knip | PASS | Two existing configuration hints |
| Scoped repository ESLint | PASS | App, test-driver and CI files; process exited 0 |
| Supplementary infrastructure ESLint | PASS | Existing infrastructure scope, recommended JS rules and standard size limits |
| Changelog and Markdown | PASS | No changelog issue; zero Markdown issues |
| README, process and ledger checks | PASS | Own checks |
| Public privacy and secret scans | PASS | Run before each push, including the complete branch range |

The regression requires Viewing and a decoded red pixel in an 800 by 600 canvas
at 1280 and 390 pixels. The fixture now honours the browser's requested pixel
format. The first corrected product attempt reached Viewing but exposed the
fixture's BGR/RGB mistake; that observation and both red runs are retained.
No assertion, access, lease, money, memory or timeout rule was weakened.

## Live collector corrections

The first packaged attempt in this round is FAIL, regardless of its incorrect
journey=0 cleanup field. Its browser outcomes include a failed mobile PDF answer
and an unreliable sign-in timeout after the controlling shell received SIGTERM.
The next private collector uses the existing project.pdf fixture filename, retains
the already signed-in owner when adding members, and completes browser shutdown
before collecting logs and tearing down. An additional result-file check rejects
FAIL/NOT RUN and requires both one-person desktop widths and three held viewers.
No product rule, assertion or service deadline changed.

## Additional routine-sender investigation

FAIL: prior-head CI failed the saved-Denied routine case, returning unknown where
its setup expected sent. That case passed in isolation and in the broader local
run. The broader run was FAIL, 113/114: a different authority-race test timed out
before reaching its intended append. That case then passed in isolation.
The cause remains unproved. No routine product code, test, deadline or assertion
was changed; neither failure is claimed fixed. These extra observations are
separate from the required changed-test gates and latest-head CI result.

## Make it right and host scope

Keep module conversion in one small viewer wrapper and describe the two data
shapes in its shared declaration. Test the production build and the real noVNC
class, and keep the exact pixel assertion. Give protocol messages, canvas steps
and cleanup operations their own names and statements. Add no speculative layer,
new runtime component, event type, connection retry or reconnect loop. Exclude
the test driver from runtime images and keep the strict runtime file allowlist.

PASS: the actual host bootstrap ran only with --dry-run and refused its existing
Docker socket before writes. No host setting or owner stack was changed. Actual
Ubuntu VM bootstrap, reboot and VM storage/runtime qualification remain NOT RUN.
Fresh live results, measured demand and qualification limits belong in the
[journey receipt](journey.md). No independent-review result is claimed.
