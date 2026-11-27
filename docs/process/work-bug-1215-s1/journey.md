# First send in a new assistant session

**PASS** for the requested fresh packaged checks on 27 November 2026.
The application and scanner approvals were available for product commit
[`267a650b3`](https://github.com/elewa-git/opencrane-new/commit/267a650b368e41764854819cfa20c11d055b55b7).

## Environment

- Fresh packaged install in secondary slot 1, using the stand-in model.
- The configured test member was invited and joined the workspace.
- Chromium ran at 1280 × 900 and 390 × 844 pixels.
- `DEV_STACK_ID=1` was set for each stack and browser command.
- `OPENCRANE_ACCEPT_DEV_HOST_RISK=accepted-dev-box-366` was set for `package-up`.

## Journey

At both widths, the member opened a new session. The page did not show the
uncertain-send warning. The browser then failed the real conversation-create
request at the transport boundary. The typed draft stayed in the composer, and
the page showed “Your draft is still on this page. Retry to send it.” with Retry
available.

| Check | 1280 px | 390 px | Evidence |
| --- | --- | --- | --- |
| New session opens without the uncertain-send warning | PASS | PASS | [1280](new-session-1280.png) · [390](new-session-390.png) |
| Network failure keeps the draft and shows a clear message with Retry | PASS | PASS | [1280](network-failure-1280.png) · [390](network-failure-390.png) |
| Fresh packaged install and cleanup | PASS | PASS | `package-up` completed; `package-down` and `down.sh --id 1` completed |

The browser failure check covered a failure before conversation creation. A
successful first message surviving reload and a retry after the connection
returns were **NOT RUN** in this continuation.

## Existing checks for the approved product commit

The existing product run recorded PASS for the server regression, all 119
workspace tests, Chromium fixtures at both widths, typecheck, event catalogue,
Knip, changed-code ESLint, Markdown, README, changelog and whole-stream reads.
The hosted product CI run also passed:
[CI run](https://github.com/elewa-git/opencrane-new/actions/runs/46046823012).

## Work log

Installed the approved application and scanner images on a fresh slot-1 package,
ran the requested member journey at both widths, saved four screenshots, and
removed the package and slot. No product source changed in this continuation.
