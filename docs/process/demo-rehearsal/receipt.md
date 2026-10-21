# Demo rehearsal

Status: NOT RUN. This work does not complete #32 or provide an owner demo commit yet.

## Source and limits

The source includes all prerequisite merges through `06a0e47ac`, including the
Stop closure and display fixes. Both fresh installs must use one full source SHA.
The owner stack, its port 44200 and its data are outside these checks.

The task allowance is 1,000 euro cents including charges and unresolved holds.
Each fresh install has a separate 500-cent allowance. Startup and smoke both set
the company daily and monthly ceilings to 500 cents. The refusal step lowers the
company limit to today's spending and restores the saved limits afterwards.
Nightly checks use the free model stand-in and discard inherited paid settings.

## Commands

`npm ci` installed this worktree's packages. Its `.tools/nats-server` and
`.tools/lychee` link to the requested tools in the main checkout.
`infra/dev-stack/claim.sh` returned slot 1 for this worktree.

For each run, the following commands use a different attempt name. Only the
product provider setup reads the paid file; its value is never printed.

```sh
export DEV_STACK_ID=1
export ZITADEL_KEY_FILE=/home/jente/dev/opencrane-new/.keys/.zitadel-key
export DEV_REAL_PROVIDER_FILE=/home/jente/dev/opencrane-new/.keys/.openai-key
export DEMO_ALLOWANCE_CENTS=500
export P4_JOURNEY_ATTEMPT=demo-rehearsal-r1
export COMPUTER_IDLE_MS=14400000
infra/dev-stack/up.sh --id 1 --fresh
node --experimental-strip-types infra/dev-stack/demo-seed-run.ts
node --experimental-strip-types infra/dev-stack/demo-smoke-run.ts
node --experimental-strip-types infra/dev-stack/demo-pages.ts
infra/dev-stack/down.sh --id 1
```

The second fresh run uses `demo-rehearsal-r2`. The seed command is reused from the kit
and is repeated safely by the smoke command. A failed startup remains failed;
continuing checks cannot turn its result into PASS.

## Fresh-install results

| Check | First fresh install | Second fresh install |
| --- | --- | --- |
| Fresh startup and kit seed | NOT RUN | NOT RUN |
| Streamed reply and reload | NOT RUN | NOT RUN |
| Scanned supplier PDF total/date, preview and download | NOT RUN | NOT RUN |
| Action history | NOT RUN | NOT RUN |
| Stop and partial reply after reload | NOT RUN | NOT RUN |
| Member messages owner live at 390px | NOT RUN | NOT RUN |
| Private shared-assistant reply | NOT RUN | NOT RUN |
| Group and unopened invitation link | NOT RUN | NOT RUN |
| Model answered with key hidden | NOT RUN | NOT RUN |
| Company ceiling refusal and restored limits | NOT RUN | NOT RUN |
| Change history for limits and groups | NOT RUN | NOT RUN |
| Group messages with zero AI/computer/budget activity | NOT RUN | NOT RUN |

Owner refresh, physical-phone access, laptop tunnel and Safari: NOT RUN.
A 390px Chromium window does not prove a physical phone or Safari.

## Source checks

Failing-first commits: `4e7669ba7` and `4a298440b`. The first reproduces missing
nightly attempts, missing retained receipts and invalid cleanup. The second
reproduces an incomplete group journey returning successfully.

- PASS: 23 focused Node tests, twice, under `nice -n 10`.
- PASS: event catalogue, Knip and changelog checks.
- PASS: 438 event-security tests with the supplied `PG_TEST_URL`, under `nice -n 10`.
- PASS: changed dev-stack files compile with a temporary narrowed TypeScript config.
- PASS: required workspace typecheck.
- NOT RUN to completion: required lint is still running.
- FAIL: an additional compiler check across every dev-stack script found existing
  errors in `mcp-journey.ts`, `wake-latency.ts` and `zitadel-setup.test.ts`.
  They are outside this change. No full root test suite or fleet batch ran.
