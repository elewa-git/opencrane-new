# tools/fleet for agents

For people, read [README.md](README.md) first.

## Model choice

`codex-task.sh` uses `gpt-6.1-sol` with high reasoning effort by default. Use it for
regular coding work and reviews. Pass `gpt-6-luna` for mechanical edits. The fourth
argument sets reasoning effort (`low`, `medium` or `high`); the fifth sets the model.

## Running Codex

The owner chose to run Codex without its own sandbox on the disposable developer box.
The script passes `--dangerously-bypass-approvals-and-sandbox`, so Codex has full control
of that machine. Do not use this setup on a machine that holds personal or production data.

## Owner command refusal

The launcher exports `OPENCRANE_FLEET_TASK`. If it is absent, the task name becomes
its value; an existing value, including an empty one, is preserved. Owner-only
startup and demo seed commands refuse the presence of this variable, even with
TTY stdin. The [recording test](../../infra/dev-stack/fleet-task.test.ts) replaces
Codex with a disposable shell script.

## Saved files

The default output folder is `~/.fleet/<name>/`. Set `FLEET_LOGS` to choose another root.
The script saves:

- `events.jsonl`: Codex's event log.
- `stderr.log`: error output.
- `last.md`: Codex's final reply.
- `exit`: the task's exit code.
