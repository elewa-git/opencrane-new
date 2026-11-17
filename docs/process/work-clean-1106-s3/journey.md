# Computer and web session configuration

Journey on a fresh dev stack: PASS

On 16 November 2026, claimed secondary slot 1 ran `infra/dev-stack/up.sh --fresh`
at head `0562532c3714c58f16df64860c4b18f8a7115bfe`. Managed stand-in calls were
enabled. This run replaces the earlier receipt at `5eb6df9e1` because the review
fix changes the browser's default-mode reader. The later cleanup removes an unused
optional response field and its browser branch. The server never sent that field,
so the browser still uses `sessionDefaults` with the same assistant kind. Related
contract wording and the PR's new spec now match.

The unchanged pinned computer image was
`sha256:ca3c13f72783b68a48aaaae7e8c469393dc2618221b6dd8e91e56397365f59e0`,
built from source commit `f32d646294fd60cac5504bdaa2a29fb90169d182`.

Startup, CORE, status and teardown returned 0. Status after teardown says `free`.
[CORE results](core-results.txt) and [stack results](stack-results.txt) retain the
observed outcomes. Private identity and screenshot paths are replaced with
placeholders. Generated journey files outside this receipt were retained privately
and restored; the worktree remains available for review.

The first startup failed before provisioning (FAIL): the runner used a
credential path absent from this worktree. It ran no journey: NOT RUN. Teardown
returned 0 and released the slot. The successful fresh attempt used the existing
shared repository credential by path. No credential value was printed or retained
in this receipt, and no product code, timeout or retry was changed for startup.

## Browser steps and observed results

1. Claimed slot 1 with `infra/dev-stack/claim.sh`, then ran
   `infra/dev-stack/up.sh --id 1 --fresh` under `nice -n 10`. Startup automatically
   ran CORE. Signed in through Zitadel with separate owner and member contexts.
   The installed Playwright runner used 390 px and 1280 px at the slot's origin.
2. Opened a personal chat, sent a message and saw the streamed reply finish.
   Reload kept exactly one reply. Sent another message, pressed Stop and saw the
   partial reply survive reload at both widths.
3. Uploaded a PDF and waited for Ready. The reply used its expected contents.
   Opened PDF, text and image previews. Reload kept one file per upload. EICAR,
   unsupported type and oversized upload refusals passed at both widths.
   Each width recorded one upload retry and zero preview retries in the existing
   runner; neither created a duplicate file.
4. Tried the computer viewer without a grant and saw refusal. Granted access,
   opened the real desktop, then revoked access. Pixels cleared and Stop was
   recorded in 258 ms at 390 px and 309 ms at 1280 px.
5. Used the owner's controls to save paying-group and assistant spending ceilings.
   Over-ceiling calls were refused and remained refused after reload at both
   widths. The journey restored the earlier ceilings.
6. Checked private history, organisation access, expired sessions, logout CSRF,
   sign-out and reauthentication. Observed the expected refusals. Member and tool
   catalogue replay verification also passed.
7. Ran status, retained the captures, then always ran
   `infra/dev-stack/down.sh --id 1`. A final status returned `free`.

Both new chat screenshots were visually checked. The reply, retained partial reply
and composer fit the phone viewport. The desktop view retains its session panel
and navigation. Both spending-refusal captures were also visually checked; each
shows the group monthly limit reached at zero cents.

[1280 px chat](chat-1280.png) · [390 px chat](chat-390.png)

[1280 px spending refusal](spending-refused-1280.png) ·
[390 px spending refusal](spending-refused-390.png)

CORE explicitly skips approval: NOT RUN. Paid-provider, live personal-memory,
routine execution and a separate live shared-child refusal journey were NOT RUN.
This clean-up changes none of their permissions or creator-only ownership rules.

## Own source checks

- PASS: the unchanged exact-response test first failed on the extra
  `sessionConfiguration` field. The test file and its assertion remain unchanged.
  The new browser personal-default test failed before the fix. Test-first commit:
  `f42aa5192`. See the [review fix proofs](review-fixes.md).
- PASS: removed twelve guards individually, observed each named test fail for its
  own reason, then restored it. Computer production code is unchanged in this
  fix round. The tests include positive personal recall and personal Stop controls.
- PASS: all 24 changed computer cases twice, including native launch fixtures
  against the pinned image, in 30.10 and 30.76 seconds. All four browser cases
  twice, in 5.91 and 8.32 seconds; production web build.
- PASS: full workspace and infrastructure typecheck; event catalogue agreement for
  174 types; Knip; changelog; scoped ESLint with zero warnings; Markdown;
  dependency, README and whole-stream-read checks. Knip retains its two existing
  configuration hints. The web build retains existing style-budget, Mermaid and
  CommonJS warnings.
- PASS: CI root shard 1, using `nice -n 10 node scripts/ci/run-tests.mjs 1`: 152
  files and 4,110 tests, zero failures or skips, in 3,229.87 seconds. This includes
  all 50 unchanged chat HTTP cases and the exact-response regression.
- Tests, lint, typecheck and builds ran under `nice -n 10`. Database fixtures used
  the shared disposable PostgreSQL database. The full root suite was NOT RUN.

## Cleanup

Removed the extra server response field. Moved its small default reader into
`libs/protocol`, where the browser can pass the existing assistant kind to the
shared event-library configuration. Existing responses stay identical; personal
and shared assistant defaults remain memory-free and restricted respectively.
Kept every creator-only check and the open ownership question unchanged.

Shipped code and runtime manifests across this slice: 155 added plus 84 deleted
lines, 239 total. Tests, documents and receipts are excluded. New functions fit the
existing size limits. No dependency, permission, event or suppression was added.

## Second cleanup round

Journey rerun: NOT RUN (not needed). This cleanup preserves the behaviour covered
by the fresh CORE run at `0562532c3714c58f16df64860c4b18f8a7115bfe`, recorded
above at 1280 px and 390 px. No new stack was claimed.

PASS: the new rejection test failed because the chat schema accepted the unused
`sessionConfiguration` field; both existing composer-default cases still passed.
Test-first commit: `4ff1f4045`. Removed the schema field and the dead override
branch, retaining `sessionDefaults` as the browser's only default reader. Removed
the two obsolete override cases from this PR's new spec. No assertion from main
was edited. Corrected the events, protocol and web contract wording.

PASS: changed browser spec twice (three cases each, 4.77 and 3.30 seconds), full
Angular web suite (85 files, 1,592 tests, zero failures or skips, 47.64 seconds)
and production web build. The build retains its existing Mermaid, style-budget
and CommonJS warnings. Scoped ESLint has zero warnings. Event catalogue agreement
covers 174 types. Knip passes with its two existing configuration hints. Changelog,
README and Markdown checks pass. Tests, build and lint ran under `nice -n 10`.

PASS: full workspace and infrastructure typecheck under `nice -n 10`.
