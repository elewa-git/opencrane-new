# Shared test builders: source checks

Date: 17 November 2026. Base: `a1ed9b7885a0be82e4a7f9e646955e4660affa72`.

## Scope

Add the four testing builders. Migrate the two ops test files. Keep product source
unchanged. All 34 server helpers remain for slice 2: their 863 call sites alone
need more than 1,500 added-plus-deleted lines when converted to named fields.
The folder boundary is `apps/ops/test`; no server test or approval fixture changed.

## Test-first evidence

- `b1e08a3e0`: append test fails because `appendEvent` is missing; passes after
  implementation commit `efcb2ce79`.
- `fc6bbe623`: signed-in headers test fails because
  `sessionCookie` is missing.
- `5275fa585`: permission test fails because `permissionStore` is missing.
- `a38bd10d3`: member test fails because the testing export is missing.

Each builder then passed its own test. NATS and OpenFGA are real disposable
services. Permission/member tests also use disposable PostgreSQL databases.

Before migration: PASS, two files / 41 tests, 74.40 seconds.
The original test cases remain: 24 departure cases and 17 nightly-memory cases.
The four builder cases add four tests. No full root suite was run, as instructed.
All 82 departure assertion lines and 50 nightly-memory assertion lines are
unchanged. The two removed helper assertions now live in `appendEvent`.

The first combined run caught a return-shape error in the migrated
`computerEvent`: five departure cases failed on an invalid subject. Return the
saved event rather than its row. Preserve all assertions and rerun both files.

## Final source checks

- PASS: six changed test files / 45 tests twice, 84.31 and 80.21 seconds.
  Run under `nice -n 10`, at most two workers, with the supplied shared
  PostgreSQL control database. The 41 original cases pass in both runs.
- PASS: full workspace, packaging and dev-stack typecheck.
- PASS: scoped ESLint, zero warnings; dependency checks; package README checks;
  `check:events` (174 types); Knip (two existing configuration hints);
  `lint:changelog`; Markdown lint; whitespace.
- PASS: product-source diff is empty. Shipped-code changes: zero lines.
  The only package/configuration changes expose and allow the member testing entry point.
- NOT RUN: full root suite, full root lint and independent review, as instructed.
  Web tests/build do not apply: no web files changed.
- Whole-file local `append` declarations: 36 before, 34 after, all remaining
  in the server folder. No ops test retains a local `append` declaration.
- Duplication score: NOT RUN; the optional tool was not installed for this slice.

Made right: share the append decision once; reuse the event envelope factory,
existing session codec, OpenFGA store creation and member authorisation. Derive
member fields from the shared schema. Keep nightly event construction local to
preserve its identifiers and timestamps, with all saves through `appendEvent`.
Delete both ops append helpers. Keep existing projection and permission delivery
steps in their tests. Add no dependency, raised limit or product rule.

Fresh CORE: PASS at `0e762c212d088fbdcd11796fdb6e6f1e3373052b`.
See the [journey receipt and screenshots](journey.md). Slot 1 is released.

## Remaining server helpers

- `apps/server/test/audit-child-publication.test.ts`
- `apps/server/test/audit-dispatch.test.ts`
- `apps/server/test/audit-membership.test.ts`
- `apps/server/test/audit-resolution.test.ts`
- `apps/server/test/bridge-approvals.test.ts`
- `apps/server/test/budget-choices.test.ts`
- `apps/server/test/chat-read-regressions.test.ts`
- `apps/server/test/child-first-input.test.ts`
- `apps/server/test/current-effects.test.ts`
- `apps/server/test/group-ownership-reads.test.ts`
- `apps/server/test/groups.test.ts`
- `apps/server/test/integration-access-reads.test.ts`
- `apps/server/test/integration-access.test.ts`
- `apps/server/test/integration-changes.test.ts`
- `apps/server/test/integration-facts.test.ts`
- `apps/server/test/integrations.test.ts`
- `apps/server/test/invitations.test.ts`
- `apps/server/test/member-inventory-volume.test.ts`
- `apps/server/test/member-inventory.test.ts`
- `apps/server/test/member-removal.test.ts`
- `apps/server/test/member-roles.test.ts`
- `apps/server/test/memory-delivery.test.ts`
- `apps/server/test/memory-maintenance-preparation.test.ts`
- `apps/server/test/memory-stop.test.ts`
- `apps/server/test/memory.test.ts`
- `apps/server/test/model-access.test.ts`
- `apps/server/test/ownership.test.ts`
- `apps/server/test/provider-binding-guards.test.ts`
- `apps/server/test/provider-bindings.test.ts`
- `apps/server/test/provider-drain.test.ts`
- `apps/server/test/realtime.test.ts`
- `apps/server/test/shared-assistant.test.ts`
- `apps/server/test/spending-effects.test.ts`
- `apps/server/test/spending.test.ts`
