# Demo rehearsal

Status: PARTIAL. No merged owner demo commit is qualified. This does not complete #32.
The source includes every prerequisite through `06a0e47ac`, including both Stop fixes.
The final two fresh installs must use the same full source SHA.

## Limits and commands

The task limit is 1,000 euro cents, including charged cents and unresolved holds.
Each run sets both company ceilings to 500 cents. The refusal step lowers the limit
to today's spending and restores it. Nightly uses the free stand-in and clears paid settings.

`npm ci` installed this worktree. The requested NATS and lychee tools are symlinked
in `.tools/`. `claim.sh` returned slot 1. Each run uses these kit commands:

```sh
export DEV_STACK_ID=1
export ZITADEL_KEY_FILE=/home/jente/dev/opencrane-new/.keys/.zitadel-key
export DEV_REAL_PROVIDER_FILE=/home/jente/dev/opencrane-new/.keys/.openai-key
export DEMO_ALLOWANCE_CENTS=500
export COMPUTER_IDLE_MS=14400000
export P4_JOURNEY_ATTEMPT=demo-rehearsal-proof-r1
infra/dev-stack/up.sh --id 1 --fresh
node --experimental-strip-types infra/dev-stack/demo-seed-run.ts
node --experimental-strip-types infra/dev-stack/demo-smoke-run.ts
node --experimental-strip-types infra/dev-stack/demo-pages.ts
infra/dev-stack/down.sh --id 1
```

The second run uses `demo-rehearsal-proof-r2`. Only product provider setup reads the
paid file. Its value is never printed. Failed proof is copied before cleanup.

## Fresh-install results

| Check | First proof install | Second proof install |
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

## Retained failed attempts

Receipts include the full source SHA, attempt, timings, paid reservations and cents.
Startup exited 1 on each attempt; the kit seed and smoke were NOT RUN.

| Source and receipt | Failure | Charged cents | Held cents |
| --- | --- | --- | --- |
| [b3c4c4075](failed-b3c4c4075/receipt.json) | Real private reply was checked against stand-in text | 13 | 17 |
| [688be242a](failed-688be242a/receipt.json) | Second synthetic colleague's HTTP join returned 409 | 13 | 16 |
| [c96931aad](failed-c96931aad/receipt.json) | Replay restarted the server before an offline rebuild | 13 | 16 |

The three attempts total 88 cents including holds. The first two passed the real
streaming, Stop, member and PDF checks. The third also passed seven group checks,
including zero AI/computer/budget work and access clearing within two seconds.
[The first failure picture](failed-b3c4c4075/private-reply-390.png) shows the real answer.
[The group pictures](failed-c96931aad/group-messages-390.png) show ordinary messages.

## Source checks

- PASS: failing-first commits `4e7669ba7`, `4a298440b` and `d39698e9f` precede their fixes.
- PASS: 24 focused Node tests twice; 17 owner/mode refusal tests twice; changed scripts compile.
- PASS: required lint and workspace typecheck; event catalogue, Knip and changelog checks.
- PASS: 438 event-security tests with the supplied `PG_TEST_URL`.
- FAIL: an additional compiler check across every dev-stack script found existing errors in
  `mcp-journey.ts`, `wake-latency.ts` and `zitadel-setup.test.ts`, outside this change.

Checks and tests used `nice -n 10`. No full root test suite or fleet batch ran.
The owner stack, port 44200 and its data were untouched. No dependency or product event changed.
