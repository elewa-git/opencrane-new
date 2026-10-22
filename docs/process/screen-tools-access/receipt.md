# Initial tool audience

Date: 2026-10-22T09:09:38.393Z. Source: 7e2244acff3867528b44e73dc21b3b3759606659.
Environment: built web app, intercepted APIs and a fresh browser context per case. No live install.
Command: `npm run visual:screen-tools-access`.

PASS: 28 captures at 1280/390, reduced motion, keyboard selection, focus, 44px audience buttons, explanation selectors and mode controls, and no overflow.
PASS: Alex offers no assistant and no explanation link. Choosing Bea and her assistant gives the matching explanation link.
PASS: each save sends once and reads its original receipt. Content and IAM Applying both block review. Saved reads access again. Reload keeps the original status check. Conflict, no-effect, unknown, empty, outage, stale cursor and 401/403 clearing match the expected states.
[Desktop](audience-1280.png) and [phone](audience-390.png) show the saved audience.

PARTIAL: INT-31 uses existing chips and shared states. Tool rows and shell keep the earlier publication layout. The existing INT-33 page receives an explicitly chosen, checked pair. Published editing and groups are outside this part.
NOT RUN: fresh-install audience journey, live grant confirmation or gateway, model calls and local full root suite.

PASS: 45 focused web tests twice on the final implementation, under nice priority
with the requested PG_TEST_URL. The tests cover the Alex/Bea pair and the requested
receipt, refusal-clearing and stale-sequence guards. [Guard checks](guard-checks.md)
record the failing-first result and all seven separate guard-removal checks.
PASS: full lint, repository typecheck, event catalogue (149 types), Knip, changelog
and web build. No lint limit, server access rule or existing assertion was relaxed.
The build reported existing style-budget and CommonJS warnings.
