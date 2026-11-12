# Workspace sign-out and Settings journey

Journey on a fresh dev stack: NOT RUN

Date: 12 November 2026. Product source:
`5b423fc5335f17d8dd1dbdfb509dd46dde3a37c1`, based on
`90a99afa75e508f32c505d82a4beacc45e236dfd`.
Environment: Linux, Node 22.23.3, Playwright Chromium, fresh secondary dev stacks.
The feature is enabled by the changed workspace code without a feature flag.

## Fresh startup: FAIL

Claimed secondary stacks through `infra/dev-stack/claim.sh`, then ran
`infra/dev-stack/up.sh --fresh`. Each attempt ran `infra/dev-stack/down.sh`
through an exit trap.

1. Secondary 2 reached website readiness. The inherited fleet marker refused the
   runner's automated journey. Teardown released the claim.
2. Started secondary 1 fresh with that marker unset for the explicitly requested
   journey. Startup stopped after website readiness, before the slice script.
   Teardown removed its private diagnostic before it could be retained.
3. Ran one final fresh attempt on secondary 1 with sanitised diagnostic capture
   before teardown. The built-in browser upload check timed out after 130 seconds
   waiting for `.upload-status` to show Ready or Upload unavailable. The runner
   stopped before returning from startup. Teardown released the claim.

The retained [sanitised diagnostic](startup-diagnostic.txt) names the timeout.
The failing helper is `uploaded()` in
[browser-upload.ts](../../../infra/dev-stack/browser-upload.ts).
It uses named Attach and Upload controls. Its failure has not been established
as a consequence of the new sign-out forms. No upload code, retry count or timeout
was changed. No further fresh attempt was made.

## Slice steps: NOT RUN

The slice-specific Playwright script was scheduled after successful fresh startup
and `infra/dev-stack/status.sh`. Startup never reached that point. No live slice
screenshots were captured. These conditions remain unqualified:

| Person and width | Expected result | Result |
| --- | --- | --- |
| Seeded member, 1280 px | No Settings link; typed `/org/integrations` visibly refused | NOT RUN |
| Seeded member, 1280 px | Rail Sign out posts natively and reaches sign-in | NOT RUN |
| Seeded member, 390 px | No Settings link; typed `/org/integrations` visibly refused | NOT RUN |
| Seeded member, 390 px | Phone-menu Sign out reaches sign-in | NOT RUN |
| Admin and Owner test account, both widths | Settings is visible and opens | NOT RUN |
| Separate owner browser | Remains signed in after the member signs out | NOT RUN |

The planned account preparation reused the documented seeded member and the existing
ownership fixture to check the test Owner account as both Admin and Owner.
The upload startup blocker must be resolved or qualified before this slice can merge.

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
