# Packaged monthly budget journey

Packaged qualification **FAIL** on `0dfcb403ee112d85b4e9eb386b929c55f49c39cf`.
The budget scenario passed at both widths. The credential checks for values,
manifests, environment, logs and 166 saved events also passed. The final browser
API response inspection failed. It recorded the failed step and a generic
error, leaving the browser operation unidentified. The single fresh run made
zero paid calls and spent zero paid euro cents.

Slot 1 was claimed after both secondary slots were free, no secondary package
was up, and the one-minute load stayed under 6 for five minutes. The job then
created a fresh namespace and installed the approved images for the exact
checked-out revision. Both image and approval artifacts were available before
preparation. [CI](https://github.com/elewa-git/opencrane-new/actions/runs/45588254273),
[application approval](https://github.com/elewa-git/opencrane-new/actions/runs/45588329106),
[scanner approval](https://github.com/elewa-git/opencrane-new/actions/runs/45588329074)

Package installation and `package-check` **PASS**. Startup, service and browser
evidence was saved before teardown. `package-down` and `down.sh` exited with
status 0, and the slot reported free.

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

Both width checks below came from this single run. Spending screenshots matched
the existing copies byte for byte. The refusal screenshots are from this run.

| Width | Reserved cents | Charged cents | Group spent cents | Lowered ceiling cents | Requests before and after refusal |
| --- | ---: | ---: | ---: | ---: | --- |
| 1280 px | 16 | 1 | 1 | 0 | 2 → 2 |
| 390 px | 16 | 1 | 2 | 1 | 3 → 3 |

- 1280 px [Spending](screenshots/spending-1280.png) and
  [chat refusal](screenshots/fix1-package-refusal-1280.png)
- 390 px [Spending](screenshots/spending-390.png) and
  [chat refusal](screenshots/fix1-package-refusal-390.png)

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

The earlier run on `e1b725e4138b48bf83a0e45ec8d90a880d81874a` passed the
budget scenario at both widths. Its final browser response inspection failed
when Chromium cancelled continuation of an already inspected response.

## Source checks

All 44 changed tests passed twice. Four related browser-editor and package-page
tests passed. Typecheck, the event catalogue, Knip, changelog and Markdown checks
passed. ESLint exited successfully and reported the repository's infrastructure
ignore rules. The public privacy and secret scans passed before the fix was
pushed.

## Fresh Compose stack

Core journey **PASS** on `ca3d82daa9fc3c76fb80ce9cb2d9a39ab39a9478`. On a
fresh secondary stack, the owner saved the paying-group and assistant
ceilings. The member saw each refusal persist after reloading at 1280 px and
390 px. The additional charged-budget check on Compose was **PARTIAL**.
Its later isolated run was refused at invitation because the core membership
setup had not been run on that slot. Both stacks were torn down.

- [1280 px paying-group refusal](screenshots/compose-refusal-1280.png)
- [390 px paying-group refusal](screenshots/compose-refusal-390.png)
