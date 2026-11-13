# Concurrent personal tool accounts

Date: 13 November 2026.
Application source: `e3bca0e3771811e1d062ad1f3b7e4486ae78badb`.
Journey on a fresh dev stack: FAIL.

The capability is not qualified for merge. The latest test gate and live journey
both FAIL. The final fresh-stack turns did not return either account's tool result.

## Fresh environment

Claimed secondary slot 1 through `infra/dev-stack/claim.sh`, kept the fleet and
ownership guards enabled, and ran `infra/dev-stack/up.sh --fresh` followed by
`infra/dev-stack/status.sh`. Startup qualification and health checks passed.
The bundled approval journey was skipped by its existing runner: NOT RUN,
outside this slice. Used the supplied setup credential by path only.

Used real sign-in, separate browser contexts, the actual product controls and
the actual demo server in credential-checked mode. Two distinct private synthetic
keys were configured with permission. B's synthetic membership was prepared
through events with personal-assistant provisioning. The guarded local TLS
launcher ran the real server and models processes. The free model called offered
tools and read their results; browser API responses were not replaced.

## Observed steps on the final source

| Step | 1280 px | 390 px |
| --- | --- | --- |
| Admin reviews personal keys and `who_am_i` | PASS | PASS |
| Original publication confirmed ready | PASS | PASS |
| A enters, verifies and explicitly selects their own key | PASS | NOT RUN |
| B enters, verifies and explicitly selects their own key | PASS | NOT RUN |
| Each personal assistant completes its plain warm-up turn | PASS | NOT RUN |
| Simultaneous turns return their own `actedAs` accounts | FAIL | NOT RUN |
| B revokes, B's next call refuses within one minute, A still works | NOT RUN | NOT RUN |

1. Installed the demo through the admin UI, reviewed the read and identity tools,
   granted both people and assistants access, and published personal-key use.
2. The auxiliary integration-list read returned 503 while discovery was pending.
   Continued the original discovery through Check status. The collector also
   waited on a pending publication screen; reading the original publication's
   status confirmed it ready. Neither registration nor publication was repeated.
3. At 1280 px, each member entered their own key in My tools, verified the named
   account and chose Use this key. Secret inputs were empty before screenshots.
4. Both members completed plain turns through their own personal assistants.
5. Submitted both `STAGE_B_READ` turns together. Both completed with
   “The demo tool did not return a quote.” Neither showed `actedAs`.
6. Read the saved events. Both own-assistant turns started and completed, but
   neither produced an MCP decision, dispatch admission or credential release.
   The result therefore does not test the final credential-release fix live.
7. Stopped before revocation and the 390 px concurrent journey. Their unobserved
   conditions are NOT RUN, not passes.

See [failure metadata](run/failure.json), [sanitised turn events](run/turn-diagnosis.jsonl)
and [catalogue metadata](run/catalogue-at-failure.json).

The catalogue read showed top-level `checkedAt` 19:10:34 and `expiresAt` 19:15:34,
but the embedded discovery record retained 19:05:59 and 19:10:59. Concurrent turns
started at 19:10:57 and 19:10:59. This mismatch is a possible lead; its role in the
failure is not proved. Do not treat a later catalogue read as evidence that the
failed calls succeeded.

## Screenshots

Masked email text and checked secret inputs were empty before capture. Captured
screens fit their viewport without horizontal scrolling.

| Screen | 1280 px | 390 px |
| --- | --- | --- |
| Review | [Review](run/review-1280.png) | [Review](run/review-390.png) |
| Publication ready | [Ready](run/published-1280.png) | [Ready](run/published-390.png) |
| A's verified own key | [A connected](run/a-connected-1280.png) | NOT RUN |
| B's verified own key | [B connected](run/b-connected-1280.png) | NOT RUN |
| A's unsuccessful concurrent call | [A result](run/failure-0-1280.png) | NOT RUN |
| B's unsuccessful concurrent call | [B result](run/failure-1-1280.png) | NOT RUN |

## Earlier attempt and source correction

The [first fresh attempt](attempt-1/journey.md), on the earlier source, passed the
1280 px concurrency and revocation steps. B's next call was refused in 8,328 ms,
and A still worked. At 390 px, B's release exceeded the two-second access window.
That overall attempt failed; it does not qualify the final source.

Observed a failing concurrent dispatch test before changing the release path.
Replaced an initial additive clock simulation with delayed real receipt replies
so parallel checks share elapsed time. Caching only inside the broker was
insufficient: repeated receipt work also exhausted budget admission. Moved the
scope to the existing HTTP dispatch entry point. Only positive immutable
projection receipts are reused within one request. Current permissions, stream
positions, private-key checks and both original time limits remain enforced.

The assumption taken to the owner is: reusing confirmed projection receipts within
one dispatch is enough for concurrent requests to finish inside the existing
two-second access window. The broker-only approach failed its latency check. The
HTTP-dispatch approach initially passed focused tests and the 527-test batch, but
failed the same latency check on the final repeat. Stopped under the two-fix rule.
No deadline was extended, and no further product fix or test retry was attempted.

## Own checks

- PASS: failing-first demo test observed on `9fa8acb37`; its schema had rejected
  a permitted second account. The shared account schema permits independent flags
  and retains the existing refused-account fixture.
- FAIL: final receipt-work repeat returned HTTP 403 instead of 200. After naming
  the test spies, the first repeat passed all three cases; the second passed two
  and failed the concurrency latency case. This is the latest test verdict. See
  [repeat metadata](run/final-test-repeat.json). No product code changed in that cleanup.
- PASS: the earlier 527-test regression run in 13 files, with real
  disposable NATS, PostgreSQL, OpenFGA, gateway and HTTPS fixtures. That run
  included standalone authority, 100,000 unrelated events, outages and precedence.
- PASS: earlier complete affected run, 500 tests in eight files. An intermediate
  run had passed 494 and failed six replay/TLS fixture cases. Reused a direct Node
  replay helper with the unchanged ten-second limit, and held the hostname test's
  clock so it reached certificate verification. The seven targeted cases and the
  subsequent complete runs passed. Expiry tests retain separate timing checks.
- PASS: seven deliberate guard breaks were caught: foreign account material,
  foreign request body, 60-second lease, ignored late revocation, disabled TLS
  verification, ignored permission outage and cross-request receipt reuse.
  Restored each rule before the passing checks.
- PASS: workspace, package and dev-stack typechecks; event catalogue, 174 types;
  Knip; changelog lint; changed-file ESLint; Markdown lint. Knip retains two
  existing configuration hints. ESLint retains two existing size warnings in
  untouched `startDecision` functions; added and edited functions have none.
- PASS: 1,564 web tests in 82 files and the production build, with its existing
  size and CommonJS warnings. No full root test suite ran. Tests, typechecking,
  lint and builds ran under `nice -n 10`.
- PASS: public privacy and full-range secret scans before push.
- NOT RUN live: final-source revocation, rotation, admin disable, lease attacks,
  paid/external models, public third-party servers, company-account turns or
  per-assistant consent controls. Automated coverage is not a live verdict.

## Made right

Shared the demo account schema, demo HTTP requests, selection events and refresh
fixtures. Named the new receipt and permission test spies and their return values. Removed their replaced copies. Split rotation setup from its refusal
case and checked the new generation is valid. Reused the existing receipt reader
and a small request wrapper; retained the original unavailable-service cause.
Removed duplicate attachment-button sizing. Added or edited production functions
have at most 15 counted lines and three parameters. No size limit was raised.
Shipped-code diff: 47 lines, 37 added and ten removed.

## Cleanup

Closed browser contexts, stopped the guarded demo launcher and ran
`infra/dev-stack/down.sh` for the claimed slot after each attempt. Released the slot
after each attempt. Preserved the unrelated generated core receipts outside this slice and
restored their tracked files. Kept this worktree for review.
