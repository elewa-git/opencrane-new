# Group chat child review capture

Date: 8 November 2026. The local web build used intercepted
API replies and reduced motion. No dev stack or paid model was used.

PASS — `npm run visual:screen-p4-8-pr12a` captured the mention guidance and review
at 1280 and 390 pixels. The payer shows a checked group name, and the phone guidance
sits below the composer. The script checked visible Start, no horizontal overflow,
44 px controls, initial review focus and focus return after Cancel.

PASS — 98 focused web tests covered the source audience, payer name, assistant-list
errors and retry, and the existing child request paths. The test ran twice after the fix.
Scoped ESLint, typecheck, `check:events`, Knip, changelog lint and Markdown lint passed.

The files `guidance-1280.png`, `guidance-390.png`, `review-1280.png` and
`review-390.png` show the captured screens. Fresh-install journey: NOT RUN.
