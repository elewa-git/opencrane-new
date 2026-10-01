# Proposed OpenCrane 2 standards

Proposal, 1 October 2026. These checks and prompts are not installed by this document. The [review](standards-review.md) records the evidence behind the choices.

Keep the four required checks, one independent adversarial review and fresh-install evidence. Put repeatable rules in tools. Keep instructions about judgement short, and give each rule one home.

## Work and review

Until the Phase 2 prototype is testable, land coherent, squashed changes directly on `main`, after checks and adversarial review. Codex agents build; a different model reviews; the owner reviews the result each morning. This follows the owner's 1 October instruction, superseding the PR wording currently in `plan.md:13–14`. Correct that wording in the implementation task below.

- Take ready issues with an outcome, acceptance criteria and decisions already made. Read the relevant plan section, not the whole historical record.
- Parallel builders have separate worktrees, installed dependencies and assigned files. One integrator lands their changes serially and checks the combined result. Never borrow another worktree's generated dependencies.
- Aim for at most about 1,500 non-generated added/deleted lines per coherent change. Explain an exception before starting; do not split one responsibility into dependent slivers to satisfy the number.
- After the prototype, return to one PR per outcome, with at most two PRs in a stack and no consolidation PRs. No global stack service.
- Use emoji plus a plain sentence for commits; no co-author or AI attribution. No per-package version ceremony before releases need it.

The review loop has **at most two independent passes per change**:

1. Builder runs relevant tests and the required checks, updates changed contracts/docs, then supplies the diff, acceptance criteria and evidence. Reviewer reads the actual code and tests, using a different model from the builder.
2. Reviewer returns one report. Each blocking finding names a concrete trigger, consequence, `file:line`, violated contract and missing/failing proof. Builder fixes substantiated findings. The second pass checks those fixes and any risk they introduce. Batch disputed findings into this pass; do not spawn a verifier for every sentence.

If blockers remain after pass two, hold the change and give the owner the evidence and decision needed in the morning. A round limit never converts a failure into a pass. Resume after that decision or a narrower scope; do not reset the counter by renaming the same change.

Block on a required-check failure, demonstrated incorrect acceptance behaviour, data loss, unauthorised access, secret exposure, an event/architecture contract breach, an incompatible runtime licence, or a materially false/missing public contract. A reproduced high-impact defect blocks regardless of the label assigned by a reviewer. An uncertain security or data-integrity concern needs a focused test or owner decision before landing. Naming preferences, speculative abstractions and optional wording improvements are non-blocking. Do not demand a finding or an ASK to prove that a review happened.

Review is read-only. It may run isolated tests. It does not deploy, grant permissions or contact users. Specialist knowledge about architecture, UI or gateway security is a section of the same review when the change needs it.

## Code: strict where behaviour depends on it

| Concern | Rule and mechanical check |
|---|---|
| Types and modules | Keep Node 22, ESM and NodeNext. Keep `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `noFallthroughCasesInSwitch`, `verbatimModuleSyntax` and `erasableSyntaxOnly`. Add `noImplicitReturns` and `noEmitOnError` for emitting projects. Every production workspace must participate in typecheck. |
| Runtime imports | Use explicit relative extensions matching the execution model: `.ts` for the current stripped-TypeScript setup; `.js` for emitted JavaScript where appropriate. Let `tsc` and a real startup test verify resolution. Do not copy OC1's extension-stripping script. |
| Typed lint | Keep type-aware recommended ESLint rules; explicitly enforce `no-floating-promises`, `no-misused-promises`, the `no-unsafe-*` rules, `no-explicit-any`, `only-throw-error` and `switch-exhaustiveness-check`. Unknown external data starts as `unknown` and is validated once at entry. |
| Errors | Distinguish rejected input, conflict, unavailable dependency and unexpected failure. Preserve the underlying cause internally; return a stable, sanitised error. No empty catches, silent fallback success or unbounded retries. Each background promise has an error path; retries declare deadline and idempotency behaviour. |
| Readability | Use Prettier output, braces and descriptive names. No underscore taxonomy, one-line import requirement, blanket arrow ban, enum mandate or mandatory paired `.types.ts` file. Keep types with the behaviour unless separating a public contract helps. Formatter enforcement is a separate rollout, not a prerequisite hidden in the first change. |
| Size | ESLint `complexity` maximum 15 and `max-depth` maximum 4; `max-lines` maximum 500 excluding blank/comment lines for hand-written production modules. Start `max-lines-per-function` at a warning of 80. These are proposed limits, not measured optimums. Split by responsibility; do not compress statements to pass. |
| Exceptions | A narrow lint disable explains the actual constraint beside the code; temporary debt links an issue. Reject unused disables. No global date-expiring exception that breaks unrelated work. Generated/vendor code has an explicit tool exclusion and is still checked at its integration boundary. |
| Dependency direction | Dependency-cruiser rejects cycles, imports from libraries into apps, private cross-package imports and service SDK imports outside their adapter. `libs/events` imports no apps or product-domain packages; its schema dependency, Zod, is permitted. Commands depend on event contracts and the append port; projection adapters own projection writes. Encode paths for the packages that actually exist. |
| Unused code | Knip checks unused files, exports and dependencies after configuring genuine runtime/test entrypoints. Delete replaced routes and reachable legacy behaviour during review too: an unused-code tool cannot find everything obsolete. |
| Logging | ESLint `no-console` in services; structured logs with operation, trace and safe entity identifiers. Test redaction of credentials, personal content and upstream error bodies. CLI output and test diagnostics have scoped exceptions. |

The tools support these jobs: [typescript-eslint rule catalogue](https://typescript-eslint.io/rules/), [dependency-cruiser](https://github.com/sverweij/dependency-cruiser), [Knip](https://knip.dev/overview/getting-started), [Prettier](https://prettier.io/docs/install). Pin compatible versions during implementation; do not add custom parsers for rules they already express.

Business invariants stay short and explicit:

- The event store is the only truth. A command performs one conditional append to one stream. No business-state write through another path.
- Projections can be deleted and rebuilt by replay. Replay must not repeat external effects. Reactions that cause effects handle duplicate delivery and ambiguous outcomes explicitly.
- Business rules live in typed TypeScript, never SQL triggers, views or stored procedures. Database constraints support projection integrity, not a second business authority.
- Add or change events in both `libs/events` and `docs/architecture/events.md`; `check:events` checks both directions.
- Money is a safe integer number of EUR cents (`…Cents`); validate ranges and reject fractions/overflow at boundaries.

Security basics are behaviour, not keyword gates: authenticate the caller; authorise every operation and resource; deny by default; test cross-user and cross-silo refusals. Bind approvals to the requester, operation and arguments. Keep short-lived tokens in computers and services, long-lived secrets in the secret store, and only secret ids in events. Validate outbound destinations, bound request size/time/output/spend, use parameterised queries and least-privilege deployment identities. New runtime dependencies must have OSI-approved licences; record the licence at introduction and inspect the shipped image's dependency inventory. Build-only data exceptions follow `AGENTS.md`. Pin dependencies and deployment artefacts; run clean `npm ci` for dependency changes. Keep secret scanning and dependency/security scanning, with findings assessed for the shipped path.

## Tests and evidence

Run `lint`, `typecheck`, `test` and `check:events` before landing, then on `main`. Retain the separate Angular `apps/web` build/test steps while the root commands do not cover them. No red baseline exemptions. If combined-main checks fail, repair or revert that change before landing more work. The four commands must cover their promised workspace scope; a skipped package is not a passing package.

Tests prove the claim: a bug fix includes the failure case; a security change includes a refused operation; persistence includes restart/replay; concurrent writes include a race. Assert durable outcomes, not mock call counts alone. Inject clocks instead of depending on sleeps. Do not add tests that merely repeat an implementation, or test cosmetic changes for ceremony.

Use real, disposable dependencies for service guarantees. Mocks prove local decisions; they cannot prove provider isolation, database rollback, routing, image contents or Kubernetes behaviour. When touching those boundaries, run their integration test before landing. Missing test infrastructure is `NOT RUN`, not success.

Separate **source ready** from **capability done**. Source may land with green checks and an explicit remaining live-qualification issue. The capability is done only after its acceptance journey passes live on a fresh install, as required by `plan.md`. Run fresh-install journeys weekly and when a capability is claimed complete. A readiness probe or rendered chart alone does not qualify a user journey.

Each evidence receipt records: date, source SHA/image digest, environment and whether fresh, command/journey, expected result, observed result, safe log/artifact link, and `PASS`, `FAIL`, `PARTIAL` or `NOT RUN`. Name the untested condition. Keep a short ledger index and link detailed run artefacts; never embed secrets. A successful workflow whose relevant jobs were skipped is `NOT RUN` for that claim.

## Documentation: a usable contract

Update the affected README, event catalogue, API documentation or ADR in the same change as its contract. One document owns each fact; others link to it. Implementers own routine documentation. A documentation agent is optional for substantial writing.

Every package README answers these questions, normally in 30–80 lines; the range is guidance:

1. What does this package do, who uses it, and what responsibility belongs elsewhere?
2. What is its public entrypoint, and what is one real usage example? Link detailed API material rather than listing every export.
3. What must callers guarantee, which failures can they receive, and how is the contract tested? Give the exact test command and state unfinished/live-unqualified behaviour.
4. What does it depend on, and where are the parent architecture and related packages documented?

Deployable packages also document required configuration/defaults, startup and verification commands, permissions, state ownership and recovery/replay. Explain consequences of dangerous options. Generate repetitive option tables from their schema when it exists. A diagram is optional; add it only when it explains a boundary more clearly than prose. Examples must name existing exports and executable commands; test important examples through normal contract tests.

Every ADR records date/status, the concrete problem, decision and reason, meaningful alternatives, costs/risks, supporting evidence and supersession links. Normally 40–100 lines; longer proof belongs in linked evidence. “Accepted” means a decision was accepted, not that it passed live. Do not write ADRs for routine refactors or scheduling. Supersede decisions with a link instead of deleting a referenced record.

Comments explain a caller obligation, invariant, state meaning, unusual failure, security boundary or non-obvious ordering. For persisted event/state values, say what the value means, what happens next, whether it is terminal and whether changing it breaks stored data. Public APIs document inputs/outputs only where their types do not explain the contract. No required comment on every property, getter, import or private helper; no comment ratio; no hand-maintained `Called by` lists. Use plain UK English, retaining precise protocol terms where necessary. If the reason is unknown, say so and investigate; never invent it.

Examples from OpenCrane 1, snapshot `468742b97`:

| Example | Lesson |
|---|---|
| Good: `libs/backend/server/conversations/history/README.md:20`: “A history conflict requires the caller to reload and recheck authority.” | Names the failure and the caller's next action. |
| Bad: `libs/contracts/README.md:17–18` says a call that would 404 fails to compile. | Types check declared paths and static request shapes; the server can still return runtime errors. State that narrower guarantee. |
| Good: `libs/backend/server/iam/membership/main/src/ed25519-fleet-membership-signature-verifier.ts:12–15` explains why the signed digest is recomputed. | Preserve the security reason; it is not obvious from the signature. |
| Bad: `libs/contracts/src/agents/agent-capability-grant.types.ts:105`: `/** Identifies this grant record. */` above `readonly id: string`. | Remove it unless a real id format/scope constraint needs explaining. |

Use [markdownlint](https://github.com/DavidAnson/markdownlint) for headings, lists, fences and duplicate headings. Use [Lychee](https://lychee.cli.rs/) for local file links in required checks and external links on a scheduled run; transient remote failures should not block an unrelated code change. Keep site dead-link checking when there is a website. Use [Vale](https://docs.vale.sh/) as an advisory UK-English/clarity check with a short domain allowlist, not a ban on technical vocabulary. Tools cannot verify that a claim is true: review consequential promises against code and evidence.

## Prompt set to keep

Store one harness-neutral copy under `docs/process/agents/`; harness configuration points to it. Do not maintain separate Claude, Codex and skill copies. Budgets below apply to the instruction text, excluding the supplied task/diff; meet both limits. No automatic recursive specialist fleet.

| Role and destination | OC1 source to copy and slim | Budget | When |
|---|---|---|---|
| `builder.md` | `.claude/commands/execute-plan.md` | 70 lines / 800 words | Each ready outcome; includes coordinator duties when several builders work. |
| `review.md` | `.claude/agents/review.md`, relevant trust-boundary points from `architecture.md` and `gateway-sentinel.md` | 90 lines / 1,100 words | One adversarial review by a separate model. |
| `review-verifier.md` | `.claude/agents/review-verifier.md` | 25 lines / 300 words | Optional batched disputed claims, within the two-pass limit. |
| `deploy.md` | `.claude/agents/deploy.md` and receipt format from `docs/agents/deploy-ledger.md` | 60 lines / 700 words | Authorised fresh-install qualification; follow the reproducible deploy entrypoint. |
| `docs.md` | `.claude/agents/{comments,readme,website,changelog}.md` | 60 lines / 700 words combined | Substantial docs changes; no compulsory final handoff. |

Record OC1 source commit `468742b97` in the copied prompt headers. Strip obsolete PostgreSQL/KurrentDB authority, Cognee assumptions, model names, permission workarounds, stack checkpoints and style catalogues. The builder and reviewer use the current `AGENTS.md`, this standard and the relevant contract; they do not preload every architecture document.

Dropped from OpenCrane 1:

- Mirrored skills and Stop judges: duplicated rules drifted, including a stale compulsory comments pass.
- Whole-graph PR policing and hourly ancestry checks: no PR stack before the prototype; later depth is capped at two.
- Grep-based formatting and prose compliance tables: established linters do the repeatable work.
- Per-file ownership inventories and SQL business-authority gates: wrong abstraction for rebuildable projections and event-only truth.
- Mandatory diagrams, every-field JSDoc and ASK quotas: they rewarded document shape instead of useful explanations.
- Pre-MVP release trains, version-to-version migration machinery and mandatory semantic-search setup: no demonstrated need in the present build loop.
- Standing reaper/observability/specialist passes: use tools and targeted questions inside the one review.

## First implementation change — later task

One coherent tooling-and-prompts change, within about 1,500 non-generated lines. No application refactor and no copying the old gate framework. These are the exact proposed files:

| Files | Change |
|---|---|
| `AGENTS.md`, `plan.md` | State main-until-prototype, two review passes, source-ready versus live-done; link this standard. Keep the short event/licence/secret invariants. |
| `eslint.config.mjs`, `tsconfig.base.json` | Add the typed correctness/size rules and compiler options above; explain existing exclusions. Keep spike isolation explicit. |
| `package.json`, `package-lock.json` | Pin compatible dev tools after checking licences; add `lint:code`, `lint:deps`, `lint:unused`, `lint:docs`, `lint:links`; make `lint` invoke them. Keep the other three required commands. |
| `.dependency-cruiser.cjs`, `knip.json` | Describe the actual workspace graph and legitimate runtime/test entrypoints, without speculative future directories or blanket ignores. |
| `.markdownlint-cli2.jsonc`, `.lychee.toml` | Check maintained Markdown and local links. No line-length gate; narrow exclusions for generated/vendor material. |
| `.github/workflows/ci.yml` | Retain clean install, all four required commands and the existing `apps/web` build/test steps. Install a pinned Lychee release binary with checksum verification before lint; `npm ci` alone does not install it. No success based on an unchanged-branch skip. |
| `apps/web/README.md`, `apps/server/README.md`, `libs/auth/README.md`, `libs/protocol/README.md`, `libs/observability/README.md`, `libs/events/README.md` | Document the six current packages from their actual contracts and runnable commands. Package README presence/content is checked in review; markdownlint alone cannot prove either. |
| `docs/process/agents/builder.md`, `docs/process/agents/review.md`, `docs/process/agents/review-verifier.md`, `docs/process/agents/deploy.md`, `docs/process/agents/docs.md` | Create the five slim prompts within the budgets above; each has one source. |
| `docs/process/standards.md` | Record what was actually enabled and evidence; keep deferred items labelled. |

Validate with clean `npm ci` on Node 22, the same pinned Lychee binary on the local PATH as in CI, all four required commands plus the web build/tests, and deliberate temporary violations in a disposable checkout: an unsafe promise, forbidden dependency, unused export and broken Markdown link must fail their owning command. Document that binary's version and local installation instructions here when selected. Restore those probes; do not commit fixture bureaucracy for standard linters. Confirm existing package tests are discovered and exceptions are narrow. Check prompt budgets mechanically. Report command durations as a baseline, not a promised speed-up.

Defer Prettier's formatting rollout (`.prettierrc.json`, `.prettierignore`, pinned dev dependency and `format`/`lint:format` commands), Vale, external-link scheduling, site publication, deployment qualification automation and generated config tables to their owning work. This avoids mixing a repository-wide reformat with the first tooling change. Do not pretend deferred checks are enabled. Before returning to PRs, configure required CI status checks in repository protection; that hosted setting is separate from these files.
