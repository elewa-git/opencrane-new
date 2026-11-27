# Assistant instruction files

`soul.md` replaces Codex's base instructions. It holds the default identity and
adapted tool guidance. `persona.md` introduces the approved persona appended to it.
`LICENSE-Codex` and `NOTICE-Codex` keep the upstream licence and notice.

`agent-personal.md`, `agent-shared.md` and `agent-routine.md` supply the role.
`environment-tools.md` and `environment-private.md` describe the existing local-tool
settings. Their `{{tools}}` placeholder is replaced by admitted external tool names,
or `none`. The computer never accepts template text or a template name from a turn.

The production image makes this folder readable and unwriteable by assistant users.
Generated personas are kept separately under the bridge's protected RAM folder.
The [computer contract](../../README.robot.md#assistant-instructions) describes
selection, reload, storage and checks.
