# How the agent fleet works

This is how OpenCrane 2 gets built day to day. The [standards](standards.md) say what good work is; this page says who does it and in what order.

## Roles

- **Orchestrator:** one Claude Code session on the dev box (`ocn-dev`), started with Remote Control so the owner can follow and steer it from the desktop app or a phone. It writes task prompts, starts Codex runs, reads their results, lands changes and reports progress. It does not do the heavy lifting itself.
- **Builders and reviewers:** headless Codex runs started with [`tools/fleet/codex-task.sh`](../../tools/fleet/codex-task.sh). Pick the model by need:

  | Model | Use for |
  | --- | --- |
  | `gpt-6-astra` | Design, hard builds, adversarial reviews |
  | `gpt-6.1-sol` | Regular builds; reviews of astra's work, so a different model checks it |
  | `gpt-6-luna` | Mechanical edits: docs touch-ups, renames, result tables |

- **Owner:** reviews `main` each morning, answers held decisions and approves anything outside the box.

## One change, start to finish

1. **Prompt.** Write a self-contained prompt file: the outcome, the files in scope, the gates, and what the final message must report.
2. **Worktree.** Parallel builders each get their own worktree and branch with their own `npm ci`; one builder per worktree. For live journeys, claim a secondary id with `infra/dev-stack/claim.sh`, export its output as `DEV_STACK_ID`, and release it with `infra/dev-stack/down.sh` when finished. See the [parallel stack instructions](../../infra/dev-stack/README.robot.md#parallel-journeys). Only two secondary stacks may run beside the stable owner stack; if both are claimed, queue. Never take over or restart the owner stack for a feature task.
3. **Build.** Run `tools/fleet/codex-task.sh <name> <worktree> <prompt> [effort] [model]`.
4. **Review.** A different model reviews the diff using [`agents/review.md`](agents/review.md). At most two passes; if blockers remain after the second, hold the change and ask the owner.
5. **Gates.** `npm ci`, `npm run lint`, `npm run typecheck`, `npm test`, `npm run check:events`, plus the web build and tests.
6. **Secret scan.** `tools/fleet/secret-scan.sh` on the staged diff; the push happens only if it exits 0.
7. **Land.** Each whole feature stays on a development branch with a well-described PR: **Why / Functional outcome / Architecture / Evidence / Not in this PR**. Small fixes go inside their feature PR. The orchestrator merges after gates, independent review and green CI. Commits use one emoji plus a plain sentence and a short bullet body; never a co-author or AI attribution in commits or PR descriptions.
8. **Qualification ledger.** Every feature PR appends its qualification rows to [`ledger.md`](ledger.md) and quantitative measurements to [`benchmarks.jsonl`](benchmarks.jsonl). Reviewers copy measurements and verdicts into the PR's evidence receipt; they must not leave the only copy in `/tmp`.
9. **Changelog.** Every feature PR adds a line under the [Unreleased section](../../CHANGELOG.md#unreleased) describing its user-visible outcome. At each milestone, the orchestrator rolls those lines into a named section in `CHANGELOG.md`.
10. **Report.** A few lines to the owner: what landed, what is running, what needs a decision.

## What needs the owner first

- Any spend outside the dev box: cloud resources, paid model calls beyond the agreed envelope.
- Deleting resources that are not on the dev box, or changing GitHub, DNS, identity-provider or billing settings.
- Anything involving the owner's credentials. Agents never type, copy or print passwords or keys.

## The dev box

Agents have full control of `ocn-dev` (passwordless sudo). The guardrails sit around it instead:

- the Tailscale policy lets the owner's devices reach `ocn-dev`, but not the other way round;
- the GitHub token is limited to `elewa-git/opencrane-new`, without administration, webhook or secret rights;
- no cloud owner credentials live on the box;
- DigitalOcean backups are on, and the box can be rebuilt from `infra/devbox/`.
