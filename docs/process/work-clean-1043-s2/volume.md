# Stopped access clock under load

Result: **PASS, 10/10 consecutive runs**, alongside the scoped models suite.
An initial standalone run also passed. The first configuration also passed 10/10
stress runs, but its companion suite timed out in the volume test after completing
the zero-event measurements. The [failure log](models-first-failure.txt) is retained.

Stopping the event store's clock can also stop a transport retry sleep. The fixture
now accepts a separate `modelClock` option: models see the stopped clock, while real
store methods keep their own I/O clock. A regression forces one transient NATS failure, proves
that the retry recovers without advancing model time, then advances model time to
2,000 ms and checks the access refusal. No production deadline or retry changed.
The failure log cannot identify which transport operation waited; the regression
pins the stopped-clock failure mechanism.
The shared disposable PostgreSQL database, real NATS, OpenFGA and the gateway
fixture were used. Request latency still uses real monotonic time. The model
access clock stays stopped; storage I/O and retry waits use real time. Every existing latency and bounded-read assertion remains.

The corrected test uses a monotonic value one hour ahead of real time so the PostgreSQL
adapter, which is outside this migration, does not mistake the stopped access
clock's deadline for an already elapsed database deadline.

| Run | Result | Vitest duration |
| --- | --- | --- |
| 1 | PASS | 63.47s (tests 86%, transform 10%, import 3%) |
| 2 | PASS | 61.16s (tests 85%, transform 11%, import 4%) |
| 3 | PASS | 68.78s (tests 86%, transform 11%, import 4%) |
| 4 | PASS | 63.15s (tests 85%, transform 11%, import 4%) |
| 5 | PASS | 74.04s (tests 81%, transform 14%, import 4%) |
| 6 | PASS | 67.78s (tests 85%, transform 11%, import 4%) |
| 7 | PASS | 63.31s (tests 85%, transform 12%, import 4%) |
| 8 | PASS | 63.07s (tests 87%, transform 10%, import 3%) |
| 9 | PASS | 66.36s (tests 86%, transform 10%, import 4%) |
| 10 | PASS | 64.18s (tests 84%, transform 12%, import 4%) |

Commands, each under `nice -n 10`:

```sh
npm test -- libs/models/test --maxWorkers=2
npx vitest run libs/models/test/authority-volume.test.ts --maxWorkers=1
```

The second command ran ten times consecutively while the first command ran.
The [result on the issue](https://github.com/elewa-git/opencrane-new/issues/189#issuecomment-6975524731)
distinguishes this evidence from a diagnosis of the earlier intermittent refusal.
