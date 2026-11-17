# Slice scope and source checks

Twelve server test files use `appendEvent` through the public testing entry point.
Nine local wrappers also apply authorisation or projections. The other three local
helpers are deleted. No product source, dependencies, existing assertions or test cases change.
The helper adds three persistence cases for named principal, time and commandId options.
Unsupported correlation remains covered by the negative type test.

The initial baseline passed 498 tests across 17 server files. The migration stops
at the membership, group, provider and integration-access file group to keep the
slice below about 1,500 changed lines. Full root tests were not run, as instructed.
A comparison of parsed assertions found all 929 assertions outside deleted append
helpers unchanged. Existing test declarations are retained.
The comparable selection keeps 325 existing cases and adds three builder cases:
328 passed. Every changed test file passed twice; the corrected invitation file
also passed its own repeat of 111 cases. One initial migration probe failed that
lost-reply test before its local store spy call was restored.

Source gates: PASS for typecheck, check:events, knip, lint:changelog, changed-file
ESLint and markdownlint. Web tests and build: NOT RUN; no web files changed.

## Deferred helpers

Seven files are deferred to avoid open PRs #1149, #1122 and #1144:

- `bridge-approvals.test.ts`
- `integration-changes.test.ts`
- `integration-facts.test.ts`
- `integrations.test.ts`
- `member-inventory.test.ts`
- `memory-maintenance-preparation.test.ts`
- `memory.test.ts`

Fifteen further files are deferred at the size boundary:

- `audit-child-publication.test.ts`
- `audit-dispatch.test.ts`
- `audit-membership.test.ts`
- `audit-resolution.test.ts`
- `budget-choices.test.ts`
- `chat-read-regressions.test.ts`
- `child-first-input.test.ts`
- `current-effects.test.ts`
- `memory-delivery.test.ts`
- `memory-stop.test.ts`
- `model-access.test.ts`
- `realtime.test.ts`
- `shared-assistant.test.ts`
- `spending-effects.test.ts`
- `spending.test.ts`

Session cookies, permission stores and member setup remain for slice 3.
