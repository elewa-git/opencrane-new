# Assistant Markdown checks

Date: 30 October 2026. Renderer source: `b7af9e606`.
The branch was fetched and rebased onto `origin/main` at `ec60f1bcba`.
The rebase finished; that main commit is an ancestor of this branch.

Each behaviour fix has a failing test committed before its implementation:

| Behaviour | Failing test commit | Observed before the fix |
| --- | --- | --- |
| Interactive reply badge | `e0df36892` | FAIL: the badge was missing |
| Bold across a line break | `8793d4123` | FAIL: no bold element appeared |
| Indented closing code markers | `b4adecdcb` | FAIL: one code block became two |
| Copy feedback during later text updates | `51af8096a` | FAIL: Copied disappeared |

PASS: all 12 Markdown component tests passed after these fixes.
The code-marker tests cover four spaces and tabs remaining code, exact copying,
and valid closing markers with zero to three leading spaces.
The copy-feedback test uses two identical blocks to check that the message stays
on the copied block. Changing that block's code removes the old feedback.

FAIL: the first combined run passed 91 of 92 tests. The existing workspace
check for downloading your own upload exceeded its 5-second limit while other
checks ran. Its assertions and time limit are unchanged. The two repeat runs
use one worker with this task's lint process paused and the other checks finished.

These checks use Node 22, Angular component fixtures and Chromium.
All lint, typecheck, build and test commands run under `nice -n 10`.
Component runs set `PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres`
and limit CPU affinity to one processor for the repeat runs. They do not use PostgreSQL.
Lint uses `NODE_OPTIONS=--max-old-space-size=8192`, as CI does.

| Check | Expected result | Observed result |
| --- | --- | --- |
| Changed component suites, twice | Markdown and workspace checks pass on both repeat runs | PASS: 92 tests on each run |
| Chat browser script, once | Existing keyboard, layout, streaming and badge checks pass | PASS |
| Additional parser checks | Unsafe URLs stay text; nested markers and deep indentation stay bounded | PASS |
| Event catalogue | Registry and catalogue agree | PASS: 157 event types |
| Knip | No unused files, exports or dependencies | PASS |
| Changelog lint | The release fragment passes | PASS |
| Production web build | Angular templates compile | PASS |
| Markdown browser captures | Both widths fit; text stays safe; copy feedback survives another update | PASS |
| Repository lint | Every lint stage passes | PASS: all stages; 0 errors and 34 code warnings |
| Typecheck | Every workspace compiles | PASS |
| Root test suite | Outside this fix's requested checks | NOT RUN |
| Fresh-install journey | Real assistant replies render after sign-in | NOT RUN |

The browser examples intercept API requests and live connections. All reply text
is invented. Clipboard success and refusal are simulated. These checks do not
use a development stack or qualify a fresh install. The chat browser script
starts its own Angular fixture server.

Additional parser checks rejected nine unsafe URL variants, including mixed-case
JavaScript, data, VBScript, protocol-relative, encoded, file and HTTP destinations.
They also checked that mismatched or shorter markers remain code, and that
50 KB of leading spaces remains paragraph text without recursion or truncation.

The updated captures were inspected for layout and private information:

| State | 1280 px | 390 px |
| --- | --- | --- |
| Reply | [Desktop](reply-1280.png) | [Phone](reply-390.png) |
| Copied | [Desktop](copied-1280.png) | [Phone](copied-390.png) |
| Copy refused | [Desktop](copy-refused-1280.png) | [Phone](copy-refused-390.png) |
| Badge, multiline bold, indented code and streaming copy feedback | [Desktop](regressions-1280.png) | [Phone](regressions-390.png) |

`npm run visual:chat-markdown` rebuilds and captures all eight examples.
The changed suites run with `npm run test -w apps/web -- --watch=false
--include=src/app/chat/assistant-markdown.spec.ts --include=src/app/chat/workspace.spec.ts`.
Run the broader browser check with `nice -n 10 node scripts/check-chat-browser.mjs`.
Mermaid diagrams remain code. The remaining live check is an assistant reply
journey on a fresh install.
