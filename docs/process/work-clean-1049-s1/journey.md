# Fresh CORE journey

Journey on a fresh dev stack: NOT RUN

Tested head: none. During the 20 November rework, the complete models run
failed a gateway case. The first server attempt failed a Remember receipt
assertion and was stopped within the bounded task; the complete server package
was not run twice. The [source checks](checks.md) include the assertions,
comparisons with main and passed source gates.

The CORE journey starts only after those package gates pass. The gate order was
retained, so no secondary slot was claimed and `up.sh --fresh` was not run.
Read-only checks of both slots and package stacks ran every 30 seconds alongside
the one-minute load check. The final observations did not satisfy five continuous
minutes below load 6. No eligibility result was treated as permission to skip
the package gates.

There are no browser steps at 1280 or 390 px and no screenshots to report.
No stack needed teardown. The fresh journey remains required before merge.
