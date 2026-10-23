# Fresh organisation journey details

The browser check lives in `infra/dev-stack/browser-phase4.ts` and runs from
`infra/dev-stack/journey.ts`. It runs only when the stack is secondary and the
journey has real signed-in browser sessions, and `P4_JOURNEY_ATTEMPT` names the
run. The owner stack and runs without a browser do not run these checks. Names starting
with `nightly-` keep the daily job’s groups-only scope; manual named runs also check
provider saving and ownership.

The check creates a group through the group page, adds the seeded member through
`POST /api/groups/:groupId`, and removes that member through the reviewed group
screen. The server has no command for granting a model to a group, so the check
adds that one event to the disposable stack event store. It creates a shared
assistant through its server command, starts a private session through the
member page, and waits for the local model stub's reply before saving screenshots.

The check creates a new group, assistant, provider and direct conversation on
every run. A saved-data run may open the previous direct conversation, so the
browser check first returns to a blank draft. Receipts and screenshots first live under
`$DEV_STACK_DIR/p4-journey/<attempt>/`. Copy them into this folder only after
the run has been recorded. The receipt includes the commit and the measured
Phase 4 run time.

## Current journey work

Part of #84. This also covers the live groups journey in #83 and the ownership
handover in #24. The starting main commit was
`6da660479e7d5e5ce32bd958572bdab8b1a06c47`.

The work used `npm ci` in this worktree. The two requested tool paths are symlinks
to the existing NATS server and link checker. `df -h /` showed 172 GiB available
before `claim.sh` reserved secondary slot 1. The owner stack was not used.
Zitadel used the configured key file path; its contents were not copied into
receipts. The separate owner test user was present on every fresh start.
The managed model calls used the local stub throughout.

The journey fixes are in the development scripts. No product code changed:

- Refuse an Admin fixture instead of silently skipping the owner check. Prepare
  the real signed-in account as sole Owner through product commands. Keep the
  separate test user in the silo and restore both browser roles after success.
- Match the transfer event to the current browser command id. An older transfer
  of the same person is not evidence for a saved-data run.
- Inspect and click the read-only status button in one browser operation. A button
  that disappears during completion must not cause a locator timeout.
- Read the accepted step-down through Check status, as the product screen requires.
  Keep the existing appointment and step-down limits. Repeat no write command.
- Preserve the nightly job’s groups-only scope. Manual named runs include ownership
  and provider saving.

Each fix has a failing-first regression. The focused ownership and group-chat
scripts passed 14 tests twice after the final scope change. The tests use normal
API and browser fixtures; they do not claim a live installation passed.
The receipts and the table in README.md record each live result separately.

The third fresh attempt proved the ownership handover. The previous owner became
a Member and retained workspace access. Owner and admin reads returned 403, while
the member chat read returned 200. The sole owner’s step-down returned 409 with
`last_owner`. Self-removal returned 409 with `ownership_stream_required`.
Neither refusal moved its corresponding stream position.

That full start still failed the additional group-chat sender display limit.
The message POST returned 200 and the following history read returned 200, but
these facts do not prove that the sender displayed the message within two seconds.
Other participant captures later show both messages. No root cause is established
for that timing failure, and no product fix is claimed.

The first saved-data command reached the ownership and group-chat screens, then
ended with SIGTERM before it wrote an assertion receipt. The single saved-data
rerun also ended with SIGTERM, before the named browser section. Both command
sessions returned 143. The stack processes stayed running. The stack error logs
still had the earlier fresh run’s timestamps, rather than a new caught error.
The signal source remains unknown. Manual interruption records preserve that
limit; their empty assertion lists cannot establish a pass. No further saved-data
retry was made. No wait, write retry or timing limit was added to hide a failure.

### Second fresh installation

`fresh-2` ran on `610f345abab575c08ff4b5278fc86eaca54102f8`. The full start
passed from 16:50:17 to 17:06:19 UTC. Its named browser section passed 39 checks
in 172,818 ms. It kept the two explicit limits: separate member disks were
NOT PROVEN and the paid provider check was PAID / NOT RUN.
The later group message appeared on the sender’s screen in 365 ms. Removal
cleared the page in 542 ms and leave cleared it in 1,153 ms. No AI, computer or
budget event occurred during the measured human messages.
This fresh pass does not erase the earlier timing failure or prove a saved-data repeat.

All 310 retained captures were inspected by eye at their original size in contact
sheets. This includes 42, 48, 76, 68 and 76 pictures from the five attempts that
saved pictures. No readable email address appeared. The screenshots mask email
text and email inputs. Receipts were also checked for email addresses and token
shapes. Raw service logs and credentials remain outside the public repository.

### Local verification and cleanup

[Local check results](runs-2026-10-23/checks.json) lists the final commands and
results. Lint, typecheck, event catalogue agreement, Knip, changelog validation and
the two focused test runs use `nice -n 10`. The focused tests require no database.
The full root suite was NOT RUN, as requested. Earlier full lint and typecheck
reruns were deliberately stopped to free resources for the live browser. They are
not recorded as passing checks; the final commands run after stack cleanup.

Secondary slot 1 was released through `down.sh`. Its status returned `free`,
its generated directory was absent, and its Compose containers were absent.
Generated pictures from unrelated journeys were restored to their starting versions.

## Earlier live attempt record

The first two fresh starts passed at commit
`fd7a48add6948c3f93970a0c8ad7816f72247e91`. Their Phase 4 times were 48,461 ms
and 59,039 ms. Both starts completed the full stack journey.

| Attempt | Commit | Phase 4 result and time | What stopped the run |
| --- | --- | --- | --- |
| `fresh-1` | `fd7a48a` | PASS, 48,461 ms | Full start passed. |
| `fresh-2` | `fd7a48a` | PASS, 59,039 ms | Full start passed. |
| `repeat-1` | `fd7a48a` | NOT RUN | The journey check expected every model grant for a shared assistant, even though its event names only selected models. The saved-data check timed out before Phase 4. Fixed in `92b48277`. |
| `repeat-2` | `92b48277` | FAIL, 134,171 ms | The sixth computer had no disk because the stack allowed only five 1 GiB claims. The stack now allows six. |
| `recovery-fresh` | `b76fcfa` | PASS, 80,596 ms | Phase 4 passed. The full start then failed when a Zitadel login navigation aborted during browser cleanup. |
| `repeat-3` | `b76fcfa` | NOT RUN | The earlier chat check reported an uncertain send and timed out before Phase 4. The service log also recorded a worker timeout. |
| `repeat-4` | `b76fcfa` | FAIL, 58,636 ms | The desktop direct chat reopened the previous conversation instead of a blank draft. Fixed by starting a new draft. |
| `recovery-fresh-2` | `c3406bc` | FAIL, 84,342 ms | The direct chat page had not finished loading before the check searched for the colleague. A wait for the saved conversation list was added. |
| `repeat-5` | `31cc24c` | NOT RUN | Network changes stopped the earlier chat check before Phase 4. No Phase 4 receipt was written. |

The receipts for attempts that reached Phase 4 are next to this file. Each one
names the commit that ran and gives a status for every assertion it reached.
The two requested fresh receipts have all group, shared assistant, removal,
direct chat and provider save checks marked `PASS`. Ownership transfer and
separate member disks are `NOT PROVEN`; the paid provider answer is `PAID / NOT
RUN`. The saved-data repeat is still `NOT PROVEN` because no repeat completed
all its checks.

Zitadel setup succeeded on each start. The no-provider-response error from the
earlier run did not recur, so no five-minute setup retry was needed. All 176
copied screenshots were checked. None is a one-colour image or smaller than
5 KB.

The earlier ownership check used an Admin account and recorded `NOT PROVEN`.
The current journey prepares the browser account through the product’s ownership
commands, then checks the appointment, step-down, Member role and refusals.
It restores the separate owner and both browser accounts before the saved-data repeat.
Separate member disks and a paid provider answer still have their explicit limits.
