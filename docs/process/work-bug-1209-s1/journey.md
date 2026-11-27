# First invitation after claiming the installation

Journey on a fresh packaged stack: **FAIL**. Desktop passed. On mobile,
People returned HTTP 503 immediately after the claim and hid **Invite people**.

On 27 November 2026, slot 1 was claimed at 05:02 UTC with one-minute load
at 3.83. The run used a fresh Helm installation per width, each with five
new persistent volume claims and its own one-time owner token. The product
commit was `fb932db61ef16f21a26921fa68b42c0d90ca8a16`.
[CI run](https://github.com/elewa-git/opencrane-new/actions/runs/45926426186) ·
[Application approval](https://github.com/elewa-git/opencrane-new/actions/runs/45926457320) ·
[Scanner approval](https://github.com/elewa-git/opencrane-new/actions/runs/45926457185)

| Step | 1280 px | 390 px |
| --- | --- | --- |
| Start a fresh package in slot 1 | PASS | PASS |
| Claim the empty installation in Chromium | PASS · HTTP 201 | PASS · HTTP 201 |
| Open People immediately after claiming | PASS · HTTP 200 | FAIL · HTTP 503 |
| Submit the first invitation and see the link | PASS · HTTP 200 | NOT RUN |
| Accept the invitation as an ordinary member | PASS · HTTP 200 | NOT RUN |
| Submit an invitation as that member | PASS · HTTP 403, `access_refused` | NOT RUN |
| Remove the disposable package | PASS | PASS |

At 1280 px, the browser sent the first invitation flow's address check
2.18 seconds after receiving the claim response. The address check and
invitation command each returned HTTP 200. The invited member signed in,
accepted the link, and could read their own member header. Their invitation
request then returned HTTP 403 with reason `access_refused`.

At 390 px, the server received `GET /api/members` 0.69 seconds after the
claim response. It logged `Member read unavailable` at `caller_authorisation`
with reason `membership_applying`. People showed **Members are unavailable
right now**. The mobile journey never reached either invitation endpoint.
[PR #1206](https://github.com/elewa-git/opencrane-new/pull/1206) covers this
first-owner People read on a different revision.

[Result data](results.json) · [Desktop invitation](invitation-created-1280.png) ·
[Desktop refusal](member-refused-1280.png) · [Mobile error](failed-390.png)

Both package starts recorded the documented `accepted-dev-box-366` host
exception for F1/F2. Both disposable sign-in apps were removed and slot 1
reported free after teardown. Startup and service logs were collected before
each teardown. See `package-up.log`, `browser-1280.log`, `browser-390.log`
and `server-f7b4f6794-9clwz.log` for the mobile server's failure.

The original build recorded NOT RUN after its two-hour capacity wait. This
run used the first free sample below 6 after correcting a polling script
error that missed an earlier sample. Capacity checks are in `live-capacity.log`.

The source regression reproduced the original invitation-command HTTP 503
while OpenFGA was still applying ownership. The fix gives both invitation
endpoints up to five seconds to wait for a claim that the account made
within the past 30 seconds. Both earlier focused runs passed 171 tests,
and removing the claimant identity check made the refusal test fail.
