# Fourth attempt — admission

Journey: FAIL before claim. CORE: NOT RUN. Supplemental live checks: NOT RUN.
Teardown: NOT RUN; this attempt claimed no slot and started no stack.

Source: `ca1c14048`. At the start of the five-minute admission window, both
secondary slots reported free, no `package-*` stack was running, and the
1-minute load was below 6. Samples every 30 seconds continued to report load
below 6 and both slots free. At 08:56:29 UTC, the combined status command stopped
reporting slot results. A bounded status check for slot 1 timed out after 25
seconds. Docker showed a different task starting a secondary stack and holding
the slot 1 lock. The slot was therefore no longer confirmed free, so this
journey did not claim a slot or start a stack.

The full five-minute window had elapsed, but admission failed because the
secondary-slot-free condition was no longer true. No startup logs, service logs,
or screenshots were produced by this attempt. No dev-stack teardown command was
run because this attempt owned no stack.
