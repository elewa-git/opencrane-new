# Packaged monthly budget journey

## Fresh packaged run on 25 November 2026

Packaged qualification **FAIL** on `f3ac73819f7533d5af6f02087756909169fc30ae`.
In the single run, the stand-in returned HTTP 401 for the wrong key. Settings
refused it without showing the key. The owner connected, tested and switched on
the stand-in with the correct key. [Browser result](fix3-result.json)

The admin saved a 500-cent monthly ceiling at each width. Change history showed
the reservation and charge for the member's reply. Spending showed the settled
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
   see its reply. Read the same turn's reservation and charge from admin
   Change history and verify settled euro cents in Spending.
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
