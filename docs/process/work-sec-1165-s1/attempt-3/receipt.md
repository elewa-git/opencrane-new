# Third fresh-stack attempt

Journey: FAIL at startup. CORE: NOT RUN. Supplemental live checks: NOT RUN.
Teardown: PASS. Slot status after teardown: both secondary slots free.

Source: `12443a0e2`. Both secondary slots reported free, no package stack was up,
and every 30-second sample across the five-minute admission window had a 1-minute
load below 6. Claimed secondary slot 1.

Ran `infra/dev-stack/up.sh --fresh` as requested. It exited 1 before starting a
stack because the command defaulted to the owner stack while `OPENCRANE_FLEET_TASK`
was set. The sanitised startup diagnostic was: `Owner commands require --owner-run,
interactive stdin and no fleet task`. No provider, services or browser journey
started. This failed startup invocation was not retried.

Copied the sanitised startup log before teardown. No service logs or screenshots were
produced because stack preparation did not start. `infra/dev-stack/down.sh --id 1`
exited 0. `status.sh --id 1` and `status.sh --id 2` both reported `free`; no package
stack was running.

- [Sanitised startup log](startup.log)
- Service logs: none; stack preparation did not start.
- Screenshots: none; CORE did not start.
