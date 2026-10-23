# Preparing the demo

For people, read [README.md](README.md) first.

## Latest qualification attempt

Attempt 3 for #569 on 23 October 2026 is **FAIL**. The pinned source was
`62c404b3a072dfe9c0e3fe838f5d4ffd3860641e`, including the checker fixes in #606 and #608.
Fresh startup and the 1280px smoke passed. The 390px smoke passed streaming and
PDF checks, then failed at Stop after its remaining time expired. A read-only visit
after the timeout showed “Reply failed” and 175 characters of partial text.
The cause remains unproved. No turn was retried and no product fix is included.

The [receipt](../demo-rehearsal/final-3-2026-10-23/receipt.md) records timings, pictures,
spending, cleanup and source checks. All twenty checks in the separate ten-step
script are NOT RUN. This attempt does not qualify an owner refresh.

The task used 26 charged cents and 51 held cents: 77 of its 1,000-cent allowance.
Both original company limits were restored to 1,000 cents. Secondary slot 1 was
removed after copying receipts. The owner stack was not used.
No application code, event contract, dependency or protected test changed.

The previous 23 October attempt for #569 is also **FAIL**. Its checker passed all ten
steps at 1280px, then reused the desktop invitation address at 390px. Fresh startup,
both timed smoke widths and phone steps 1–6 passed; steps 8–10 were NOT RUN. Its
[receipt](../demo-rehearsal/final-2026-10-23-2/receipt.md) records its evidence and cleanup.

The first final attempt remains historical evidence. Its checker failure does not
explain this attempt's Stop failure.
