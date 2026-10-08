# First review fixes for invitation acceptance

Date: 8 October 2026. Branch: `work/p4-3-pr3`, draft PR #279, part of #85.
Base after rebase: `e82ac153`. The rebase completed and the branch contains that
main commit. One README conflict was resolved by keeping both sections.
The source is the commit that contains this receipt. Node: 22.23.3. Environment:
this Linux worktree, disposable local services; no fresh silo was installed.

## Behaviour checked

Acceptance requires a matching verified ASCII email and an actual sign-in within
60 minutes. Missing email claims and old sign-ins return `sign_in_again`.
Removed admissions return 403 `access_removed`, including a saved join replay.
A confirmed inviter removal or demotion during the final check returns 403
`inviter_authority_ended`. Other check failures stay unavailable.

The API doc records the required Zitadel settings and the accepted small window
between checking the inviter and writing the join. The write remains conditional
on the joining member stream alone. Setup checks the email-claim setting by
reading the owner and secondary apps. It makes no new provider write.
All setup tests use an isolated provider fixture. No real Zitadel request ran.

The session email limit is 320 characters. The sign-in callback refuses a complete
session cookie header above 3,800 bytes, clears both cookies and explains the error.
The browser receives a clear text error rather than another sign-in redirect.

## Failing-first and mutation proof

Before the fixes, new tests failed for missing email claims, old and future sign-in
times, Unicode emails, the email length limit and oversized session cookies.
Separate tests reproduced the removed-join replay and final inviter-check status
bugs. The Unicode invitation fixture was removed because the event schema already
rejects it before storage; the session Unicode tests exercise the acceptance bug.

The six added review guards were run together successfully before mutation.
Each temporary change below must produce its named test's assertion failure.
The source is restored after every change, including a failed probe. All six
probes were repeated after moving two checks into small named helpers to pass lint.
Each probe still failed its expected assertion, and all source changes were restored.

The first broader run found one bootstrap test using `authTime=0` for its join.
Only that invitation-acceptance step now supplies a recent sign-in. The final
runs below use this corrected fixture.

| Guard | Temporary change | Result |
| --- | --- | --- |
| (a) Expiry after final access check | Return the earlier invitation without rechecking | PASS |
| (b) Identity before state and expiry | Check pending state and expiry before the email | PASS |
| (c) No-store replies | Remove the cache header | PASS |
| (d) Inviter refusal is 403 | Remove its 403 status reason | PASS |
| (e) Missing email with verified true | Return `wrong_identity` instead of `sign_in_again` | PASS |
| (f) Inviter is an Owner | Allow only Admin inviters | PASS |

## Final checks

| Check | Result |
| --- | --- |
| Rebase completed; main is an ancestor | PASS |
| Six focused guard cases | PASS: 9 cases |
| Changed tests, first final run | PASS: 6 files, 191 tests; no skips |
| Changed tests, second final run | PASS: 6 files, 191 tests; no skips |
| Zitadel setup tests, first final run | PASS: 2 tests |
| Zitadel setup tests, second final run | PASS: 2 tests |
| `lint` | PASS: no errors; 9 function-length warnings |
| `typecheck` | PASS: all workspaces, plus server after the fixture fix |
| `check:events` | PASS: 98 event types agree |
| Knip | PASS |
| `lint:changelog` | PASS |
| Full root test suite | NOT RUN, as requested |
| Web build/tests, hosted CI and second independent review | NOT RUN |
| Real Zitadel settings and fresh-install invitation journey | NOT RUN |

Safe local command logs are in `/tmp/p4-3-pr3-round1/`. The selected tests use
real disposable NATS, PostgreSQL 17 and OpenFGA, plus a signed loopback OIDC
provider. The setup tests never reach the network. Local checks make no claim
that the full invitation capability has passed on a fresh installation.

The selected command uses `PG_TEST_URL` pointing to a database
created by the existing `databases()` test helper. The wrapper removed its
database and container after each run.

```sh
nice -n 10 npx vitest run \
  apps/server/test/member-joined.test.ts apps/server/test/auth-flow.test.ts \
  apps/server/test/bootstrap-claim.test.ts apps/server/test/ownership.test.ts \
  libs/auth/test/oidc-client.test.ts libs/auth/test/session.test.ts
nice -n 10 node --experimental-strip-types --test infra/dev-stack/zitadel-setup.test.ts
```
