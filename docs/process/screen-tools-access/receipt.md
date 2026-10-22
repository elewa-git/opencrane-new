# Initial tool audience

Date: 2026-10-22T09:53:17.833Z. Source: fea2fb152a85a63475a39757f46ec10cdab4255a.
Environment: built web app, intercepted APIs and a fresh browser context per case. No live install.
Command: `npm run visual:screen-tools-access`.

PASS: 28 captures at 1280/390, reduced motion, keyboard selection, focus, 44px audience buttons, explanation labels/selectors and mode controls, and no overflow.
PASS: Alex offers no assistant and no explanation link. Choosing Bea and her assistant gives the matching explanation link.
PASS: each save sends once and reads its original receipt. Content and IAM Applying both block review. Saved reads access again. Reload keeps the original status check. Conflict, no-effect, unknown, empty, outage, stale cursor and 401/403 clearing match the expected states.
[Desktop](audience-1280.png) and [phone](audience-390.png) show the saved audience.

PARTIAL: INT-31 uses existing chips and shared states. Tool rows and shell keep the earlier publication layout. The existing INT-33 page receives an explicitly chosen, checked pair. Published editing and groups are outside this part.
NOT RUN: fresh-install audience journey, live grant confirmation or gateway, model calls and local full root suite.

PASS: 45 focused web tests twice after the explanation-label correction, under
nice priority with the requested PG_TEST_URL. The [guard checks](guard-checks.md)
record the failing-first pair test and all seven separate guard-removal checks.
PASS: 28 production captures also measure the explanation labels. The original
browser journey passed unchanged with disposable PostgreSQL, NATS and OpenFGA
(1 focused test; 93 others not run locally). PostgreSQL used a private port and
was removed with its volume afterwards.
FAIL: the first two local browser-journey attempts timed out while Angular built,
before reaching the browser assertions. Building the development app populated
Angular's cache; the next attempt passed. No timeout or assertion was changed.
PASS: full lint, repository typecheck, event catalogue (149 types), Knip,
changelog and web build after the label correction. Existing build warnings remain.
The first CI head, `4161fbbff`, failed only the new inline-label height check.
The correction gives the labels their own layout; the server rule is unchanged.
