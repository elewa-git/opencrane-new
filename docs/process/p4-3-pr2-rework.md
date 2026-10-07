# Invitation email checks and directory removal

Date: 7 October 2026. Branch: `work/p4-3-pr2`.
Base: `1da32468`. Rebased source before rework: `353d3f29`.
The rebase onto `origin/main` completed. This receipt covers the reworked source
in this branch and checks run by its builder.

## Zitadel cleanup

The cleanup ran against the existing development organisation, not a fresh install.
The service credential was supplied by file path. No credential value or provider
response is saved here. Cleanup statuses are:

| Slot | Organisation check | Directory membership absent | Machine keys absent | Machine user absent | Local key files absent |
| --- | --- | --- | --- | --- | --- |
| 2 | PASS | PASS | PASS | PASS | PASS |
| 1 | PASS | PASS | PASS | PASS | PASS |

The first slot 2 run reached deletion but could not finish its checks because
Zitadel omitted a zero key count. After handling that response, the retry confirmed
removal and deleted the local files. The corrected provider fixture covers this case.
The cleanup used only the selected directory usernames in OpenCrane 2 Dev.
It did not access another organisation, the owner's user, the owner app or
instance settings.

The earlier 403 probe did not establish whether its organisation id existed.
Organisation isolation by that probe: NOT RUN. The directory key has now been removed.

## Source checks

All lint, typecheck and test commands use `nice -n 10`.
The focused members runs used a throwaway PostgreSQL 17.6 database with
`PG_TEST_URL`; NATS and OpenFGA were normal isolated test fixtures.
The throwaway database and its volume were removed after the tests.
Initial lint: FAIL on an asynchronous test generator without an `await`.
The generator now reads asynchronously; final lint: PASS, with existing warnings.

| Check | Result |
| --- | --- |
| Rebase completed | PASS |
| Zitadel setup and cleanup tests | PASS |
| Final lint | PASS |
| Workspace and dev-stack typechecks, then final server typecheck | PASS |
| Event catalogue | PASS |
| Focused members and protocol tests (109) | PASS |
| Repeated invitation/admission tests (25) and setup/cleanup tests (4) | PASS |
| Repeated join/socket timing tests (59) | PASS |
| Full root suite, as instructed | NOT RUN |
| Fresh-install invitation creation and acceptance journey | NOT RUN |

Invitation creation and acceptance changes are outside this PR. The existing
identity-bound join command remains unchanged. The email route only validates
Admin input and says the person is confirmed when they accept. The admission-id
helper remains for acceptance work and is tested directly.
