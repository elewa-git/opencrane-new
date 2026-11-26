# Packaged monthly budget journey

## Fresh packaged run 2

Packaged qualification **PASS** on 25 November 2026. One fresh Helm install on
secondary slot 1 used source `60121fef3d897138d466127abe136e6aacc66a09`.
The one-minute host load stayed below 6 across 30-second samples for more than
six minutes before the claim. Both image approvals matched this revision, and
their artifacts were available. [CI](https://github.com/elewa-git/opencrane-new/actions/runs/45684027922),
[application approval](https://github.com/elewa-git/opencrane-new/actions/runs/45684039512)
and [scanner approval](https://github.com/elewa-git/opencrane-new/actions/runs/45684039122).

Package preparation, installation and the ownership check **PASS**. The install
recorded `OPENCRANE_ACCEPT_DEV_HOST_RISK=accepted-dev-box-366` for this
development host. The owner invited a separate admin and member. The free
stand-in returned HTTP 401 to the wrong key. The owner connected, tested and
switched on the stand-in for member chats.

Both browser widths **PASS**. The admin saved a 500-cent monthly group ceiling.
The member opened the shared assistant and received a reply. Member action
history kept both amounts private. The admin opened the matching turn in Change
history and saw the reservation and charge. Spending showed the settled group
total. The admin lowered the ceiling, and chat explained the limit on the next
turn. That turn sent no request to the stand-in.

| Width | Reserved cents | Charged cents | Group spent cents | Lowered ceiling cents | Arrivals before and after refusal |
| --- | ---: | ---: | ---: | ---: | --- |
| 1280 px | 16 | 1 | 1 | 0 | 5 → 5 |
| 390 px | 16 | 1 | 2 | 1 | 6 → 6 |

- 1280 px [Turn spending](screenshots/run-2-turn-spending-1280.png),
  [group spending](screenshots/run-2-settled-spending-1280.png) and
  [chat refusal](screenshots/run-2-budget-refused-1280.png)
- 390 px [Turn spending](screenshots/run-2-turn-spending-390.png),
  [group spending](screenshots/run-2-settled-spending-390.png) and
  [chat refusal](screenshots/run-2-budget-refused-390.png)

Server disclosure **PASS**. The run checked local and installed Helm values,
running manifests, eight container logs and 166 saved events. All checked
containers were on their first start. The fixtures cover logs from restarted
containers. Final browser reconciliation **PASS**. The driver inspected 256 API
replies and matched the completed page requests to their inspected replies
through shutdown. Zero paid calls and zero paid euro cents.
[Browser result](run-2-result.json)

The runner saved `package-up.log`, `browser.log` and the service logs before
teardown. `package-down` and `down.sh` both exited with status 0. Slot 1 reported
free.

The 84 focused Node tests, 26 Change history tests and two saved-event
disclosure tests passed twice. Typecheck, the event catalogue, Knip, the
changelog, Markdown and README checks passed. ESLint passed on the changed
web files. Its configuration excludes the infrastructure files.

## Earlier fresh run after the quiet-container log fix

Packaged qualification **FAIL** on 25 November 2026. One fresh Helm install on
secondary slot 1 used source `285e5cc28948f853195440ae23047656cf407a80`. CI
passed and both image approvals and their artifacts matched that revision. Both
secondary slots were free, no other package was running, and the one-minute
load stayed below 6 for five minutes before the claim.
[CI](https://github.com/elewa-git/opencrane-new/actions/runs/45669555038),
[application approval](https://github.com/elewa-git/opencrane-new/actions/runs/45673729280),
[scanner approval](https://github.com/elewa-git/opencrane-new/actions/runs/45673729037)

Package preparation, installation and ownership check **PASS**. The install
recorded `OPENCRANE_ACCEPT_DEV_HOST_RISK=accepted-dev-box-366` for this
development host. The owner signed in, invited a separate admin and member,
and connected the free stand-in. The wrong key received HTTP 401. The quoted
test and switch to member chats passed.
[Stand-in test at 1280 px](screenshots/qualification-model-test-passed-1280.png),
[stand-in test at 390 px](screenshots/qualification-model-test-passed-390.png)

The first Spending step stalled before the admin could save the 1280 px
ceiling. The browser driver was waiting for an earlier Settings reply on
another page. Chromium recorded HTTP 503 and still had no completed body more
than ten minutes later. The run was stopped there. The reason the reply did
not finish is unresolved.

The spending, member history and refusal checks at both widths were
**NOT RUN**. Server disclosure and the final browser reply check were
**NOT RUN**. The run made zero paid calls and spent zero paid euro cents.

The runner saved `package-up.log`, `browser.log`, the service logs and
`browser-wait-operations.json` before teardown. Both cleanup commands
exited with status 0, and slot 1 reported free.

On the tested revision, the focused checks passed 154 tests twice. Typecheck,
the event catalogue, Knip and the changelog check passed. ESLint passed on the web files.
Its configuration excludes the infrastructure files.

## Earlier packaged run for the review fixes

Packaged qualification **FAIL** on 25 November 2026 with approved source
`f22b076e26b4c16316517997cf44c0a046ab5cb6`. The package was installed once in a
fresh Helm namespace on secondary slot 1. The application and scanner approval
artifacts were present for this commit. Both secondary slots were free, no other
package was running, and the one-minute load stayed under 6 for more than five
minutes before the claim. [Application approval](https://github.com/elewa-git/opencrane-new/actions/runs/45665250404),
[scanner approval](https://github.com/elewa-git/opencrane-new/actions/runs/45665257685)

Package preparation, installation and the package ownership check **PASS**.
The install recorded the development host exception
`OPENCRANE_ACCEPT_DEV_HOST_RISK=accepted-dev-box-366`. The wrong synthetic key
received HTTP 401. The owner saved the correct key, ran the quoted test against
the free stand-in and switched on member chats. [Browser result](fix5-result.json)

At both widths, the admin set a 500-cent monthly group ceiling and the member
received a reply. Member action history kept both amounts private. The admin
opened the matching turn in Change history and saw its 16-cent reservation and
1-cent charge. Spending showed the new group total. After the admin lowered the
ceiling, chat explained the group limit and the next turn sent no request to the
stand-in. These browser steps **PASS**.

| Width | Reserved cents | Charged cents | Group spent cents | Lowered ceiling cents | Arrivals before and after refusal |
| --- | ---: | ---: | ---: | ---: | --- |
| 1280 px | 16 | 1 | 1 | 0 | 5 → 5 |
| 390 px | 16 | 1 | 2 | 1 | 6 → 6 |

- 1280 px [Turn spending](screenshots/fix5-turn-spending-1280.png),
  [group spending](screenshots/fix5-settled-spending-1280.png) and
  [chat refusal](screenshots/fix5-budget-refused-1280.png)
- 390 px [Turn spending](screenshots/fix5-turn-spending-390.png),
  [group spending](screenshots/fix5-settled-spending-390.png) and
  [chat refusal](screenshots/fix5-budget-refused-390.png)

The server disclosure step returned a generic failure. The retained pod logs
showed output from the server and stand-in. The other running containers in the
server pod were quiet. A fixture reproduced the failure when a successful log
command returned no lines for those containers. The follow-up accepts successful
empty reads from quiet containers. It still checks their contents and fails on
failed reads or missing expected output. The fixture passed with that change.

The final browser reply reconciliation was **NOT RUN** after the server check
failed. At that point, the follow-up had only run in fixtures. The run made
zero paid calls and spent zero paid euro cents.

The runner saved `package-up.log`, `browser.log` and the service logs before
teardown. `package-down` and `down.sh` both exited with status 0, and slot 1
reported free.

The 83 focused Node tests, 26 Change history tests and two saved-event tests
passed twice. The tests caught all 23 deliberate breaks in the guards before
the source was restored.

## Earlier packaged run after the shutdown fix

Packaged qualification **PARTIAL** on 25 November 2026, using approved
`f9117476e9b7bcb37034ff8a562e12133af563e3`.
The stand-in returned HTTP 401 for the wrong key. Settings refused it without
showing the key. The owner connected, tested and switched on the stand-in with
the correct key. [Browser result](fix4-result.json)

The admin saved a 500-cent monthly ceiling at both widths. The Change history
API returned each reply's reservation and charge. The screen showed the group
total in Spending. The check for both amounts on screen was **NOT RUN**. After
the admin lowered the ceiling, chat explained the limit and the stand-in received
no new request.

| Width | Reserved cents | Charged cents | Group spent cents | Lowered ceiling cents | Requests before and after refusal |
| --- | ---: | ---: | ---: | ---: | --- |
| 1280 px | 16 | 1 | 1 | 0 | 2 → 2 |
| 390 px | 16 | 1 | 2 | 1 | 3 → 3 |

- 1280 px [Spending](screenshots/fix4-spending-1280.png) and
  [chat refusal](screenshots/fix4-refusal-1280.png)
- 390 px [Spending](screenshots/fix4-spending-390.png) and
  [chat refusal](screenshots/fix4-refusal-390.png)

The disclosure checks passed for the package values, manifests, environment
values, server logs, 166 saved events and 129 browser API replies. The
browser check finished through shutdown. Zero paid calls and zero paid euro
cents.

Both secondary slots were free, no other secondary package was up, and the
one-minute load stayed below 6 for seven minutes before the runner claimed
slot 1. The exact commit's application and scanner approval artifacts were
available before preparation. [Application approval](https://github.com/elewa-git/opencrane-new/actions/runs/45643243069),
[scanner approval](https://github.com/elewa-git/opencrane-new/actions/runs/45643243058)

The fresh Helm install and `package-check` passed. The install recorded
`OPENCRANE_ACCEPT_DEV_HOST_RISK=accepted-dev-box-366`. The runner saved
`browser.log`, `package-up.log` and the service logs before teardown.
`package-down` and `down.sh` exited with status 0. Slot 1 reported free.

## Previous fresh run with the listening collector

Packaged qualification **FAIL** on `f3ac73819f7533d5af6f02087756909169fc30ae`.
In the single run, the stand-in returned HTTP 401 for the wrong key. Settings
refused it without showing the key. The owner connected, tested and switched on
the stand-in with the correct key. [Browser result](fix3-result.json)

The admin saved a 500-cent monthly ceiling at each width. The Change history
API returned the reservation and charge for the member's reply. Spending showed the settled
amount. When the admin lowered the ceiling below that amount, chat explained
the monthly limit and the stand-in received no new request.

| Width | Reserved cents | Charged cents | Group spent cents | Lowered ceiling cents | Requests before and after refusal |
| --- | ---: | ---: | ---: | ---: | --- |
| 1280 px | 16 | 1 | 1 | 0 | 2 → 2 |
| 390 px | 16 | 1 | 2 | 1 | 3 → 3 |

- 1280 px [Spending](screenshots/fix3-spending-1280.png) and
  [chat refusal](screenshots/fix3-refusal-1280.png)
- 390 px [Spending](screenshots/fix3-spending-390.png) and
  [chat refusal](screenshots/fix3-refusal-390.png)

The disclosure check passed for the package values, manifests, environment
values, server logs and 166 saved events. The browser's final disclosure check
failed during shutdown. The result records a generic error. The last approval
requests in the retained server log returned HTTP 200. The underlying browser
error remains unknown. Zero paid calls and zero paid euro cents.

Both secondary slots were free and no secondary package was up. The one-minute
load stayed under 6 for six minutes before slot 1 was claimed. The application
and scanner approvals matched the checked-out commit, and their artifacts were
available before preparation. [Application approval](https://github.com/elewa-git/opencrane-new/actions/runs/45633533223),
[scanner approval](https://github.com/elewa-git/opencrane-new/actions/runs/45633533161)

The fresh Helm install and `package-check` passed. The package install recorded
`OPENCRANE_ACCEPT_DEV_HOST_RISK=accepted-dev-box-366`. The runner saved
`browser.log`, `package-up.log` and the service logs before teardown.
`package-down` and `down.sh` exited with status 0. Slot 1 reported free.

## Previous fresh run

Packaged qualification **FAIL** on `cc3e462305ab415252ac9e1d8594dfdd29b97ef9`.
The wrong key received HTTP 401 from the stand-in, and Settings refused it
without showing the key. Connecting and switching on the correct key passed.
While the driver checked outstanding API replies before opening Spending,
Chromium could not read the body of an HTTP 200 response. The 1280 px save step
failed before the browser sent a budget save. The 390 px scenario, artifact and
event checks, and final browser inspection were **NOT RUN**. The single fresh
run made zero paid calls and spent zero paid euro cents. [Browser result](fix2-result.json)

Slot 1 was claimed after both secondary slots were free, no secondary package
was up, and the one-minute load stayed under 6 for nine minutes. The job then
created a fresh namespace and installed the approved images for the exact
checked-out revision. Both image and approval artifacts were available before
preparation. [CI](https://github.com/elewa-git/opencrane-new/actions/runs/45599131149),
[application approval](https://github.com/elewa-git/opencrane-new/actions/runs/45599158366),
[scanner approval](https://github.com/elewa-git/opencrane-new/actions/runs/45599158295)

Package installation and `package-check` **PASS**. Startup, service and browser
evidence was saved before teardown. `package-down` and `down.sh` exited with
status 0, and the slot reported free. The private `browser.log` records the
operation and HTTP status, and the private service logs show the requests the
API received.

## Packaged steps and observations

1. Claim a free secondary slot with `claim.sh`. Use its explicit ID for
   `package-prepare`, `package-up` and `package-check`. Prepare the private values
   file with provider mode and qualification enabled, then start the loopback
   forward and `journey-entry.ts --budget`. On this development host, `package-up`
   logged `OPENCRANE_ACCEPT_DEV_HOST_RISK=accepted-dev-box-366` for the accepted
   swap and crash-reporter findings.
2. Sign in as the owner. Invite separate admin and member accounts. Connect,
   test and switch on the stand-in from Models & providers.
3. Sign in as the admin. In Spending, save a 500-cent monthly ceiling for
   the paying group. As the member, send a turn to the shared assistant and
   see its reply. Open the same turn in admin Change history, check both
   labelled amounts on screen and verify settled euro cents in Spending.
4. Lower the ceiling to one cent below the settled amount. Send another turn.
   Chat shows “Group monthly limit reached” and asks the member to contact an
   admin. Compare the stand-in request counter immediately before and after
   the refusal.
5. Inspect the saved values, manifests, environment, logs and events for
   credentials. Finish browser API response inspections through shutdown.
   Save the browser, startup and service evidence before `package-down` and
   `down.sh` on the same slot.

## Earlier budget results

On `0dfcb403ee112d85b4e9eb386b929c55f49c39cf`, both widths passed and the
credential checks passed for values, manifests, environment, logs and 166 saved
events. The final browser response inspection failed, so that run also had a
**FAIL** verdict. The numbers and screenshots below came from that earlier run.

| Width | Reserved cents | Charged cents | Group spent cents | Lowered ceiling cents | Requests before and after refusal |
| --- | ---: | ---: | ---: | ---: | --- |
| 1280 px | 16 | 1 | 1 | 0 | 2 → 2 |
| 390 px | 16 | 1 | 2 | 1 | 3 → 3 |

- 1280 px [Spending](screenshots/spending-1280.png) and
  [chat refusal](screenshots/fix1-package-refusal-1280.png)
- 390 px [Spending](screenshots/spending-390.png) and
  [chat refusal](screenshots/fix1-package-refusal-390.png)

## Browser response inspection before the listening collector

The earlier build's private `provider-journey-failure.txt` recorded
`Fetch.continueResponse: Invalid InterceptionId` at the final inspection step.
The next run recorded only a generic error at the same step. Both service logs
end with successful chat approval reads. The evidence leaves the exact failed
response and the second exception unknown.

The regression in `49edceede` caused a chat approval GET to reach the server
after the final check for active requests. Chromium then closed its session
while `Fetch.getResponseBody` was reading that HTTP 200 reply. The fix stops
new API requests at shutdown and checks replies from requests already in
progress. A missing body or a failed inspection still fails the journey. The
test in `2d8eb3094` checks that the failure report includes the operation and
HTTP status without private response details.

The fresh run on `cc3e46230` reached a different point in the browser. A body
read failed during the check before Spending opened, so the new shutdown path
was **NOT RUN**. The browser result identifies the operation and status but
leaves the exact request and the underlying Chromium exception unknown.

## Browser connection failure

The runs on `7fd5410e7b4078cc98b795971605ba3ff323eb00` and
`3f0b91fecea63b9388ffc77785333c669de4972a` reached the 390 px save. The API
returned HTTP 200 to the save, then Playwright's Node HTTP client reported
`socket hang up` on the projection read. The API did not receive that GET.
A request on a fresh connection through the same forward returned HTTP 200.
Browser shutdown followed the failure. The retained logs lack a socket trace.

The website proxy advertised the API server's 72-second idle timeout, while
the website closed idle connections after about six seconds. The test in
`a304935f1` reproduced the symptom in `readBudgetSummary` when a forward
delivered that closure late. Correcting the advertised timeout alone still
left the expired socket in Playwright's pool. Direct journey API calls now
use a fresh connection with the existing browser session for each request.
The proxy advertises its own timeout and keeps connection headers local to
each HTTP connection. The test checks that both GETs reach the API once and
carry the same session.

## Source checks

Before the fix, Chromium reproduced a 30-second collector timeout while an
API request was waiting for its first response. The regression in `883541583`
checks that the driver inspects a completed reply and closes the browser while
the other request is still waiting. The test server confirms that the held
request closed before it sent any headers. The driver still fails if it
cannot read a reply the browser received. A fixture checks that the shutdown
exception and its cause go only to the private log.

On the fixed commit, all 47 focused tests and two saved-event disclosure tests
passed twice. Typecheck, the event catalogue, Knip, changelog, Markdown,
README and both privacy scans passed. The ESLint configuration excluded the
five changed infrastructure files.

Two routine-composition tests failed in an earlier CI shard and passed when run
on their own. They cover late schema and destination changes.
[Earlier source CI](https://github.com/elewa-git/opencrane-new/actions/runs/45633509419),
[fixed source CI](https://github.com/elewa-git/opencrane-new/actions/runs/45643249066)

### Source checks for the earlier listening collector

On `f3ac73819`, 45 focused tests and two saved-event disclosure tests passed
twice. Typecheck, the event catalogue, Knip, changelog, Markdown and both
privacy scans passed. The ESLint configuration excluded all three changed
infrastructure code files. [Source CI](https://github.com/elewa-git/opencrane-new/actions/runs/45633509419)

### Earlier source checks

All 46 changed tests and two event disclosure tests passed twice. Typecheck,
the event catalogue, Knip, changelog and Markdown checks passed. ESLint
reported that its configuration excludes the four changed infrastructure
files. The public privacy and secret scans passed before the fix was pushed.

Source CI **FAIL**. The setup for a routine-session test timed out in shard 3.
That test passed when run on its own. [Failed CI job](https://github.com/elewa-git/opencrane-new/actions/runs/45599131149/job/139153459274)

## Fresh Compose stack

Core journey **PASS** on `ca3d82daa9fc3c76fb80ce9cb2d9a39ab39a9478`. On a
fresh secondary stack, the owner saved the paying-group and assistant
ceilings. The member saw each refusal persist after reloading at 1280 px and
390 px. The additional charged-budget check on Compose was **PARTIAL**.
Its later isolated run was refused at invitation because the core membership
setup had not been run on that slot. Both stacks were torn down.

- [1280 px paying-group refusal](screenshots/compose-refusal-1280.png)
- [390 px paying-group refusal](screenshots/compose-refusal-390.png)
