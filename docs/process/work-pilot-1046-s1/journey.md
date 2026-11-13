# Installation organisation name journey

Journey on a fresh dev stack: PASS on attempt 2 — 2026-11-13, tested source
`d96c2a66b357c6c3ca9637f2a54fb39167688fb3`, rebased onto
`7ec65e982f543f93b5829db39486cc8ca8eecfaa`. The rebase finished.

## Reproduction and fix

The regression test was committed first in `1e272b6ce`. Before the fix,
`web-development.test.mjs` failed with a browser `securitypolicyviolation`:
`violatedDirective: frame-src`, `blockedURI: blob`.

The switched server's index response had `Content-Security-Policy` from
`infra/dev-stack/web-server.mjs`, line 80:

```text
default-src 'self'; script-src 'self';
```

There is no `frame-src` directive, so Chromium uses `default-src 'self'` for the
PDF iframe and blocks its blob URL. The earlier
[blocked viewer](pdf-viewer-failure-390.png) shows that failure.
Angular's development server sends no index CSP. The restored development path
also sends no index CSP, as checked on the fresh stack.

Secondary stacks now run Angular development serving through
`web-server.mjs --development`. The installed builder's HTML transform calls
`infra/package/web-page.mjs` with `ORGANISATION_NAME`. It retains the development
client, proxy and live updates. The static owner-server policy is unchanged.
The production build/start additions and extra heap constant were removed.
The original 768 MiB secondary web limit remains. The logout probe again requires
HTTP 303, cookie removal and no token exposure. The Docker context entry and
runtime allowlist for `web-page.mjs` remain because the packaged server imports it.

## Fresh stack attempts

Both attempts used `claim.sh`, `up.sh --fresh`, real Zitadel sign-in and the free
stand-in model. `ORGANISATION_NAME` was `Acme & Sons`. The existing setup credential
was supplied by path. `down.sh` ran after each attempt and released the slot.
No owner stack was used. The same source was tested in both attempts.

```sh
DEV_STACK_ID=$(infra/dev-stack/claim.sh) || exit 1
export DEV_STACK_ID
export ORGANISATION_NAME='Acme & Sons'
export ZITADEL_KEY_FILE='<existing setup credential path>'
trap 'nice -n 10 infra/dev-stack/down.sh' EXIT
nice -n 10 infra/dev-stack/up.sh --fresh
```

After the core result, run the browser steps below before teardown. A failed core
result remains FAIL even when the independent name or packaged checks pass.

| Attempt | Website readiness | Core journey | Name steps | Teardown |
| --- | --- | --- | --- | --- |
| 1, slot 1 | 109,297 ms | FAIL: Spending budget editor did not load | NOT RUN | PASS |
| 2, slot 1 | 64,936 ms | PASS | PASS at both widths | PASS |

Attempt 1 rendered page 1 of the promoted PDF at 390 px and 1280 px before failing
later in `loadBudgetEditor`, called by `browserBudgetJourney`. The exception was
`Spending budget editor did not load; inspect private evidence`. This failure is
already described in the dev-stack operator notes; the cause of this occurrence
was not established. No budget check, assertion, timeout or access rule was changed.
The first attempt's page-specific Spending statuses and picture were not retained
before teardown. Its exception was captured. The diagnostic wrapper for attempt 2
was set to preserve these files if the failure recurred. Attempt 2 did not reproduce
that failure: it passed all four paying-group and assistant budget cases, including
refusal after reload and unchanged reservations. No Spending cause or fix is claimed.

Attempt 2 passed the full core journey, the name steps and teardown. Both widths
rendered native PDF page 1 with zero preview retries. The expected one upload retry
per width came from the harness deliberately losing a successful upload response.
Core also passed real SSO, CSRF and expiry refusals, streamed chat, Stop, file
conversion and refusals, live view, audit, lifecycle, budgets, replay and sign-out.
The approval journey remains SKIP in the existing core harness.

## Browser evidence

At both widths, check the configured name on sign-in, the read-only Email field
and its “Disabled in this product” explanation. Sign in through real SSO. Open
`/workspace` and inspect the organisation name in navigation. Open
`/org/integrations` and inspect organisation navigation. At 390 px, open each
navigation drawer. Check for horizontal overflow and save screenshots.

| Screen | 1280 px | 390 px |
| --- | --- | --- |
| Sign-in | [Screenshot](sign-in-1280.png) | [Screenshot](sign-in-390.png) |
| Workspace navigation | [Screenshot](workspace-1280.png) | [Screenshot](workspace-390.png) |
| Organisation navigation | [Screenshot](organisation-1280.png) | [Screenshot](organisation-390.png) |
| Native PDF page 1 | [Screenshot](preview-1280.png) | [Screenshot](preview-390.png) |

Empty and whitespace names, HTML escaping and the screen-specific fallback words
PASS in component and page-function tests. A separate live unset-name restart is
NOT RUN.

## Packaged web server

PASS: `infra/package/web.mjs` does not block this native PDF preview. Its index
response has no `Content-Security-Policy`; line 51 writes only `Content-Type`.
A real signed-in member opened the promoted PDF and Chromium rendered page 1
at 1280 px and 390 px. The file API still returned
`Content-Security-Policy: default-src 'none'; sandbox` and `application/pdf`.
That original-response policy was unchanged and did not block the blob preview.
No packaged CSP defect for #15 was reproduced.

The temporary fixture changed only the asset location and loopback listen/upstream
addresses in a copy of the packaged entry point. The handler and policy logic
were unchanged. Playwright served its responses at the configured browser origin,
using the existing secondary backend and a real session. This checks the packaged
web handler, not a full Helm installation. No packaged policy was changed here.

| Packaged native preview | 1280 px | 390 px |
| --- | --- | --- |
| Page 1 rendered | [Screenshot](packaged-preview-1280.png) | [Screenshot](packaged-preview-390.png) |

## Checks

- PASS: 320 targeted Node tests twice, including dev serving, static serving,
  saved settings, startup, page escaping and chart rendering.
- PASS: the cleaned development regression test twice afterwards.
- PASS: 183 tests twice across the three changed web test files.
- PASS: typecheck, event catalogue agreement (174 event types), knip,
  changelog lint, changed-file ESLint and Markdown lint.
- PASS: local package image build and 11 image-layer tests twice (67.7 s and 72.9 s),
  including the shipped shared page module and the narrow development-file allowlist.
- NOT RUN: full root tests and full packaged-runtime installation qualification.
- PASS: public privacy and secret scans.
- CI results are recorded in the [PR checks](https://github.com/elewa-git/opencrane-new/pull/1117/checks).
