# Private memory collector: own source checks

Date: 29 October 2026. Part of #97, P4-15 PR 5c, first part.
Base source: `2ec78b82c2998d246f1d02b67b4361183b8bf4ba`.
Tested implementation: `547f0d2f71c39a5ef2828435723b56e97180bc56`.
Branch: `work/p4-15-pr5c`. Environment: local worktree, synthetic temporary files.
Image: NOT RUN. Fresh install: NOT RUN. Spend: 0 euro cents.

PASS: test-first commit `e274c19c7` preceded implementation. The initial run failed
because the collector was absent. A temporary no-op then produced 32 failing tests
and one passing test; refusal behaviour was missing as expected. The no-op was removed.

PASS: 34 collector tests twice (1.85s and 1.59s), and unchanged event-security
rules once (460 tests). PASS: local collector typecheck, focused ESLint, Knip,
event catalogue (157 types), README Markdown/links and the field-name check.
PASS: workspace typecheck, full lint (all stages), and changelog.

Commands: `npx vitest run --config scripts/private-memory-qualification/vitest.config.mjs`,
`npx vitest run libs/events/test/security-rules.test.ts --maxWorkers=1`,
`npx tsc -p scripts/private-memory-qualification/tsconfig.json`, `npx knip`,
`npm run check:events`, `npm run typecheck`, `npm run lint`, `npm run lint:changelog`.
All ran under `nice -n 10`. Vitest used one worker and the supplied `PG_TEST_URL`
on port 55432. Neither suite uses PostgreSQL. No projection tests ran.
PASS: `npm ci` and requested tool symlinks. Package files are unchanged.
The [tests](../../../scripts/private-memory-qualification/memory-qualification-evidence.test.ts)
record the expected refusals. Local diagnostics use `/tmp/p4-15-pr5c-*.log`.

## Remaining live work

NOT RUN: deployment-owned launch, both complete P4-14/P4-15 qualifications,
simultaneous A/B canaries, same-requester sessions, later requester, real native
recall and loaded-reference accounting, revoke/Correct/Forget, unrelated activity,
Stop/reconnect, replacement/reload, and live/fault persistence scans. The
[collector contract](../../../scripts/private-memory-qualification/README.robot.md)
describes the invocation and exact receipt format. No `private-memory.json` is
committed; no synthetic evidence can become a production receipt.

No stack, model call or full root suite ran. Admission, launch, credentials,
CI fixture lists and the protected server/computer and authority files are unchanged.
No event or public API field was added; internal JSON field names were checked
against the unchanged `RISKY_FIELD_NAME` expression. No dependency was added.
