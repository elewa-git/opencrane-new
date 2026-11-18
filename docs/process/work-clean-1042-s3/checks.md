# Fixture migration checks

The change shares server fixture appends and session cookies through public
`@opencrane/*/testing` imports. Product source and runtime dependencies are unchanged.

Seven local append helpers are replaced: budget choices, chat-read regressions,
current effects, model access, realtime, spending effects and spending. Four are
replaced by direct builder calls. Three remain as named wrappers that also apply
authorisation or projections. Twenty-five cookie constructions share the session
builder across twelve files.

The migration stops before the audit and memory helper groups. The current source
change is about 1,200 added plus deleted lines before documentation and receipts;
starting either group would cross the requested boundary.

## Preserved behaviour

A parsed comparison retains all 1,147 assertions outside replaced append helpers.
Identifiers, roles, silos, principals, timestamps and command identifiers stay the
same. The event builder also accepts a named source; correlation remains unsupported.

The first caller migration failed with an undefined builder before its public import
and replacement wrappers were wired. A separate real NATS persistence test failed
because the source was saved as `test` instead of the supplied service name. Adding
the named source option fixes that cause without changing the production append path.

Three unrelated-chat probes retain direct seeding of their original synthetic records.
The ordinary append path rejects those fixtures; replacing seeding caused the three
existing chat-activity assertions to fail. Restoring only those seed calls fixed the
cause. No assertion or production validation changed.

## Deferred files

Seven helpers remain to avoid files still changed by open PR #1122. Of these,
`integrations.test.ts` is also changed by #1149. PR #1144 currently changes no tests. The newer #1153 adds a separate export
at the end of the shared event test helper; it does not change the builder. Its
other overlapping test files keep their existing assertions in this slice.

- `bridge-approvals.test.ts`
- `integration-changes.test.ts`
- `integration-facts.test.ts`
- `integrations.test.ts`
- `member-inventory.test.ts`
- `memory-maintenance-preparation.test.ts`
- `memory.test.ts`

The next file groups remain beyond this slice:

- `audit-child-publication.test.ts`
- `audit-dispatch.test.ts`
- `audit-membership.test.ts`
- `audit-resolution.test.ts`

Audit fixtures retain specialised event sources and, where used, correlation canaries.
The other deferred helpers are:

- `child-first-input.test.ts`, which deliberately changes envelope fields including
  correlation to check refusals.
- `memory-delivery.test.ts` and `memory-stop.test.ts`, which validate specialised
  computer fixture events before saving them.
- `shared-assistant.test.ts`, which seeds legacy participant history that current
  commands refuse.

Session cookie setup in twelve non-conflicting files uses the shared helper. The
remaining cookie files, permission stores and member setup are outside this slice.

## Source evidence

- Baseline: PASS, 362 tests in twelve unchanged server files, 325.42 seconds.
  The builder already had five cases, giving 367 existing cases in the comparable
  selection. The new persistence case brings the selection to 368.
- First final run: PASS, 368 tests in thirteen files, 352.56 seconds.
- Second final run: PASS, 368 tests in thirteen files, 317.29 seconds.
- PASS: typecheck, check:events (174 event types), Knip, lint:changelog,
  changed-file ESLint and Markdown lint. Knip reports two existing configuration hints.
- PASS: public privacy check and secret scan before the source commit.
- Full root suite and full-root ESLint: NOT RUN, as instructed.
- Web tests and separate web build: NOT RUN; no web files changed.

## Cleanup

Delete seven local append helpers. Reuse the event builder for saving and the
session builder for signing cookies. Keep three named wrappers for authorisation
or projections. Split model-access setup into member, team, member-state, grant
and foreign-resource steps. Move socket turn reporting into a small named helper.
Changed functions stay within 80 counted lines and five parameters. No size limit,
assertion, production append validation or error handling is relaxed.

Shipped-code changes: zero lines. No runtime dependency or licence changes.
Independent review is left to the orchestrator.
