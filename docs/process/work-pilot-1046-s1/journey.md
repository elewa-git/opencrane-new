# Installation organisation name journey

Journey on a fresh dev stack: FAIL — 2026-11-13, tested rebased head
`b3d50c90a2fb8aa5dbdd4b2fd5e3caebc748c8fe`.

## Fresh stack attempt

Claimed secondary slot `1`, set `ORGANISATION_NAME` to `Acme & Sons` before
`infra/dev-stack/up.sh --fresh`, and used the existing Zitadel credential by path.
The stack reached website readiness in 70,835 ms. Its built-in core journey then
failed again at `browserUploadJourney` in `infra/dev-stack/browser-upload.ts:111`,
called from `infra/dev-stack/journey.ts:557`:

> Native PDF viewer did not render its first page

The page had a preview iframe, but Chromium showed “This content is blocked” in
the viewer screenshot. The page screenshot was captured at 15:00 UTC; the check
then waited its full 30-second limit for page 1. This is the likely cause,
inferred from the screenshot and failed assertion. The journey harness reported
browser transport failures `net::ERR_FAILED`, `net::ERR_ABORTED`, and
`net::ERR_ABORTED`. It did not capture browser console messages for this step.
The screenshot is [pdf-viewer-failure-390.png](pdf-viewer-failure-390.png).
No product code was changed.

The organisation-name browser steps, real SSO, unavailable email sign-in refusal,
workspace and organisation navigation at 1280px and 390px, and their screenshots
are **NOT RUN** because startup stopped at the core journey failure. The six
committed screenshots below are from the earlier run at source `f4a8a655f`; they
are not evidence for the rebased head.

| Earlier screen | 1280px | 390px |
| --- | --- | --- |
| Sign-in | [Screenshot](sign-in-1280.png) | [Screenshot](sign-in-390.png) |
| Workspace navigation | [Screenshot](workspace-1280.png) | [Screenshot](workspace-390.png) |
| Organisation navigation | [Screenshot](organisation-1280.png) | [Screenshot](organisation-390.png) |

## Checks

- PASS: 181 targeted web tests across the three changed browser test files.
- PASS: 255 Node tests from the dev-stack and package test run.
- NOT RUN: `image-layers.test.py`; it requires a Docker image archive from a
  package-image build. Full root tests and full packaged-runtime qualification
  were also NOT RUN.
- PASS: `infra/dev-stack/down.sh` completed for slot `1` and released it.

The earlier run's evidence and checks remain in the PR history. This receipt
records the rebase qualification result only.
