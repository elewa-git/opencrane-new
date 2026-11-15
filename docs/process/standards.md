# OpenCrane 2 standards

Standard, 1 October 2026. The first tooling and prompt change is installed; the final section records its scope and evidence. The [review](standards-review.md) records the evidence behind the choices.

Keep the four required checks, one independent adversarial review and fresh-install evidence. Put repeatable rules in tools. Keep instructions about judgement short, and give each rule one home.

## Work and review

Build each slice of a feature on a development branch with a well-described PR: **Why / Functional outcome / Architecture / Evidence / Not in this PR**. The orchestrator merges after gates, independent review and green CI. Small fixes go inside the slice's PR; once it has merged, they go into the ticket's next slice. A different model reviews; the owner reviews the result each morning.

- Take ready issues with an outcome, acceptance criteria and decisions already made. Read the relevant plan section, not the whole historical record.
- Parallel builders have separate worktrees, installed dependencies and assigned files. One integrator lands their changes serially and checks the combined result. Never borrow another worktree's generated dependencies.
- Deliver a feature in slices and keep to the ticket's limits: see [Delivery rules](#delivery-rules-finish-before-you-start). At most two PRs in a stack and no consolidation PRs. No global stack service.
- Use emoji plus a plain sentence for commits; no co-author or AI attribution. No per-package version ceremony before releases need it.

The review loop has **at most two independent passes per change**:

1. Builder runs relevant tests and the required checks, updates changed contracts/docs, then supplies the diff, acceptance criteria and evidence. Reviewer reads the actual code and tests, using a different model from the builder.
2. Reviewer returns one report. Each blocking finding names a concrete trigger, consequence, `file:line`, violated contract and missing/failing proof. Builder fixes substantiated findings. The second pass checks those fixes and any risk they introduce. Batch disputed findings into this pass; do not spawn a verifier for every sentence.

If blockers remain after pass two, hold the change and give the owner the evidence and decision needed in the morning. A round limit never converts a failure into a pass. Resume after that decision, with a narrower scope if the owner chooses one; do not reset the counter by renaming the same change.

Block on a required-check failure, demonstrated incorrect acceptance behaviour, data loss, unauthorised access, secret exposure, an event/architecture contract breach, an incompatible runtime licence, or a materially false/missing public contract. A reproduced high-impact defect blocks regardless of the label assigned by a reviewer. An uncertain security or data-integrity concern needs a focused test or owner decision before landing. Breaches of the code style in [AGENTS.md](../../AGENTS.md#style), or of the [Then make it right](#then-make-it-right) table, in new or changed code are fix findings: the builder fixes them before landing. Raise them in the first pass; the second pass raises a new one only where a fix itself broke a rule. After pass two, a size limit raised or switched off inside a file, or an import from another app's source or from `scripts/`, holds the change for the owner. Any other fix finding still open is listed under "Not in this PR" and does not hold the change. Other naming preferences and optional wording improvements are non-blocking. Do not demand a finding or an ASK to prove that a review happened.

Review is read-only. It may run isolated tests. It does not deploy, grant permissions or contact users. Specialist knowledge about architecture, UI or gateway security is a section of the same review when the change needs it.

## Delivery rules: finish before you start

Owner decision (12 November 2026). The review of 10 November 2026 found 821 merged PRs in six weeks, yet no feature ticket had closed for eighteen days. One user story took 78 PRs and another 54, and neither worked. Each PR was small and green, so nothing looked wrong. These rules make a ticket's progress visible in what a person can do, not in how many PRs merged.

### A feature lands in slices

- **A slice is something a person can do.** After a slice merges, a person can do one more thing from start to finish in the running product, with the feature switched on, on a fresh dev stack (`infra/dev-stack/up.sh --fresh`). A refusal counts only where a person can trigger it and see it there. The PR's Evidence names that journey and shows PASS. With NOT RUN the PR does not merge.
- **Every merged PR counts as a slice**, whatever it is called: part, row, groundwork, test harness, qualification, fix or rebase. A PR that only adds a part nobody can reach yet does not merge on its own. It waits inside the slice that makes it reachable.
- **At most five slices per feature.** Most tickets need two or three; five is a ceiling, not a target. Before the first build, the orchestrator posts one comment on the issue that begins `**Slices:**` and lists them, one line each, saying what a person can do after that slice merges. A design that needs more than five is too big: the owner splits the ticket or cuts its scope first. Only the owner changes the list after the first build.
- **Count the code that ships.** Aim for at most about 800 added plus deleted lines per slice, generated files not counted, in everything the feature needs in order to run: `apps/*/src`, `libs/*/src`, `infra/package`, and any code the slice adds under `scripts/`, `tools/` or `infra/`. Test files, documents, release notes and receipts are not counted. Explain a larger slice before starting it.
- **Specs set no smaller limits.** A design or spec must not set its own limit on lines per PR, and must not divide a slice into several PRs to meet one. Limits of that kind in earlier specs no longer apply.
- **Fix inside the slice.** A blocking finding from review is fixed in the same PR before it merges. A fix finding still open after pass two, and a fault found after the merge, are fixed in the ticket's next slice. If no slice remains, the fix is its own PR and counts towards the five.

### A ticket has limits

Each ticket has three limits: the slices listed on the issue, 8 agent-hours for each listed slice, and two rounds of rework for each listed slice. Agent-hours cover builder, reviewer, verifier and journey runs. A round of rework is each time a review, CI or a journey sends the work back to be fixed: on the board, each move into Fixing. The two-pass review limit still applies to each slice's PR; these limits add up across the ticket.

The orchestrator checks the three numbers before it starts each task. Every progress comment on the issue states them, for example `slice 2 of 4 · agent: 11.5 h · rework rounds: 3`.

When a ticket passes any limit:

1. The orchestrator starts no new task for it and cancels tasks that are queued. Tasks already running may finish.
2. It labels the issue `needs-owner` and posts one comment that says what a person can do today, what remains, which assumption turned out wrong, and two ways forward: a smaller scope that finishes, or the higher limits the full scope needs.
3. Work resumes only after the owner picks one of the two. The orchestrator takes no default here: it never uses `owner-default-taken` for a ticket that has run over, and it never treats silence, a needed-by date or a comment it wrote itself as the owner's answer. It quotes the owner's answer on the issue, with the new limits in numbers.

Only the owner opens, splits or renames a feature ticket. Never get round a limit, before or after reaching it, by renaming the ticket, splitting it, moving work to another ticket, or filing the work as a bug, security, clean-code or qualification issue.

### Finish before you start

- **At most six feature tickets are in progress at once**, two for each builder. A feature ticket is an open issue whose outcome is something a user or an operator can do: the phase tickets and every ticket on the pilot track. Debt tickets on the clean-code map (#1031) and tickets for flaky tests, CI or documents are not counted in the six, but the limits above apply to them too.
- **What "in progress" means.** A feature ticket is in progress when it is open, work on it has started and it does not carry the `parked` label. Its board column does not matter: a ticket resting in Ready between slices, waiting in CI or a journey, in Awaiting feedback or labelled `needs-owner` still counts. It stops counting when its acceptance journey passes on a fresh dev stack with the feature switched on and the issue is closed, or when the owner parks it.
- **Start a new ticket only below six.** Finishing a ticket, or parking it, makes room.
- **Parked means stopped.** The orchestrator adds the `parked` label, removes `ready-for-agent` and posts one comment: `**Parked** (owner decision, <date>): no builder time until the owner removes this label.` A parked ticket gets no new task of any kind. An open PR merges only if its review has already passed and CI is green without another builder task; otherwise the orchestrator closes it unmerged, keeps the branch and names it in the comment. The ticket's code stays switched off. Only the owner removes `parked`.
- **Order of work.** First repair a failing `main`. Then the pilot track in `plan.md`. Then at most one builder at a time on the debt tickets of the clean-code map (#1031); the map's product tickets are feature tickets under these rules. Then everything else.
- **Starting these rules.** On the day they take effect, the orchestrator starts no new task except a repair of a failing `main`; tasks already running finish. It opens one issue titled "Delivery rules start: feature tickets in progress", labelled `needs-owner`, with one row for each feature ticket in progress: issue, board column, agent-hours, moves into Fixing, merged PRs, open PRs, what a person can do today, and whether `plan.md` puts it on the pilot track or the parked list. The owner answers there with the tickets that continue (at most six, the pilot track included) and new limits for each. The orchestrator then posts those limits and a `**Slices:**` list on each continuing ticket, parks the rest, and resumes.

## Engineering discipline: make it work, then make it right

Owner decision (10 November 2026): every change follows three steps, taken from Robert C. Martin's [ub-mode](https://github.com/unclebob/ub-mode) (MIT licence) and fitted to this repository. Where ub-mode and this standard differ, this standard wins. In particular, changes land through a reviewed PR, never by pushing to `main`.

The reason is the review of 10 November 2026. It found the same id check written 136 times, the same command steps copied into dozens of files, file-size limits raised file by file, 287 functions with six or more parameters, and tests that only grow. No rule asked a builder to tidy up after making a change work. This section adds that step.

### First make it work

- **One decision lives in one place.** Search for an existing schema, digest, comparison, event envelope, guard, test builder, server call or style rule before writing one, and import it. If you need the same decision a second time (the same rule, format, check or sequence of steps), move it to a shared home first and use it in the code you write and in the copy you took it from. Leave the other old copies to their issue. Code that only looks alike but follows different rules stays separate, and code that is clear and used in one place stays where it is.
- **Shared homes.** `libs/events` holds contract-level schemas and digests. `libs/protocol` holds shapes the website shares (the website may not import `libs/events`). Other shared code goes to the library that owns the subject. Test helpers go to the owning library's `testing` entry point (`libs/auth`, `libs/authz`, `libs/event-store`, `libs/models` and `libs/projections` have one), or to an app's `test/support/` folder when only that app's tests use them. Shared website components and styles go to `apps/web/src/app/ui`.
- **Get the data shape right before the logic.** Name the types. Parse outside data once, where it comes in, and trust the parsed value inside. Keep each business rule in a pure function that takes values and returns a result.
- **Write the failing test first** when you change behaviour. See it fail for the reason you expect, then make the smallest change that passes. If an honest test is impractical, say so and report NOT RUN. Never write a test that would still pass if the code did nothing.
- **Fix the cause.** When you fix a failure, reproduce it first with a test that fails for that reason, then fix what caused it. A guard, retry, longer timeout, sleep or catch that only hides the failure is not a fix. This holds for a test that fails by chance as much as for product code.
- **Build the thinnest working journey first.** In the feature's first slice, make one real path work from start to finish, with its access checks and refusals. Add stopping, cleaning up and recovery after that path runs.
- **Subtract before you add.** Remove what the change replaces, in the same PR. Do not bolt a new requirement onto a design that no longer fits. Say what you would have built if the requirement had been there from the start, and deliver that in pieces.
- **Attack the premise.** When two fixes that rest on the same assumption fail the same check, or a fix fails the second review pass, stop. Count earlier PRs for the same issue too. Write the shared assumption in one sentence and take it to the owner before trying again.

### Then make it right

Do this before review. Code you add must meet every row below. For code that already existed, "touched" means a function you edited and a file you added lines to. A touched function or file that already breaks a row must not get worse: no longer, no more parameters, no higher limit, no new copy. Fix the old breach in the same PR only when the fix is small and stays inside the ticket's files. Otherwise leave it to its issue in the clean-code map, #1031. Do not widen the change to unrelated code.

To restructure code safely, first pin what it does with tests, then change the structure, then show the behaviour did not change.

"Counted lines" leave out blank lines and comment lines. The size rows apply to hand-written production code in `apps/*/src` and `libs/*/src`.

| Concern | Rule | How it is checked |
| --- | --- | --- |
| Duplication | No new copy of a decision that already exists. Two functions with the same structure and the same rule become one. | Review today. Once #1034 lands: `dryer` reports no duplicate at a similarity of 0.8 or above in changed files. |
| Function size | At most 80 counted lines. Split by responsibility, so that each part does a job a reader can name. Do not split a function that is within the limit and reads from top to bottom, and do not declare a named function inside another one to pass the limit. | ESLint `max-lines-per-function` error at 80; existing violations use bulk suppressions. |
| Parameters | At most five. A function that needs more is usually doing two jobs: split it first. Pass one named object with a named, exported type only for values that belong together; do not bundle unrelated values to pass the limit. | ESLint `max-params` error at five; existing violations use bulk suppressions. |
| Complexity against tests | Every changed function scores under 10 on CRAP: complexity² × (1 − coverage)³ + complexity. A flat `switch` with one short branch per event type or state may stay whole when every branch is tested. ESLint `complexity` 15 stays the hard limit. | Not checked today. `crapper` on changed files once #1034 lands. |
| File size | At most 500 counted lines. Never raise or switch off the limit inside a file. A file that needs more is doing two jobs: split it, or ask the owner. | ESLint error today. `lint:debt` refuses a new or raised per-file override. |
| Module direction | One app never imports another app's source. Product source never imports from `scripts/`. Shared code moves to a library. | Review today; dependency-cruiser once #1032 lands. |
| Errors | Follow the Errors row under [Code](#code-strict-where-behaviour-depends-on-it). Keep the cause (`new Error(message, { cause })`) and log it through the structured logger, which hides credentials and private content, before returning the safe message. A refusal carries a `reason` from a named union type, as existing routes do, not only a sentence. | Review. |
| Tests | Follow [Tests and evidence](#tests-and-evidence): check what the user of the code would see, use the shared test helpers, control time (pass it in, or use Vitest fake timers) instead of sleeping, and delete tests the change makes redundant. | Review and ESLint `max-lines` error at 1,500 counted lines for test files. |
| Test strength | Tests of access checks, approvals and money must fail when the rule they protect is broken. | Today: when you add or change such a test, break the rule by hand once, see the test fail, restore the code and say so in your report. `mutator` on those packages, on a schedule, once #1034 lands. |
| READMEs | Describe the package as it is now. Edit the sentence that changed; never append a note per change. | Review today; the README check once #1035 lands. |

A check marked "once … lands" is not enabled yet, and nobody estimates a tool's score by eye. `dryer`, `crapper` and `mutator` are not installed: do not install or run them until this table says they are enabled.

### Practice

- Commit in small ordered steps: one emoji and a plain sentence, with a short body when the reason or the proof is not obvious.
- Keep a short log of what you did and why, and put it in your final report, not in the repository.
- Keep your working context small. Read the files the change needs and the parts of README.robot.md that cover them, not the whole history.
- Release a dev stack you claimed as soon as your journeys finish. A builder never removes the worktree it runs in: review, the gates and the secret scan still use it. The orchestrator removes it after the change lands or is dropped. Uncommitted work waits for the owner's decision; never delete it.

## Code: strict where behaviour depends on it

| Concern | Rule and mechanical check |
| --- | --- |
| Types and modules | Keep Node 22, ESM and NodeNext. Keep `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `noFallthroughCasesInSwitch`, `verbatimModuleSyntax` and `erasableSyntaxOnly`. Add `noImplicitReturns` and `noEmitOnError` for emitting projects. Every production workspace must participate in typecheck. |
| Runtime imports | Use explicit relative extensions matching the execution model: `.ts` for the current stripped-TypeScript setup; `.js` for emitted JavaScript where appropriate. Let `tsc` and a real startup test verify resolution. Do not copy OC1's extension-stripping script. |
| Typed lint | Keep type-aware recommended ESLint rules; explicitly enforce `no-floating-promises`, `no-misused-promises`, the `no-unsafe-*` rules, `no-explicit-any`, `only-throw-error` and `switch-exhaustiveness-check`. Unknown external data starts as `unknown` and is validated once at entry. |
| Errors | Distinguish rejected input, conflict, unavailable dependency and unexpected failure. Preserve the underlying cause internally; return a stable, sanitised error. No empty catches, silent fallback success or unbounded retries. Each background promise has an error path; retries declare deadline and idempotency behaviour. |
| Readability | Follow the owner's code style in [AGENTS.md](../../AGENTS.md#style): build only what is needed, as verbose, clear code; small atomic named functions; no chaining, inline definitions with logic or nested ternaries; why-comments at invariants and boundaries. Use Prettier output, braces and descriptive names. No underscore taxonomy, one-line import requirement, blanket arrow ban, enum mandate or mandatory paired `.types.ts` file. Keep types with the behaviour unless separating a public contract helps. Formatter enforcement is a separate rollout, not a prerequisite hidden in the first change. |
| Size | ESLint `complexity` maximum 15 and `max-depth` maximum 4; `max-lines` maximum 500 excluding blank/comment lines for hand-written production modules. `max-lines-per-function` errors at 80 and `max-params` at five. Test files (`*.test.ts`, `*.spec.ts`, `*.test.mjs`) have at most 1,500 counted lines. Split by responsibility; do not compress statements to pass. |
| Exceptions | `eslint-suppressions.json` and `scripts/lint-size-exceptions.json` are the only size-debt records. Existing function-length and parameter violations use ESLint bulk suppressions. File-size exceptions have numbered comments capped by the latter list; its one existing complexity disable is recorded there too. `lint:debt` rejects unlisted or missing comments, extra file-size config blocks, new entries, raised caps and increased per-rule suppression totals against the base commit. Never add or raise an in-file size limit. For other rules, a narrow lint disable explains the actual constraint beside the code; temporary debt links an issue. Reject unused disables. No global date-expiring exception that breaks unrelated work. Generated/vendor code has an explicit tool exclusion and is still checked at its integration boundary. |
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

Tests prove the claim: a bug fix includes the failure case; a security change includes a refused operation; persistence includes restart/replay; concurrent writes include a race. Assert durable outcomes, not mock call counts alone. Inject clocks instead of depending on sleeps. Do not add tests that merely repeat an implementation, or test cosmetic changes for ceremony. Build test data with shared helpers: the owning library's `testing` entry point, or the app's `test/support/` folder for helpers only that app's tests use. Add a missing helper there instead of declaring one in the test file. When a change replaces behaviour, delete the tests of the old behaviour in the same PR.

Use real, disposable dependencies for service guarantees. Mocks prove local decisions; they cannot prove provider isolation, database rollback, routing, image contents or Kubernetes behaviour. When touching those boundaries, run their integration test before landing. Missing test infrastructure is `NOT RUN`, not success.

Separate **source ready** from **capability done**. Source may land with green checks and an explicit remaining live-qualification issue. The capability is done only after its acceptance journey passes live on a fresh install, as required by `plan.md`. Run fresh-install journeys weekly and when a capability is claimed complete. A readiness probe or rendered chart alone does not qualify a user journey.

Each evidence receipt records: date, source SHA/image digest, environment and whether fresh, command/journey, expected result, observed result, safe log/artifact link, and `PASS`, `FAIL`, `PARTIAL` or `NOT RUN`. Name the untested condition. Keep a short ledger index and link detailed run artefacts; never embed secrets. A successful workflow whose relevant jobs were skipped is `NOT RUN` for that claim.

## Documentation: a usable contract

Update the affected README, event catalogue, API documentation or ADR in the same change as its contract. One document owns each fact; others link to it. Implementers own routine documentation. A documentation agent is optional for substantial writing.

### README standard

Owner decision (5 October 2026): each package README carries one small diagram.

Each package gets a README.md for people. When it needs one, it also gets a README.robot.md for agents.

#### README.md, for people

It is written for a new engineer, or for a manager who is not an engineer. It uses these fixed headings, in this order:

1. `## What this is`: the first sentence is the one-line summary. If the folder has a package.json, use the same words as its `description`. Then add two to four short sentences.
2. `## Where it fits`: which layer the package belongs to (the root README names the layers), who talks to it and what it talks to. Then one small diagram.
3. `## What it is responsible for`: one line per job, each starting with a verb. If part of the job is not built yet, end with a short "Not built yet" list in plain words.
4. `## Processes it handles`: short stories from start to finish, two or three sentences each. For example: "A person uploads a file. The server scans it, stores it and passes it to their computer."
5. `## How to run or test it`: the two or three commands people actually use. For a library, add one short real example of calling it.
6. `## Where to read more`: README.robot.md, related packages, and decisions in `docs/adr`, each linked with a plain description of the decision, not its file title, for example [why NATS JetStream holds the event log](../../docs/adr/0001-event-store-nats-jetstream.md).

Rules for the diagram:

- Use a Mermaid `flowchart` (GitHub draws it) with at most 8 boxes.
- Put the package in the middle. Show its parent layer or main callers, and the packages and services it deals with directly. Leave out anything further away.
- Each box holds the folder or service name, then two to four plain words. Put labels in double quotes and use `<br/>` for a line break.
- A solid arrow is something that happens while the system runs. A dotted arrow points from a package to the shared code it uses, or marks a part that is only planned. Label every solid arrow with a few words. A dotted 'uses' arrow, or an arrow from a folder to a part inside it, may stay unlabelled.
- Check every arrow against the real imports and calls. The drafts in the sub-issues are a head start, not proof.

Writing rules:

- No ticket, issue, board, phase, experiment, handoff or wireframe codes.
- No evidence or receipt links, and no test status codes such as PASS or NOT RUN. Say plainly what works and what does not work yet.
- Use short sentences and everyday words. Explain a technical word in a few words the first time, or link it to GLOSSARY.md.
- Name other parts by their folder (`apps/server`) and say what they are the first time.
- Describe today's code. Mark anything planned as planned.
- Keep it current, not chronological. When a change alters a fact, edit the sentence that states it. Never add a paragraph per change: the PR and the release note record what changed.
- Use UK English and the active voice.
- Aim for about 50 to 120 lines. More than 150 lines means some detail belongs in README.robot.md.

Template:

````markdown
# apps/example

## What this is

One plain sentence, the same as the package.json description. Then two to four short
sentences. Explain a technical word the first time, or link it to
[the glossary](../../GLOSSARY.md).

## Where it fits

Which layer it belongs to, who talks to it and what it talks to.

```mermaid
flowchart LR
  caller["apps/caller<br/>what it is"] -->|what travels| me["apps/example<br/>what it is"]
  me -.->|uses| lib["libs/shared<br/>what it is"]
```

## What it is responsible for

- One line per job, starting with a verb.
- Not built yet: say it plainly, only if true.

## Processes it handles

1. **A person signs in.** Two or three sentences, from what starts it to the result.

## How to run or test it

```sh
npm test -w @opencrane/example
```

## Where to read more

- [README.robot.md](README.robot.md): exact contracts, settings, limits, test detail and history.
- Related packages, and decisions described in plain words.
````

#### README.robot.md, for agents and maintainers

- **What goes in it.** Everything agents need and people do not:
  - ticket and issue ids, handoff and state codes, phase numbers;
  - dated owner decisions;
  - evidence and receipt links, and test status;
  - exact limits and full API contracts;
  - one table of all settings (environment variables);
  - test commands and what each one proves;
  - licence audit notes and implementation detail.
- **Moved, not deleted.** For each package, start with `git mv README.md README.robot.md`, then write a fresh README.md. Git and GitHub show this as a rewritten README.md and a new README.robot.md. To prove nothing was lost, run `git diff -B -M --stat main...HEAD`: each move must show as `…/README.md => …/README.robot.md` with only a few changed lines. Old history is found with `git log -B -M --follow -- <folder>/README.robot.md`. Old section links keep working once the link points at the new file name.
- **First line.** Keep the existing title as the first line. Put one line straight under it that points back: `For people, read [README.md](README.md) first.` (The Markdown check needs a title on the first line.) Fix statements that are plainly wrong, and otherwise keep the content as it is. Tidying the robot file is optional.
- **Ordered by topic, edited in place.** Group the file by subject (contracts, settings, limits, tests, recovery), not by the order changes arrived. A change replaces the lines it makes out of date; it does not add a dated paragraph. Git holds the history.
- **Only when needed.** If a package has nothing for agents beyond its README.md, it has no robot file.

#### What the standard covers

- Every folder under `apps/`, `libs/`, `infra/` and `tools/` follows the full standard.
- The root README is the system map.
- `docs/design` and `spikes` follow a lighter rule. Each has one index README.md with one diagram. Each folder inside gets a short README.md of about 3 to 15 lines. It says what the folder is, whether live code still uses it, and links to its README.robot.md. Notes copied from the design tool stay word for word in README.robot.md, under one line on top that says what is out of date.
- Not covered: the evidence folders under `docs/process`, `docs/adr/README.md` and `docs/specs`. They are records for agents, not guides.

### The root README: the system map

The root README.md is the front page for the whole system. It:

- explains OpenCrane in a few sentences: every person gets an AI assistant with its own safe computer, and the company sets the rules (models, tools, approvals and spending);
- names the layers that every package README refers to: browser app, back end, background workers, personal computers, event core, shared libraries, infrastructure, developer tools, design notes and early experiments;
- has a folder map with one plain line for every folder;
- has one whole-system diagram of the parts that exist today, with about 12 boxes (the only diagram allowed more than 8);
- walks through one request in plain words;
- says honestly what works today on the dev stack and what is still planned;
- states the open-source licence rule in one line;
- links to GLOSSARY.md, plan.md, CHANGELOG.md, docs/adr and docs/architecture.

The long drawing of the target cluster, and the target parts that do not exist yet, live in `docs/architecture/target.md`, which is clearly marked as planned. There is no root README.robot.md: AGENTS.md serves agents at the root, and the rest of the agent detail lives in plan.md or docs/architecture.

The root `GLOSSARY.md` explains each word the READMEs share in one or two plain sentences: silo, event, read table, reaction, computer, bridge, gateway and so on. Each entry starts by saying what the word is, for example 'A silo is one customer's own private installation of OpenCrane.' Package READMEs link to it instead of each explaining the same words at length.

### Other documentation

Deployable packages also document, in README.robot.md, required configuration/defaults, startup and verification commands, permissions, state ownership and recovery/replay. Explain consequences of dangerous options. Generate repetitive option tables from their schema when it exists. Examples must name existing exports and executable commands; test important examples through normal contract tests.

Every ADR records date/status, the concrete problem, decision and reason, meaningful alternatives, costs/risks, supporting evidence and supersession links. Normally 40–100 lines; longer proof belongs in linked evidence. “Accepted” means a decision was accepted, not that it passed live. Do not write ADRs for routine refactors or scheduling. Supersede decisions with a link instead of deleting a referenced record.

Comments explain a caller obligation, invariant, state meaning, unusual failure, security boundary or non-obvious ordering. For persisted event/state values, say what the value means, what happens next, whether it is terminal and whether changing it breaks stored data. Public APIs document inputs/outputs only where their types do not explain the contract. No required comment on every property, getter, import or private helper; no comment ratio; no hand-maintained `Called by` lists. Write comments to 'Writing for people' in AGENTS.md: plain UK English a newcomer can read, a technical term only when it names something real in the code, and no ticket or phase codes. Start most code comment sentences with a verb. READMEs and glossaries use plain statements that say what a thing is and does. If the reason is unknown, say so and investigate; never invent it.

Examples from OpenCrane 1, snapshot `468742b97`:

| Example | Lesson |
| --- | --- |
| Good: `libs/backend/server/conversations/history/README.md:20`: “A history conflict requires the caller to reload and recheck authority.” | Names the failure and the caller's next action. |
| Bad: `libs/contracts/README.md:17–18` says a call that would 404 fails to compile. | Types check declared paths and static request shapes; the server can still return runtime errors. State that narrower guarantee. |
| Good: `libs/backend/server/iam/membership/main/src/ed25519-fleet-membership-signature-verifier.ts:12–15` explains why the signed digest is recomputed. | Preserve the security reason; it is not obvious from the signature. |
| Bad: `libs/contracts/src/agents/agent-capability-grant.types.ts:105`: `/** Identifies this grant record. */` above `readonly id: string`. | Remove it unless a real id format/scope constraint needs explaining. |

`lint:docs` also checks every tracked text file under `docs/process/` for
home-directory paths, private dev-stack paths and email addresses. Public evidence
uses placeholders such as `<home>`, `<worktree>`, `<stack-dir-1>` and `<email>`.
Screenshots need visual inspection before publication.

Use [markdownlint](https://github.com/DavidAnson/markdownlint) for headings, lists, fences and duplicate headings. Use [Lychee](https://lychee.cli.rs/) for local file links in required checks and external links on a scheduled run; transient remote failures should not block an unrelated code change. Keep site dead-link checking when there is a website. Use [Vale](https://docs.vale.sh/) as an advisory UK-English/clarity check with a short domain allowlist, not a ban on technical vocabulary. Tools cannot verify that a claim is true: review consequential promises against code and evidence.

## Prompt set to keep

Store one harness-neutral copy under `docs/process/agents/`; harness configuration points to it. Do not maintain separate Claude, Codex and skill copies. Budgets below apply to the instruction text, excluding the supplied task/diff; meet both limits. No automatic recursive specialist fleet.

| Role and destination | OC1 source to copy and slim | Budget | When |
| --- | --- | --- | --- |
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
  Package READMEs now carry one small diagram (owner decision, 5 October 2026). Large or decorative diagrams stay out.
- Pre-MVP release trains, version-to-version migration machinery and mandatory semantic-search setup: no demonstrated need in the present build loop.
- Standing reaper/observability/specialist passes: use tools and targeted questions inside the one review.

## First implementation change

One coherent tooling-and-prompts change, within about 1,500 non-generated lines. No application refactor and no copying the old gate framework. The implementation scope is:

| Files | Change |
| --- | --- |
| `AGENTS.md`, `plan.md` | State main-until-prototype, two review passes, source-ready versus live-done; link this standard. Keep the short event/licence/secret invariants. |
| `eslint.config.mjs`, `tsconfig.base.json` | Add the typed correctness/size rules and compiler options above; explain existing exclusions. Keep spike isolation explicit. |
| `package.json`, `package-lock.json` | Pin compatible dev tools after checking licences; add `lint:code`, `lint:deps`, `lint:unused`, `lint:docs`, `lint:links`; make `lint` invoke them. Keep the other three required commands. |
| `.dependency-cruiser.cjs`, `knip.json` | Describe the actual workspace graph and legitimate runtime/test entrypoints, without speculative future directories or blanket ignores. |
| `.markdownlint-cli2.jsonc`, `.lychee.toml` | Check maintained Markdown and local links. No line-length gate; narrow exclusions for generated/vendor material. |
| `.github/workflows/ci.yml` | Retain clean install, all four required commands and the existing `apps/web` build/test steps. Install a pinned Lychee release binary with checksum verification before lint; `npm ci` alone does not install it. No success based on an unchanged-branch skip. |
| `apps/web/README.md`, `apps/server/README.md`, `libs/auth/README.md`, `libs/protocol/README.md`, `libs/observability/README.md`, `libs/events/README.md` | Document the six current packages from their actual contracts and runnable commands. Package README presence/content is checked in review; markdownlint alone cannot prove either. |
| `docs/process/agents/builder.md`, `docs/process/agents/review.md`, `docs/process/agents/review-verifier.md`, `docs/process/agents/deploy.md`, `docs/process/agents/docs.md` | Create the five slim prompts within the budgets above; each has one source. |
| `docs/process/standards.md` | Record what was actually enabled and evidence; keep deferred items labelled. |

Validate with clean `npm ci` on Node 22, the same pinned Lychee binary locally and in CI, all four required commands plus the web build/tests, and deliberate temporary violations in a disposable checkout: an unsafe promise, forbidden dependency, unused export and broken Markdown link must fail their owning command. Document that binary's version and local installation instructions here when selected. Restore those probes; do not commit fixture bureaucracy for standard linters. Confirm existing package tests are discovered and exceptions are narrow. Check prompt budgets mechanically. Report command durations as a baseline, not a promised speed-up.

Defer Prettier's formatting rollout (`.prettierrc.json`, `.prettierignore`, pinned dev dependency and `format`/`lint:format` commands), Vale, external-link scheduling, site publication, deployment qualification automation and generated config tables to their owning work. This avoids mixing a repository-wide reformat with the first tooling change. Do not pretend deferred checks are enabled. Before returning to PRs, configure required CI status checks in repository protection; that hosted setting is separate from these files.

## Enabled checks and local setup — 1 October 2026

The first implementation is installed. `lint` runs code, recorded size debt, dependency direction,
unused code, Markdown and offline local-link checks in that order. Spikes and
infrastructure code stay separately qualified. Markdown inputs are root documents,
`docs/**/*.md`, and README.md and README.robot.md files under apps, libs and infra.
Generated builds, dependency trees and vendored material stay outside those inputs. ESLint explicitly excludes dependency/build/cache output, spikes and infra.

Typed lint enforces every `no-unsafe-*` rule plus the named promise, `any`, error and
exhaustiveness rules. Production modules have complexity 15, depth 4 and 500 code lines;
function length errors at 80 and parameters at five. Tests have a 1,500 counted-line
file limit and retain typed correctness. `lint:code` refuses all warnings.
`lint:debt` runs immediately afterwards and checks both debt records.
Services and Node libraries reject console logging. Unused disables are errors; two
partial pino test doubles explain their assertion exceptions beside the affected code.
CI supplies the pull request base as `BASE_SHA`; local checks use
`git merge-base origin/main HEAD`. Without a base commit, only the comparison is
skipped. A ledger absent from the base may be introduced once. Debt may rise only
in the change that adds `.prettierrc.json` when the base has none, to allow the
planned formatting rollout. Comment/list checks still apply in that change.
All six packages typecheck. The root command runs every workspace without `--if-present`,
so a missing workspace script fails the check. `noImplicitReturns` and `noEmitOnError`
are set; Angular keeps its existing bundler module model and now also refuses emission
on type errors.

Dependency-cruiser covers the six existing packages, public entrypoints, cycles,
library-to-app direction, event independence and the OIDC/telemetry SDK adapters.
Knip discovers runtime entrypoints from package exports/scripts and its Angular plugin;
explicit test globs cover root Vitest and Angular specs. Public package exports remain
intentional API entrypoints; unused internal exports, files and dependencies are checked.
No command/projection adapter paths are invented before those implementations exist.

Licences checked before installation via npm metadata, then against installed LICENSE
files: dependency-cruiser **18.5.0 MIT**, Knip **6.39.0 ISC**, markdownlint-cli2
**0.23.3 MIT**. All are exact dev-only pins compatible with Node 22. The lockfile was
regenerated by npm, never edited manually. The graph, strict lint, six READMEs and five
prompts are installed; README completeness still needs review against the actual contract.

The link check runs [Lychee 0.23.0](https://github.com/lycheeverse/lychee/releases/tag/lychee-v0.23.0).
Before running it, `scripts/fetch-lychee.sh` downloads the matching macOS arm64 or Linux
x86-64 release into the ignored `.tools/` directory and verifies its pinned SHA-256.
CI calls the same script, so the version and both checksums have one source. From a clean
clone, install dependencies and run lint normally:

```sh
npm ci
npm run lint
```

The script reuses `.tools/lychee` when it is already the pinned version. Other operating
system and architecture combinations are rejected rather than using an unverified asset.
Required link checks are offline, including local fragments. External URLs are excluded
by offline mode, not claimed valid. Old OC1-only references are labelled as historical
source paths; stale local ADR filenames and Markdown layout were corrected.

### Implementation evidence

Receipt: 2026-10-01, base `2ae76139684b4e48c6ff01e488bb6dadfc1725f0` plus this
uncommitted working tree; Darwin arm64, Node **22.15.0**, clean `npm ci`, verified
Lychee **0.23.0** macOS asset. This is local source evidence, not a fresh silo.
Safe command logs and JSON timings are in `/private/tmp/oc2-standards-evidence/`
on the builder host; the integrator should retain them with the eventual source SHA.

| Command | Result | Baseline seconds |
| --- | --- | --- |
| `npm ci` | PASS, clean install | 7.27 |
| `npm run lint` | PASS, all five checks | 7.00 |
| `npm run typecheck` | PASS, all six workspaces | 4.72 |
| `npm test` | PASS, 33 files / 718 tests | 1.82 |
| `npm run check:events` | PASS, 70 event types agree | 0.16 |
| `npm run build -w apps/web` | PASS | 3.32 |
| `npm run test -w apps/web` | PASS, 2 files / 27 tests | 1.95 |

The four library README examples also ran successfully under Node type stripping.
These are measured local timings, not a speed guarantee. Final lint and root tests
were rerun after the last rule/assertion cleanup; documentation checks cover this receipt.

Failure probes ran in an independently installed disposable copy. Each owning command
first passed there, then failed with the expected diagnostic after its single mutation:

| Mutation | Owning command / observed proof | Seconds |
| --- | --- | --- |
| Unhandled `Promise.resolve` | `lint:code`, exit 1, `no-floating-promises` | 11.27 |
| `any` value used as a callable | `lint:code`, exit 1, `no-unsafe-call` | 5.59 |
| Library imports server | `lint:deps`, exit 3, `libraries-do-not-import-apps` | 0.59 |
| Private auth import | `lint:deps`, exit 1, `public-entry-only-libs-auth` | 0.50 |
| OIDC SDK outside adapter | `lint:deps`, exit 1, `oidc-sdk-in-adapter` | 0.58 |
| Telemetry SDK outside adapter | `lint:deps`, exit 1, `telemetry-sdk-in-adapter` | 0.49 |
| Unused internal export | `lint:unused`, exit 1, `standardsUnused` | 0.44 |
| Duplicate Markdown heading | `lint:docs`, exit 1, `MD024` | 0.39 |
| Missing relative Markdown target | `lint:links`, exit 2, `Cannot find file` | 0.10 |
| 503 code lines in a production file | `lint:code`, exit 1, `max-lines` | 5.41 |
| Console call in server | `lint:code`, exit 1, `no-console` | 4.42 |
| Missing return branch | `typecheck`, exit 2, `Not all code paths return a value` | 4.54 |

All twelve rejection proofs: PASS. Each mutation was restored, and the entire disposable
copy was deleted. No probe fixtures are part of the change. An initial copy omitted
spike link targets; it was discarded and recreated with those targets before probing.

Mechanical prompt budgets (lines / whitespace-separated words): builder **35 / 326**,
review **46 / 452**, verifier **22 / 182**, deploy **33 / 305**, docs **31 / 300**:
all PASS against both limits. The six READMEs are 39–51 lines each.

Independent adversarial review, Linux hosted CI execution and live fresh-silo journeys:
**NOT RUN** by this implementation task; this receipt makes no capability-done claim.
Deferred: Prettier enforcement, Vale, scheduled external links, site publication,
deployment qualification automation, generated configuration tables and hosted branch
protection. None is silently included in these passing gates.
