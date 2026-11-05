# Personal reply state receipt

5 November 2026. Part of #97. This is the first part of P4-15 PR 3l.
Base: `6031183ebb29f8023edf914adb04913a58088884`, the merged PR 3k (#871).
The clearance schema is the strict, position-free `private_output_cleared` frame.
The [accepted delivery boundary](https://github.com/elewa-git/opencrane-new/pull/863#issuecomment-6638487509)
orders delivery at the final authority position read. This change leaves that boundary alone.

## Scope

Private frames bypass socket history and reach only the current personal session.
A reply stays in page memory, separate from saved rows and catch-up positions.
Exact clearance, access loss and session/connection changes discard it. Ordinary
messages and uploads retain it. A completed turn may retain an already received reply.
The first frame supplies the server-checked thread and input identity; history does not.

PARTIAL: the requested feature is split to keep each change around 600 changed lines.
This first part does not display private text. A later part must add safe Markdown,
cancel pending private Mermaid work, remove rendered images and accessible text,
show unavailable/restriction notices and capture six desktop/phone screenshots through
`visual:p4-15-pr3l`. It must also check starts that arrive while a subscription catches up.
The current state accepts only new starts after the socket reports ready.

## Own checks

The environment is an existing development worktree with installed dependencies,
synthetic browser fixtures and no development stack or model calls.
Failing-test commit: `b59e3127a`. The protocol test failed because a valid private reply
was rejected by the socket union, before the implementation changed. The newer-history regression in `184c59c6a`
also failed before its fix.

Source checked: `22c3d9d30d87d657d837303c42ce11d190d10e5f`. Later receipt edits change no code.

- PASS: `npm ci`; local NATS and link-checker tool links installed.
- PASS: `nice -n 10 npm run typecheck`, `npm run check:events` (158 types),
  and `nice -n 10 npm run build -w apps/web`.
- PASS twice: 61 tests in `private-reply.spec.ts` and `websocket.service.spec.ts`,
  using the Angular test runner with those two `--include` paths under `nice -n 10`.
- PASS: 81 existing workspace tests and 84 existing direct-chat tests.
- PASS: 460 unchanged event security tests and the changed protocol test, through
  `nice -n 10 npx vitest run` with one worker and the supplied `PG_TEST_URL`.
  The protocol test also passed a second time. These tests needed no database.
- PASS: targeted typed lint and web typecheck repeated after the history fix.
- PASS: full lint, including Knip and changelog, with CI's 8 GiB heap setting.
  The earlier lint process was stopped near the default heap limit.

The [browser tests](../../../apps/web/src/app/chat/private-reply.spec.ts) cover
exact clearance, duplicates, unrelated activity, late HTTP reads, stopped/completed
turns, socket replacement, direct/shared exclusion and upload retention.

NOT RUN: private reply rendering, diagrams, screenshots and fresh-install live qualification.
Native admission remains disabled. No authority or security test was edited.
