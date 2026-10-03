# P2-5 review and visual fix round

Date: 3 October 2026. Source: the commit containing this receipt, based on
`0925e80972ab1af6fe8da33f561c1932bfbcaede`, branch `work/chat-ui`.
Environment: Linux, Node 22.23.3, Playwright Chromium, clean `npm ci`.
This is local source qualification, not a fresh silo. No shared dev-stack
process or configuration was changed. No push or deployment was performed.

## Blocker tests: red before green

All three cross the browser UI with protocol fixtures at the HTTP/WebSocket boundary.
Tests are in `scripts/check-chat-browser.mjs` and `scripts/check-chat-production.mjs`,
invoked by `apps/web/test/chat-browser.test.ts`.

| Blocker | Observed red | Fix and passing assertion |
| --- | --- | --- |
| Long first message | At 390px, 500 `M` characters produced a 590px header | Explicit `minmax(0,1fr)` main column, flexible ellipsised title and non-shrinking controls. Header, transcript, composer, Send and panel-toggle bounds fit; each column's scroll width is contained |
| New session during history | Draft textarea remained disabled while the old history route was held open | New session resets `loading`; send succeeds before releasing the old response, and that late response cannot replace the new message |
| Production CSP | Enforcing policy reported inline style, inline handler and Zod eval violations | Disable critical CSS inlining; configure Zod jitless before schema imports. Real production output sends a message, applies styles/fonts and records zero CSP violations under `script-src 'self'` and nonce-bearing `style-src` |

Further behavioural checks cover the rail countdown and Retry now, draft recipient
removal/restoration, slug consistency, sanitised failure details, tool and failed-run
Activity entries, transcript jumps, keyboard/focus, Stop/reload, queued retry, wake
state and reduced motion. The existing HTTP integration test first failed for the
missing projected display name, for `done` replacing `stopped`, and for a raw
first-message title instead of the shared slug; all now pass.
The member name is read only after authorisation; no new business-state write exists.

## Visual inspection

[Fix dispositions](visual-fix-list.md) preserve all 42 audit items plus the shared
icon prerequisite. Items 1–30, 32 and 34–42 are addressed within the original scope.
Item 31 explicitly permits documenting connector deferral; its caption and
implementation notes now do so. Low item 33 remains an owner palette decision,
with an interim neutral swatch. Ask cards, groups, projects and agent threads are
excluded. Missing team, provider and upload metadata is not invented.

[Comparison page](comparison/index.html): all original images regenerated at
1280px and 390px, plus empty/loading/unreachable/no-agent rail states and Activity:
**40 built screenshots**, and the refreshed Workspace Live reference.
Manual inspection used every screenshot against its supplied wireframe and the
Workspace Live reference. It checked gutters, header and composer bounds, To-card
placement, menu clearance, title/status alignment, prose spacing, citation size,
file dog-ears/actions, disabled/queued states, failure drawer and both panel tabs.
The no-agent 12b frame is distinct from 12a. The browser additionally checks each
phone frame's 44px controls (including the citation's invisible target), contained
columns and the transcript's position between header and dock.

## Gates

The first full run had a five-second bridge-replay timeout during concurrent
work. Its isolated rerun passed all five tests. The browser run was interrupted
by a workspace reload during the final slug edit; live reload and HMR are now
disabled in the harness. Final full-suite qualification uses two workers,
without increasing any test timeout. That run exposed a separate stale Angular
prebundle: its cached protocol module lacked the new slug export, so the
organisation-integrations page never sent its initial API request. An isolated
run reproduced the timeout. `npm exec -w apps/web -- ng cache clean` removed only
this worktree's cache; the shared stack uses `/home/jente/dev/opencrane-new`.
The isolated integration file then passed all eight tests. The complete suite
was rerun after that cleanup. The final capture also exposed an immediate row-count
assertion racing Angular’s tab render; it now waits for the first Activity row
before counting, and the capture was rerun in isolation.

| Gate | Final result |
| --- | --- |
| `npm ci` | PASS, clean install; no new transitive package versions |
| `NO_COLOR=1 npm run test -w apps/web` | PASS, 6 files / 43 tests |
| `NO_COLOR=1 node scripts/check-chat-browser.mjs --capture` | PASS, browser journeys and all 40 frames at both widths |
| `npm run lint` | PASS, code/dependencies/unused/docs/local links; five existing size warnings |
| `npm run typecheck` | PASS, every workspace |
| `npm run check:events` | PASS, 74 event types agree |
| `PG_TEST_URL=… npm test -- --maxWorkers=2` | PASS, 64 files / 1,024 tests; 2 files and 3 opt-in tests skipped; 464.18s |
| `npm run test:chat:production` | PASS, includes `npm run build -w apps/web` and Chromium under enforcing CSP |

PostgreSQL was the requested disposable test service at `127.0.0.1:55432`.
The final phone Attach fill was checked by the capture and production runs after
the full suite; it changes CSS only. Local safe logs are `/tmp/chat-web-tests.log`,
`/tmp/chat-browser.log`, `/tmp/chat-lint.log`, `/tmp/chat-types.log`,
`/tmp/chat-events.log`, `/tmp/chat-root-tests-clean.log` and
`/tmp/chat-production.log` on the builder host. Screenshots and this receipt are
committed; temporary command logs are not.

## Qualification limits

**NOT RUN:** the three opt-in tests (`lifecycle-k3d`, `bridge-k3d` and the
real model gateway calls), fresh-install/live chat journey, real provider/model calls, real phone
hardware or software keyboard, Firefox/WebKit, upload and connector transport,
file-byte delivery, account settings page, hosted CI, post-fix independent review,
merge and main-branch gates. These fixtures do not qualify those capabilities.
The build still requires the serving layer to inject a fresh Angular style nonce;
the production harness supplies it, but deployment configuration was not changed.
