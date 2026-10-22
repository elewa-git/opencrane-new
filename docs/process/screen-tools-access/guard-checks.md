# Audience guard checks

Date: 22 October 2026. Test source: `1aab1f576` after rebasing onto `origin/main`.
Environment: local Angular tests with intercepted replies. No live install.
Every test command ran under `nice -n 10` with
`PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres`.
These browser tests do not use a database.

## Failing first

PASS: before the implementation changed, the Alex/Bea test failed on the actual
link `requester=alex&assistant=bea-helper&tool=read_item`. The other seven tests
passed. The tests were committed before the implementation.

PASS: adding mode controls to the browser measurement made the capture script
fail its 44-pixel size assertion before the CSS changed.

## Removing one guard at a time

Command: `npm test -w apps/web -- --watch=false --filter='rejects|purges' --include=src/app/tool-policy/tool-audience-guards.spec.ts`.
The command was run separately for each change below. Each run failed the named
assertion rather than failing to build. Every change was then removed.

| Guard temporarily removed | Observed test failure | Result |
| --- | --- | --- |
| Receipt schema validation | A zero sequence was accepted and the original status check was lost | PASS |
| Receipt server match | Another server's receipt was accepted | PASS |
| Receipt command id match | Another command's receipt was accepted | PASS |
| Receipt operation match | A revoke receipt confirmed a grant | PASS |
| Access sequence compared with the receipt | Sequence 4 confirmed a receipt at sequence 5 | PASS |
| Clearing saved audience rows after refusal | Private audience names remained after both 401 and 403 | PASS |
| Clearing candidate rows after refusal | The private candidate name remained after both 401 and 403 | PASS |

PASS means the test detected the removed guard. It does not mean the temporary
change was safe. All seven guards remain in the implementation.

The other missing guard tests remain follow-ups in issue #302. Fresh-install
qualification and the full local root suite were NOT RUN.

## Explanation label size

PASS: CI on `4161fbbff` rejected the new explanation labels. The existing browser
journey measured an 18-pixel inline label and expected at least 44 pixels. The
select inside it was already 44 pixels high. Commit `238c3f12f` added the labels
to the capture measurement before the layout changed. That check also failed.
The correction gives each label its own column layout. No assertion or timeout
was changed.
