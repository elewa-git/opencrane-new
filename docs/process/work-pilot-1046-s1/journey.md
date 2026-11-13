# Installation organisation name journey

Journey on a fresh dev stack: FAIL — 2026-11-13, tested head
`7e020af8bb8590c599149cdc4081dbe5d679fdf8`.

## Fresh stack attempt

Claimed secondary slot `1`, set `ORGANISATION_NAME` to `Acme & Sons` before
`infra/dev-stack/up.sh --fresh`, and used the existing Zitadel credential by path.
The stack reached website readiness and then its built-in core journey failed at
`browserUploadJourney` in `infra/dev-stack/browser-upload.ts:111`, called from
`infra/dev-stack/journey.ts:557`:

> Native PDF viewer did not render its first page

The preview iframe was present, but Chromium did not expose page 1 in its native
PDF viewer within the 30-second check. This is the likely cause, inferred from
the failed assertion. No product code was changed.

The organisation-name browser steps, real SSO, the unavailable email sign-in
refusal, workspace and organisation navigation at 1280px and 390px, and their
screenshots are **NOT RUN** because startup stopped at the core journey failure.
No screenshots were captured for this attempt. The six screenshots below are
retained from the earlier run at source `f4a8a655f`; they are not evidence for
the rebased head.

| Earlier screen | 1280px | 390px |
| --- | --- | --- |
| Sign-in | [Screenshot](sign-in-1280.png) | [Screenshot](sign-in-390.png) |
| Workspace navigation | [Screenshot](workspace-1280.png) | [Screenshot](workspace-390.png) |
| Organisation navigation | [Screenshot](organisation-1280.png) | [Screenshot](organisation-390.png) |

## Checks

- PASS: 260 changed Node tests across the dev-stack and package tests.
- PASS: 181 changed web component tests in three files.
- NOT RUN: `image-layers.test.py`; it requires a Docker image archive from a
  package-image build. Full root tests and full packaged-runtime qualification
  were also NOT RUN.
- PASS: `infra/dev-stack/down.sh` completed for slot `1` and released it.

The earlier run's evidence and checks remain in the PR history. This receipt
records the rebase qualification result only.
