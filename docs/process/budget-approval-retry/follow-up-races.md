# Follow-up approval races

Own checks on 25 October 2026. Implementation `0c0b02438`; final test helpers
`f4c675f81`. The later production edits only expand braces and wrap an import.
After rebasing onto `e063b98f1`, the equivalent implementation and test commits are
`cda88344d` and `5d05f7b92`. A later test-helper fix matches early refusals by their
own response id; the race assertions and production behaviour are unchanged.
The run uses real time and 60 fresh gateway/event-store fixtures, with separate
OpenFGA stores. One OpenFGA fixture service serves the file. PostgreSQL uses the
supplied test service at port 55432. No owner stack or real model is used.

**PASS: 60/60 races.** Each has exactly one HTTP 200, one HTTP 403, one upstream
send, two consent uses including the unsent attempt, one budget admission, no
money held or settled, and no later send. Both calls read the restored approval
before either can consume it. The refused response and its saved decision both
report `approval_outcome_unknown`. All assertions are in the test file.

Times below include setup, refusal, restoration, both competing calls and checks.
They are not request latency measurements.

| Run | Saved-start refusal | Budget-admission refusal |
| --- | --- | --- |
| 1 | PASS (16.74 s) | PASS (12.05 s) |
| 2 | PASS (11.81 s) | PASS (11.28 s) |
| 3 | PASS (16.05 s) | PASS (12.26 s) |
| 4 | PASS (13.94 s) | PASS (11.90 s) |
| 5 | PASS (12.11 s) | PASS (12.01 s) |
| 6 | PASS (11.01 s) | PASS (9.81 s) |
| 7 | PASS (13.53 s) | PASS (12.35 s) |
| 8 | PASS (16.04 s) | PASS (12.82 s) |
| 9 | PASS (12.83 s) | PASS (18.06 s) |
| 10 | PASS (18.08 s) | PASS (19.50 s) |
| 11 | PASS (20.69 s) | PASS (16.38 s) |
| 12 | PASS (23.28 s) | PASS (13.79 s) |
| 13 | PASS (15.62 s) | PASS (15.80 s) |
| 14 | PASS (16.07 s) | PASS (12.27 s) |
| 15 | PASS (15.14 s) | PASS (12.96 s) |
| 16 | PASS (14.97 s) | PASS (11.58 s) |
| 17 | PASS (14.19 s) | PASS (15.73 s) |
| 18 | PASS (14.24 s) | PASS (11.42 s) |
| 19 | PASS (12.16 s) | PASS (12.12 s) |
| 20 | PASS (12.76 s) | PASS (10.51 s) |
| 21 | PASS (14.40 s) | PASS (11.34 s) |
| 22 | PASS (14.16 s) | PASS (12.48 s) |
| 23 | PASS (14.20 s) | PASS (10.98 s) |
| 24 | PASS (11.85 s) | PASS (9.85 s) |
| 25 | PASS (11.71 s) | PASS (10.95 s) |
| 26 | PASS (10.79 s) | PASS (8.70 s) |
| 27 | PASS (11.29 s) | PASS (10.19 s) |
| 28 | PASS (10.04 s) | PASS (7.69 s) |
| 29 | PASS (9.25 s) | PASS (7.03 s) |
| 30 | PASS (9.08 s) | PASS (9.22 s) |

## Command and repetition

The temporary Vitest configuration repeats the existing two real-clock cases
30 times. It changes only their registration to add the run number. The test
functions and production modules are unchanged.

```sh
PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres \
  nice -n 10 npx vitest run --config /tmp/budget-approval-fix/load.config.mjs \
  apps/server/test/integration-access-gateway.test.ts \
  -t 'restores one approval retry' --maxWorkers=1 --fsModuleCache \
  --reporter=verbose --reporter=json \
  --outputFile.json=/tmp/budget-approval-fix/load-real.json
```

Raw local output: `/tmp/budget-approval-fix/load-real.log` and `load-real.json`.
The separate controlled-clock reproduction and the earlier failed mixed-clock
probe are described in [the diagnosis](diagnosis.md). These are source checks.
Fresh-install qualification: **NOT RUN**.
