# Company acceptance source checks

Part of #15. P5-13 PR 1 under D08/D09/D11. Overall: PARTIAL.
Live company qualification: NOT RUN. No stack, install, screen journey or model
call was started. The [checklist](checklist.md) names the inherited conditions.

Prerequisite P5-11 merged as #732 at
`f19d0db406e71e104b721849133cb0135ee7da6a`.
Earlier #514 (`0b116876f`), #641 (`105071aaa`) and #713 (`939dfcdf7`)
remain limited to their recorded scope. None completes P5-13.

The checker consumes P5-11's actual two-run binding format and reuses its
journey and freshness checks. It adds no product events, APIs, dependencies or
runtime changes. The event security test's exact RISKY_FIELD_NAME was read;
local evidence fields are never sent to events or APIs.

Native memory isolation/no-disk execution, current deleted-key restore proof,
company credentials, routines/Ask, full P3-22/Odoo/OAuth and P4-28 feature and
refusal evidence remain NOT RUN. Full live P5-11 and P5-12 remain required.
The complete synthetic fixture proves checker logic only. No qualification PASS
receipt is written. Paid work still needs the existing remaining 500-cent
allowance, working credentials and provider cap.

Source checks on 26 October 2026: PASS for lint, typecheck, `check:events`,
Knip and `lint:changelog`. The changed checker tests passed twice at 62/62 with the
requested `PG_TEST_URL`. `security-rules.test.ts` passed once at 438/438 with
the same setting. The synthetic records used by those tests are not live
company evidence. Lint reported 28 long-function warnings outside this change
and no errors.

## Linked result and install checks

Each required subcondition now needs a separately recorded result with supporting
files. The result file must match the install and width. This includes native
memory checks at each location, routine cases, screen states and inherited feature
receipts. The stub-only probe leaves every condition NOT RUN.

Rejected fresh state leaves that install's dependent conditions NOT RUN. A bad
journey binding names the mismatched field and keeps the other install's valid
results. Reused identities have a separate shared blocker, including when one
source revision is refused. Refused result files are remembered so repeated
references cannot use up the other install's file-reading allowance.

The failing tests were committed before the corresponding checker changes.
The initial run had 321 expected failures; the later screen/dependency and shared
identity cases had two expected failures. These failures reproduced missing checks.
The synthetic fixtures prove checker behaviour only. Live company qualification
remains NOT RUN. No dev stack was started or claimed.

Latest checks on 26 October 2026: PASS for typecheck and `check:events` (154 event
types). Company-qualification and journey-check passed twice at 655/655, using
`PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres`. Both runs and all
source checks used `nice -n 10`. No full root suite was run.

PASS: `npm run lint`, including Knip and `npm run lint:changelog`. Lint reported
28 long-function warnings in unchanged code and no errors. Knip reported two
configuration hints and no unused-code failures.
