# Workspace sign-out and Settings journey

Journey on a fresh dev stack: FAIL — 13 November 2026, head
`51f68936de603b10ff1ab9f8f3f5a8720da245c6`. Fresh secondary stack 2.
See [member workspace at 1280 px](screenshots/member-workspace-1280.png) and
[visible refusal at 1280 px](screenshots/member-refusal-1280.png).

Date: 13 November 2026. Product source: `51f68936de603b10ff1ab9f8f3f5a8720da245c6`,
rebased on `cb369e593` (#1119). Environment: Linux, Node 22.23.3, Playwright Chromium,
fresh secondary stack 2. The feature is enabled by the changed workspace code without
a feature flag.

## Fresh startup: PASS

Claimed stack 2 with `infra/dev-stack/claim.sh`, exported `DEV_STACK_ID=2` and the
configured Zitadel key-file path, then ran `infra/dev-stack/up.sh --fresh`. The
inherited `OPENCRANE_FLEET_TASK` marker stayed set. The built-in core journey passed: real owner and member sign-in, refusals, uploads,
chat and sign-out at 390 px and 1280 px, replay checks and the remaining core checks.
Its approval subjourney was skipped because it waits for #45 rows 4, 5 and 14.
`infra/dev-stack/down.sh` ran at the end and `infra/dev-stack/status.sh --id 2`
reported `free`.

## Slice steps: FAIL

The member journey at 1280 px passed: Settings was absent, and typing
`/org/integrations` displayed the visible refusal. The runner saved both screenshots
linked above.

The runner stopped while preparing the 390 px member view, before it checked Settings
or opened `/org/integrations`. It timed out after 30 seconds waiting for
`getByRole('link', { name: 'Sign out', exact: true })` in `openPhoneNavigation()`.
The Sign out control is a submit button inside a form, so the likely cause is an
incorrect selector in the temporary journey runner. This result does not qualify the
390 px steps. Following the instruction to stop after a failure, no further slice steps
or attempts were run. No product code changed.

| Person and width | Expected result | Result |
| --- | --- | --- |
| Seeded member, 1280 px | No Settings link; typed `/org/integrations` visibly refused | PASS |
| Seeded member, 1280 px | Rail Sign out posts natively and reaches sign-in | NOT RUN |
| Seeded member, 390 px | No Settings link; typed `/org/integrations` visibly refused | NOT RUN; runner stopped before assertion |
| Seeded member, 390 px | Phone-menu Sign out reaches sign-in | NOT RUN |
| Admin and Owner test account, both widths | Settings is visible and opens | NOT RUN |
| Separate owner browser | Remains signed in after the member signs out | NOT RUN |

## Builder checks: PASS

All tests, lint, typecheck and builds ran under `nice -n 10`. No full root test suite
was run. Database tests used the shared disposable test database.

| Check | Evidence |
| --- | --- |
| Test-first failure | `b472e402b`: seven web failures and the missing server role assertion failed for the expected reasons |
| Changed tests twice | Focused web runs: 22 and 166 passed; the changed server test passed in two runs |
| Full web tests | 81 files, 1,561 tests passed with two workers |
| Server chat and read tests | Six tests passed; the isolated access suite passed all 69 tests |
| Integration tests | 96 tests passed in the initial run; the remaining browser test passed alone; its focused run skipped the other 96 |
| Event security rules | 482 tests passed alongside the changed server test |
| Typecheck | All workspaces, package code and dev-stack code passed |
| Event catalogue | 174 event types agree |
| Knip | Passed |
| Changed-file ESLint | No errors or warnings in changed functions; existing untouched `registerChatRoutes` has a 101-line warning |
| Changelog lint | Passed |
| Markdownlint | Passed after adding this receipt |
| Web production build | Passed; existing style-budget and dependency warnings remain |
| `npm run visual:chat` | Passed Chromium checks and captures at 1280 and 390 px |
| Acceptance source checks | One logout source; none in the sign-in template; no pod wording or empty Projects block in the workspace template |

The first full web run exposed an upload test that selected the first submit button.
It now selects the composer submit button. A scroll timeout and six access-suite
service/timing failures occurred during concurrent checks. The affected web suites
and isolated access suite then passed with their original limits. The integration
browser test first missed its Angular startup deadline and passed in isolation.
These source-check results do not qualify the live slice.

The visual captures use intercepted protocol fixtures:
[desktop](../../design/chat/comparison/workspace-live-1280.jpg) and
[phone](../../design/chat/comparison/workspace-live-390.jpg).
They are not fresh-stack screenshots.

## Make it right

Shared one Sign out component, one owner-or-admin function, and the existing role
schema through the shared `ChatContext` type. Moved tool extraction and computer
status updates into their existing modules. Removed the old sign-in form and
handler, its obsolete form style, and the empty Projects block. No size limit was
raised and no dependency or error handler was added.

Shipped-code diff: 143 added plus deleted lines, excluding tests and documents.
The worktree is retained for review. All claimed secondary stacks were torn down.
