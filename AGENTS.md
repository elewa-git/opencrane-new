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

Runtime images have two layers (owner decision, 2 October 2026):

- **Application dependencies** (npm and Python packages, our own code, Codex
  and any other binary we add) must be OSI-approved. The PSF/Python licence
  and HPND variants count as OSI-approved. Third-party parts bundled inside an
  OSI-licensed package may carry DFSG-free notices (for example CC0, public
  domain, TCL, FreeType, IJG); each one is listed with its reason in the
  image's reviewed licence file.
- **The operating-system layer** may use Debian **main** packages (DFSG-free),
  including public-domain, CC0 and permissive notices such as Unicode, X11,
  HPND and OFL fonts. Debian `non-free` and `contrib`, and source-available
  licences (BUSL, SSPL, KLv1 and similar), are always rejected.

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

**Access checks stay small and quick.** Before a write, the server notes the
latest position of each stream that grants access (`authorityFence` in
`libs/models/src/authority.ts`). It refuses the write if one of them moved or
if 2 seconds passed. So:

- Only watch the small streams that decide access: member, assistant, team,
  payer and grant streams. Never watch a whole conversation stream for a
  personal session, and never put one in a fence used for reading.
- Never read a whole conversation stream inside that 2-second limit. Read the
  history first, with its own time limit, then check access.
- Reads check access once, at that moment. Only writes and turn starts need the
  fence.
- Activity that does not change who has access, such as a turn starting or a
  file arriving, must never refuse a reader or close a viewer.

Three branches broke these rules in the same week and locked users out of long
chats, so reviewers treat a break as a blocking finding.

## The event catalogue is the contract

[docs/architecture/events.md](docs/architecture/events.md) states exactly
which event triggers which logic. `libs/events` is that catalogue in code:
its registry must name the same event types as the catalogue's tables, in
both directions. `npm run check:events` enforces this; never add an event
type to one without the other.

## Size and process

Follow the [engineering standard](docs/process/standards.md).

- Build each slice of a feature on a development branch with a well-described PR:
  Why / Functional outcome / Architecture / Evidence / Not in this PR. The
  orchestrator merges after gates, independent review and green CI. Small fixes
  go inside the slice's PR, or into the ticket's next slice once it has merged.
- Deliver a feature in at most five slices. After each slice merges, a person
  can do one more thing from start to finish on a fresh dev stack; without
  that PASS it does not merge. Aim for at most about 800 changed lines of
  shipped code per slice; tests and documents are not counted. No more than
  two open PRs stacked on each other, and no consolidation PRs.
- A ticket has limits: its listed slices, and 8 agent-hours and two rounds of
  rework for each. Past any limit, stop and wait for the owner; take no
  default. At most six feature tickets are in progress at once. See the
  [delivery rules](docs/process/standards.md#delivery-rules-finish-before-you-start).
- At most two independent review passes: a different model reviews the diff,
  then verifies fixes and batched disputed findings. Remaining blockers go
  to the owner; the pass limit never turns failure into success.
- Required checks (`lint`, `typecheck`, `test`, `check:events`) must pass
  before landing and on `main`; repair or revert failures before landing more.
- Add new release notes as one plain Markdown file in `changes/unreleased/`,
  named after the branch. Do not edit the Unreleased section in `CHANGELOG.md`.
  The changelog gather script collects these files before a release.
- Run vitest, lint, typecheck and builds under `nice -n 10`. Never start a full
  root suite or a fleet batch while a live-view qualification batch is running.
- Source ready means green checks with remaining live qualification explicit.
  A capability is done only after its journey passes live on a fresh install.
  Report PASS/FAIL/PARTIAL/NOT RUN honestly; untested conditions never pass.

## Make it work, then make it right

Owner rule (10 November 2026): every change follows the three steps in the
[engineering discipline](docs/process/standards.md#engineering-discipline-make-it-work-then-make-it-right),
which fits Robert C. Martin's ub-mode to this repository.

1. **First make it work.** Reuse before you write: one decision lives in one
   place. Get the data shape right and write the failing test first. When you
   fix a failure, fix its cause; never hide it behind a retry, a longer
   timeout or a catch. Make one real path work from start to finish, access
   checks included, before the rest. Remove what you replace.
2. **Then make it right.** Before review, clean the code you added or changed
   against the table in the standard and the Style list below. Old code you
   touch must not get worse. Pin behaviour with tests before you change
   structure.
3. **Practice.** Small ordered commits. Report a short log of what you did.
   Release a dev stack you claimed; leave your worktree for review.

If two fixes that rest on the same assumption fail the same check, or a fix
fails the second review pass, stop and take that assumption to the owner.

## Style

Owner rule (4 October 2026): build only what is needed, and write it as
verbose, clear code. Be lean about scope, never about clarity. This overrides
any agent skill that prefers short code.

- Don't overbuild. Reuse existing helpers, the standard library and installed
  dependencies first. No speculative abstractions, config or scaffolding
  "for later". Remove what a change replaces.
- Write small, atomic, named functions that do one thing and can be reused.
  A reader should understand each function without scrolling.
- Avoid chaining. Give each step its own statement and a descriptive variable
  name. At most one `.map(namedFunction)` or `.filter(namedFunction)` per
  statement.
- Avoid inline definitions. Don't put arrow functions with logic, object
  builders or callbacks inside a call; define a named function or constant
  first.
- No nested ternaries; use `if`/`else` or a small named function. Keep lines
  to about 100 characters.
- Use descriptive names; no one-letter names except loop indexes.
- Comment the why: invariants, security boundaries, ordering, retries and
  what a stored state means. Don't comment what the code already says.
- Never compress code to fit on one line or to pass a lint limit. Never raise
  or switch off a size limit inside a file; split the file by responsibility,
  or ask the owner.
- Give a function at most five parameters. If it needs more, split it first.
  Pass one named object with a named, exported type only for values that
  belong together.
- Import a shared schema, digest, comparison or guard; never declare a second
  copy. Compare values by their fields, not by comparing `JSON.stringify` text.
- Keep the cause when you catch an error: log it through the structured
  logger, then return the safe message.
- One app never imports another app's source, and product source never imports
  from `scripts/`. Move shared code to a library.
- UK English throughout docs and comments.
- TypeScript strict, ESM, Node 22. NodeNext module resolution.

### Writing for people

Owner rule (5 October 2026): comments and README.md files must be easy
for a newcomer to read.

- Use everyday UK English in short sentences. Say what the code does,
  then why. In comments, start most sentences with a verb.
- Don't use shorthand we made up (seam, plane, winner, head, fence as a
  verb), noun piles, or heavy words (canonicalise, materialise,
  provenance, posture, substrate, surface as a noun).
- Keep a technical term only when it names something real in the code,
  and explain it briefly the first time, or link it to GLOSSARY.md. Never
  trade accuracy for plainness: if the plain version is less exact, make
  it longer, not vaguer.
- Don't put ticket ids, phase numbers, or decision, handoff or evidence
  codes in comments or README.md files. Say what is true now. The pull
  request, git history and README.robot.md hold the rest.
- **READMEs.** Every package has a README.md for people, with the fixed
  headings and the one small diagram set out in the
  [engineering standard](docs/process/standards.md). Put exact contracts,
  settings, limits and test detail in a README.robot.md next to it,
  ordered by topic. Before changing a package, read the parts of its
  README.robot.md that cover what you change. When a change alters what a
  package does or who it talks to, edit the sentences that are now wrong
  in both files, and the diagram. Never append a note per change: the pull
  request and the release note record what changed.

## Secrets

Never commit secrets, real API keys or credentials. A computer or service
holds only short-lived tokens; secrets live in the secret store, referenced
by id, never by value, in events or in code.

## Where to look

- [README.md](README.md) — the system map: layers, folders and one diagram.
- [GLOSSARY.md](GLOSSARY.md) — the plain meaning of the words the READMEs share.
- [plan.md](plan.md) — phases, spikes, decisions and the current plan.
- [docs/architecture/events.md](docs/architecture/events.md) — the event
  catalogue.
- [docs/adr/](docs/adr/) — architecture decision records from the spikes.

## Commits

Commit messages are one emoji and a plain sentence, with an optional short
body. Never add a co-author line or any AI attribution (no
"Co-Authored-By", no "Generated with ...") to commits or PR descriptions.
