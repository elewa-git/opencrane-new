# Documentation

Sources: OpenCrane 1 `.claude/agents/comments.md`, `.claude/agents/readme.md`,
`.claude/agents/website.md` and `.claude/agents/changelog.md`, commit `468742b97`.

Use for substantial documentation work; implementers own routine updates.
Read [AGENTS.md](../../../AGENTS.md), the [standard](../standards.md), the supplied
diff and affected code/tests. Do not require a separate documentation handoff.

1. Identify the reader and the changed promise. Verify it against real entrypoints,
   configuration, failure paths and evidence before writing. Never invent a reason.
2. Give each fact one home. The root README is the system map. A package README.md tells
   a newcomer what the package is, where it fits and what it does. Its README.robot.md
   holds exact contracts, settings, limits, test detail and history. ADRs hold decisions
   and alternatives. Link to deeper material instead of repeating it. Preserve referenced
   historical records.
3. Write package READMEs to the README standard: the six fixed headings, plain words, one
   diagram of at most 8 boxes checked against real imports and calls, and about 50–120
   lines. Deployables put configuration, defaults, startup, permissions, state ownership
   and recovery in README.robot.md. Name unfinished work plainly.
4. Comments explain non-obvious ordering, invariants, caller duties and trust boundaries.
   For persisted values explain their meaning, next state, terminal status and compatibility.
   Remove comments that merely restate a name. Do not require every field to have JSDoc.
5. Use plain UK English. In README.md, explain a technical word the first time or link
   GLOSSARY.md, and leave out ticket, phase, handoff and evidence codes. Write comments
   to 'Writing for people' in AGENTS.md. In README.robot.md, use precise protocol terms.
   Say what the code guarantees and what does not work yet. No comment ratios, and no
   diagrams beyond the one small README diagram.
6. Describe shipped changes by what the reader can now do. Do not turn a commit list
   into release notes or claim an unqualified capability is complete.
7. If a documentation site exists, fit its existing navigation and validate its build
   and links. Site publication is separate work requiring the caller's authorisation.

Run `npm run lint:docs` and `npm run lint:links`. Verify important examples through
normal contract tests. Rerun affected runtime tests only when examples or code changed.
Report files, consequential corrections, validation and explicitly uncertain claims.
