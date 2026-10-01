# Working rules for OpenCrane 2

Distilled from [plan.md](plan.md). If this file and plan.md disagree, plan.md wins; fix this file.

## Licences

Only OSI-approved open-source components run inside a customer silo
(Apache-2.0, MIT, BSD, MPL, ISC, and similar). Check a new dependency's
licence before adding it. KurrentDB (KLv1), SurrealDB and Redpanda (BSL),
EventSourcingDB (closed source) and Axon Server (commercial) are ruled out
on this basis; do not reintroduce them. Build-time data packages pulled in by
dev tooling (caniuse-lite, spdx data, mdn-data: CC-BY or CC0) are accepted,
but never in a silo's runtime images.

Money is always an integer number of euro cents (`…Cents`), never a float.

## The event store is the only source of truth

Every state change is an event. PostgreSQL holds content (who owns what,
conversations, budgets), not truth: every table is a projection that can be
dropped and rebuilt by replay. Never write business state anywhere except
through an event. Commands do one conditional append to one stream and
nothing else.

**No business rules in SQL.** Business logic lives in typed TypeScript
(projections and reactions), never in database triggers, views or stored
procedures.

## The event catalogue is the contract

[docs/architecture/events.md](docs/architecture/events.md) states exactly
which event triggers which logic. `libs/events` is that catalogue in code:
its registry must name the same event types as the catalogue's tables, in
both directions. `npm run check:events` enforces this; never add an event
type to one without the other.

## Size and process

Follow the [engineering standard](docs/process/standards.md).

- Build each whole feature on a development branch with a well-described PR:
  Why / Functional outcome / Architecture / Evidence / Not in this PR. The
  orchestrator merges after gates, independent review and green CI. Small fixes
  belong inside their feature PR.
- Aim for at most about 1,500 non-generated added/deleted lines per change.
  One PR per whole feature, stacks at most two, no consolidation PRs.
- At most two independent review passes: a different model reviews the diff,
  then verifies fixes and batched disputed findings. Remaining blockers go
  to the owner; the pass limit never turns failure into success.
- Required checks (`lint`, `typecheck`, `test`, `check:events`) must pass
  before landing and on `main`; repair or revert failures before landing more.
- Source ready means green checks with remaining live qualification explicit.
  A capability is done only after its journey passes live on a fresh install.
  Report PASS/FAIL/PARTIAL/NOT RUN honestly; untested conditions never pass.

## Style

- Plain-English comments: say what the code does simply, not with heavy
  vocabulary. Avoid words like "canonicalise" or "provenance" when
  "standardise" or "source" will do.
- UK English throughout docs and comments.
- TypeScript strict, ESM, Node 22. NodeNext module resolution.

## Secrets

Never commit secrets, real API keys or credentials. A computer or service
holds only short-lived tokens; secrets live in the secret store, referenced
by id, never by value, in events or in code.

## Where to look

- [README.md](README.md) — the vision, architecture and component list.
- [plan.md](plan.md) — phases, spikes, decisions and the current plan.
- [docs/architecture/events.md](docs/architecture/events.md) — the event
  catalogue.
- [docs/adr/](docs/adr/) — architecture decision records from the spikes.

## Commits

Commit messages are one emoji and a plain sentence, with an optional short
body. Never add a co-author line or any AI attribution (no
"Co-Authored-By", no "Generated with ...") to commits or PR descriptions.
