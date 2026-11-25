# Packaged monthly budget journey

Packaged qualification **FAIL** on `3f0b91fecea63b9388ffc77785333c669de4972a`.
The 1280 px case finished with a 16-cent reservation, a 1-cent charge, and
two stand-in requests before and after the refusal. At 390 px, Playwright's
read of the budget projection after saving the ceiling lost its connection.
A fresh unauthenticated request through the same forward returned HTTP 200
immediately afterward. The packaged pods stayed ready. The same 390 px failure
occurred on `7fd5410e7b4078cc98b795971605ba3ff323eb00`.

The [1280 px Spending](screenshots/final-spending-1280.png) and
[chat refusal](screenshots/final-package-refusal-1280.png) screenshots show the
latest attempt. Startup, service and browser evidence was copied before teardown.
Both package and slot teardown exited successfully.

The final product commit had green [CI](https://github.com/elewa-git/opencrane-new/actions/runs/45578391016)
and both approvals. The image and approval artifacts for the same commit were
available before stack preparation.
[Application approval](https://github.com/elewa-git/opencrane-new/actions/runs/45578532425),
[scanner approval](https://github.com/elewa-git/opencrane-new/actions/runs/45578532035)

The earlier fresh run on `e1b725e4138b48bf83a0e45ec8d90a880d81874a`
completed the budget scenario at both widths. It failed the final browser
response inspection when Chromium cancelled continuation of an already
inspected response.

## Packaged steps and observations

1. Claim a free secondary slot. Run `package-prepare`, `package-up` and
   `package-check` with that slot's explicit ID and the CI-approved images
   for the checked-out commit. Enable provider mode with qualification on.
   Set `OPENCRANE_ACCEPT_DEV_HOST_RISK=accepted-dev-box-366` on `package-up`
   for this development host. The install logs the accepted swap risk.
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

The following figures and screenshots come from the earlier run that
completed the budget scenario at both widths.

| Width | Reserved cents | Charged cents | Group spent cents | Lowered ceiling cents | Requests before and after refusal |
| --- | ---: | ---: | ---: | ---: | --- |
| 1280 px | 16 | 1 | 1 | 0 | 2 → 2 |
| 390 px | 16 | 1 | 2 | 1 | 3 → 3 |

- 1280 px [Spending](screenshots/spending-1280.png) and
  [chat refusal](screenshots/package-refusal-1280.png)
- 390 px [Spending](screenshots/spending-390.png) and
  [chat refusal](screenshots/package-refusal-390.png)

The stand-in reported token usage for every charged turn. All qualification
runs made zero paid provider calls and spent zero paid euro cents.

## Fresh Compose stack

Core journey **PASS** on `ca3d82daa9fc3c76fb80ce9cb2d9a39ab39a9478`. On a
fresh secondary stack, the owner saved the paying-group and assistant
ceilings. The member saw each refusal persist after reloading at 1280 px and
390 px. The additional charged-budget check on Compose was **PARTIAL**.
Its later isolated run was refused at invitation because the core membership
setup had not been run on that slot. Both stacks were torn down.

- [1280 px paying-group refusal](screenshots/compose-refusal-1280.png)
- [390 px paying-group refusal](screenshots/compose-refusal-390.png)
