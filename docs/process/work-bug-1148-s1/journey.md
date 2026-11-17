# Long-conversation decisions: review-fix qualification

Journey on a fresh dev stack: FAIL

Date: 17 November 2026 UTC. Branch: `work/bug-1148-s1`.
The PR remains a draft. Finding 4 and the failing decision-cost gate block completion.
The earlier CORE receipt and chat pictures do not qualify these review fixes.

## Fresh stack and browser steps

Claimed secondary slot 1 through `infra/dev-stack/claim.sh`. Used the launchers:

```sh
stack_id=$(infra/dev-stack/claim.sh) || exit 1
export DEV_STACK_ID="$stack_id"
export APPROVAL_JOURNEY_ONLY=1
# Point ZITADEL_KEY_FILE at the approved local PAT file, by path only.
infra/dev-stack/up.sh --fresh
infra/dev-stack/status.sh
# The fresh startup invokes the focused browser driver.
infra/dev-stack/down.sh
```

The final attempt used source head `8a0176de073e786a0b0f36fa05294dc7394fb296`.
Later source changes preserve conversation validation errors before index insertion;
that later source has not passed a fresh browser journey.
The startup reached the website and completed common sign-in and membership checks.
The driver seeded one valid encrypted chat with 3,000 earlier messages, in batches
of 50, waiting for the conversation projection between batches. It configured the
timed tool review after seeding, without extending its expiry.

At 390 × 844, the first tool request returned HTTP 404 instead of the expected
HTTP 403 Ask response. No approval existed, no decision-service request was seen,
and the recording tool received zero calls. The driver stopped at that assertion.
Approving a call, seeing it run, single use and refusing a denied call are NOT RUN.
The 1280 × 900 steps are NOT RUN. CORE on the final source is NOT RUN.

Used the existing stand-in model setup, scripted active turns and recording MCP
tool through the real gateway. Paid model calls: zero. A real model provider would
not supply the missing tool route.

The helper still emits the old `mcp.server_published` payload. The running product
requires the current publication command, a matching reviewed revision and an
acknowledged dynamic route. Its remote watcher also requires the guarded TLS fixture
transport; the helper currently advertises a loopback HTTP endpoint. The policy read
reported `published: false`. The smallest remaining fix is to reuse the existing
Stage B TLS fixture with the current publication flow, then repeat the complete
fresh journey at both widths. No publication or network guard was weakened.

Saved sanitised startup, host-service and owned-container logs, plus the failure
capture and text, into the private rework receipt folder before teardown. Ran
`infra/dev-stack/down.sh`; it exited zero. A later status check reported slot 1
`free`. The owner stack was not used. No live PASS is claimed.

## Own source checks

Every test, lint, typecheck and build command ran under `nice -n 10`. Tests used the supplied disposable
PostgreSQL database and normal NATS, OpenFGA and gateway fixtures.

| Check | Result | Evidence |
| --- | --- | --- |
| New index, creation and catch-up cases | PASS twice | Six files, 27 tests in each run; 205.12 s and 261.02 s. |
| Added prepared-history and validation-order cases | PASS twice | Two focused files, 12 tests per run. |
| Final completeness proof cases | PASS twice | All nine replay tests passed twice after adding unique-position and first-position guard probes. Both removals failed their isolated tests first. |
| Unchanged activity and participation assertions | PASS | Five activity and four participation cases, plus seven replay cases: 16 passed. |
| Guard removal | PASS | Each touched guard failed its focused test when removed; normal source restored. See [fix details](rework1.md#guard-removal-evidence). |
| Final affected groups | PASS twice | Four files, 16 tests in each run: approval history, decision measurements, activity and participation. |
| Unchanged decision-cost suite | FAIL | Final run: 27 passed, one failed. The 3,000-message and cold catch-up cases passed unchanged. The many-models cache case returned HTTP 503 where it requires 200. An earlier 28-test PASS does not replace this result. |
| Typecheck | PASS | Full workspace, package and dev-stack checks on the final product source. |
| Scoped ESLint, events, Knip, changelog and reads | PASS | Zero ESLint warnings in its configured changed-file scope; 174 event types; two existing Knip hints; 308 known whole-stream reads and five rebuild reads. Dev-stack files use their dedicated typecheck and are outside repository ESLint scope. |
| Markdown | PASS | Repository run with no file arguments; zero issues. Rechecked after receipt changes. |
| Public privacy and secret scan | PASS | Both required scans passed; repeated before the push. |

Made right: reused the existing summary and read baseline, split catch-up and
conversation application into named functions, and removed the moved fallback from
the invalidation helper. The shipped-code and baseline diff is 834 changed lines
(681 added, 153 deleted); moving the existing conversation application body counts
in that total. No file or function limit was raised.

No pre-existing assertion, access check, money check or memory check was loosened.
No dependency, event type, API field, product retry, timeout or size limit was
added or increased.

A diagnostic repeat of the isolated many-models case, with structured warning logging and unchanged assertions and deadlines, passed. It did not reproduce or
explain the full-suite HTTP 503. The full-suite gate remains FAIL. Five selected
approval requester, payer and single-use cases also passed; the other 75 were
not selected in that run.

The full root suite, real-provider qualification and second independent
review are NOT RUN. Hosted CI is not claimed here.

## Earlier fresh attempts

| Attempt | Result | Cause and retained evidence |
| --- | --- | --- |
| 1 | FAIL | Worktree had no local key directory. Selected the approved PAT by path. |
| 2 | FAIL | CORE caret assertion stopped before approval. Host logs retained; container stdout was not copied before teardown. Evidence is PARTIAL. |
| 3 | FAIL | Driver used the wrong conversation-key directory. Corrected the fixture setting. |
| 4 | FAIL | Bulk seed left the projection behind. Added bounded seed batches and readiness checks, keeping the existing timeout. |
| 5 | PARTIAL | Interrupted to share one seeded chat across widths. |
| 6 | PARTIAL | Interrupted to move timed review after history preparation. |
| 7 | PARTIAL | Interrupted to select the focused approval driver with shared cleanup. |
| 8 | FAIL | Seed completed; gateway returned 404 before approval at 390 px. Host and container logs retained before teardown. |

Each claimed stack was stopped through its launcher. Remaining work stays in this
PR. The worktree remains available for review. Work stopped before the owner's
7.5-hour reporting threshold; live qualification is incomplete.
