# Saved call status screens

Date: 2026-10-20. Source: 32e6690c106f262fe48439a3f21ac60d90bc1f1a plus working changes.

Environment: local Chromium with intercepted API replies; not a fresh installation. Command: `npm run visual:screen-p3-14-calls`. Expected and observed: saved status reads preserve the reason, wrap references and keep focus.

PASS: Reduced-motion browser fixtures at 1280px and 390px. The reason stays visible; long references wrap and cards fit the screen. Check status uses the original turn GET, keeps keyboard focus and has a 44px target with a 2px focus ring. A failed check keeps the last status; participants see no amounts.

NOT RUN: Fresh-install live journey. No stack or model call was used.

Captures: WRK-43-1280.png, participant-1280.png, changed-status-1280.png, unavailable-1280.png, WRK-43-390.png, participant-390.png, changed-status-390.png, unavailable-390.png.

## Status announcements and access checks

Date: 2026-10-23. Source: ca179cc35 plus documentation changes. Base: 55fae525d.
Environment: local Angular/jsdom tests and Chromium with intercepted API replies;
not a fresh installation. No live stack or model call was used.

PASS: The announcement regression failed for the missing polite status region before
its implementation. Test commit 481b96c57 precedes implementation commit fe3c8945f.

PASS: The component and workspace suites passed twice, 124 tests each time:

```sh
PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres \
  NG_BUILD_MAX_WORKERS=1 VITEST_MAX_WORKERS=1 \
  nice -n 10 npm test -w apps/web -- --watch=false \
  --include=src/app/chat/budget-stop-notice.spec.ts \
  --include=src/app/chat/workspace.spec.ts
```

PASS: Removing 17 checks individually produced assertion failures. These cover immediate
clearing, both access-related template conditions, read versions, conversation and turn
identity, denial, destruction, pending replacement reads, retry restrictions, missing ids
and money display. The access-loss retry test initially missed its removed check because
the old button no longer had a handler. Calling the action after refusal made that test
fail when its check was removed. Every restoration returned all 53 component tests to green.

PASS: Full lint, including knip, links, licence checks and changelog validation;
full workspace typecheck; event catalogue agreement; and the production web build.
All lint, typecheck, build and test commands used `nice -n 10`.

PASS: An intercepted Chromium probe kept the same polite status region through
checking, changed calls, failure and access loss. Keyboard focus stayed on Check status
while it remained available. Access loss cleared calls and removed the action. The probe
used four GETs and sent no commands. Command: `nice -n 10 node /tmp/screen-p3-14-calls-browser.mjs`.
Local log: `/tmp/screen-p3-14-calls-browser-rebased.log`.

NOT RUN in this round: the full root suite, server revocation timing tests, a fresh-install
live journey or new PNG captures. The earlier captures above remain dated evidence.
