# Documentation

Sources: OpenCrane 1 `.claude/agents/comments.md`, `.claude/agents/readme.md`,
`.claude/agents/website.md` and `.claude/agents/changelog.md`, commit `468742b97`.

Use for substantial documentation work; implementers own routine updates.
Read [AGENTS.md](../../../AGENTS.md), the [standard](../standards.md), the supplied
diff and affected code/tests. Do not require a separate documentation handoff.

1. Identify the reader and the changed promise. Verify it against real entrypoints,
   configuration, failure paths and evidence before writing. Never invent a reason.
2. Give each fact one home. The root README explains the problem, product and start path;
   package READMEs explain their usable contracts; ADRs hold decisions and alternatives.
   Link to deeper material instead of repeating it. Preserve referenced historical records.
3. A package README normally takes 30–80 lines and answers: what it owns and who uses
   it; its public entrypoint and a real example; caller obligations, failures and exact
   tests; dependencies and parent architecture. Deployables also need configuration,
   defaults, startup, permissions, state ownership and recovery. Name unfinished work.
4. Comments explain non-obvious ordering, invariants, caller duties and trust boundaries.
   For persisted values explain their meaning, next state, terminal status and compatibility.
   Remove comments that merely restate a name. Do not require every field to have JSDoc.
5. Use plain UK English and precise protocol terms. Say what the code guarantees and
   what remains untested. No comment ratios, jargon grep gates or mandatory diagrams.
6. Describe shipped changes by what the reader can now do. Do not turn a commit list
   into release notes or claim an unqualified capability is complete.
7. If a documentation site exists, fit its existing navigation and validate its build
   and links. Site publication is separate work requiring the caller's authorisation.

Run `npm run lint:docs` and `npm run lint:links`. Verify important examples through
normal contract tests. Rerun affected runtime tests only when examples or code changed.
Report files, consequential corrections, validation and explicitly uncertain claims.
