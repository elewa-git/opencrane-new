# Journey selector qualification

The core journey runs in a claimed secondary stack. Each attempt uses
`infra/dev-stack/up.sh --fresh`; its shell exit trap runs
`infra/dev-stack/down.sh --id "$stack_id"`.

## Attempts

| Attempt | Result | Evidence |
| --- | --- | --- |
| 1 | FAIL at 390 px while closing the session panel | [Failure screenshot](core-failure.png), [console log](core-journey.log) |
| 2 | FAIL at 390 px while waiting for PDF preview status | [Failure screenshot](retry-failure.png), [console log](core-journey-retry.log) |
| 3 | FAIL at 390 px while waiting for PDF preview status | [Failure screenshot](final-failure.png), [console log](core-journey-final.log) |
| 4 | FAIL at 390 px in the live-view pixel check; upload completed | [Failure screenshot](pass-failure.png), [console log](core-journey-pass.log) |
| 5 | FAIL during the 1280 px follow-up live view | [Console log](core-journey-verified.log) |
| 6 | PARTIAL: upload passed at both widths; live view passed at 390 px and the first 1280 px view | [Failure screenshot](captured-failure.png), [exact error](captured-error.log), [console log](core-journey-captured.log) |

Attempt 1 failed because the journey expected `Close Session`, while the drawer
button is named `Back`. The locator now uses the drawer's current accessible name.

Attempt 2 timed out waiting for the preview-ready or preview-unavailable status.
Attempt 3 hit the same timeout. Both screenshots show the PDF preview displaying
`Preview ready`. The check mark is an aria-hidden SVG, so the accessible text is
exactly `Preview ready`; the status locator now uses that text.

Attempt 4 completed the 390 px upload journey, then the live-view pixel check
failed with `ReferenceError: isChangedDesktopPixel is not defined` because the
browser predicate referenced a helper outside the serialised function. The
predicate now contains its own pixel check.

Attempt 5 completed upload at both widths and live view at 390 px. At 1280 px,
the first viewer displayed pixels, but a follow-up view while the assistant
turn ran showed `Access changed` instead of `Viewing`.

Attempt 6 reproduced the same 1280 px follow-up failure. Its screenshot shows
the viewer in `Access changed`; the saved error records the exact wait for
`Viewing` that timed out.

## Viewport results

| Viewport | Upload | Live view |
| --- | --- | --- |
| 1280 px | PASS (attempt 6) | PARTIAL (first viewer and pixels passed; follow-up view showed `Access changed`) |
| 390 px | PASS (attempt 6) | PASS (attempt 6) |
