# Tailnet pilot rehearsal

Journey on a fresh dev stack: FAIL

## Fix round 2 packaged rehearsal

On 25 November 2026, one fresh packaged run used
`7ea993e958bbd481e5526b4998b14f255cedfbce`. The two approvals had unexpired
artifacts for the tested revision.
[Application approval](https://github.com/elewa-git/opencrane-new/actions/runs/45584773562),
[scanner approval](https://github.com/elewa-git/opencrane-new/actions/runs/45584773050)
and [hosted CI](https://github.com/elewa-git/opencrane-new/actions/runs/45584762468).

- **PASS** Ordinary fresh secondary startup, status and journey, followed by
  teardown. Before the packaged run, both slots were free and the one-minute
  load had been below six for five minutes.
- **PASS** Installed the package in provider qualification mode. The install
  recorded the `accepted-dev-box-366` exception for the F1 swap and F2 crash-dump
  checks. Browser sign-in, first-owner claim, provider reachability, the quoted
  model test and switching on member chats passed.
  [Provider connected](screenshots/fix-round-2/provider-connected.png).
- **PASS** The wrong account was refused at 390 px. The first invited member
  accepted. The owner immediately returned to People and sent the second
  invitation. The second invited account accepted and could use the owner
  controls after appointment. [Wrong account refused](screenshots/fix-round-2/wrong-account-390.png)
  and [separate owners](screenshots/fix-round-2/separate-owners.png).
- **PASS** The member sent a different prompt and received a completed reply
  at each width. [1280 px](screenshots/fix-round-2/member-chat-1280.png) and
  [390 px](screenshots/fix-round-2/member-chat-390.png).
- **FAIL** Confirmed the 02:00 UTC schedule and moved the disposable CronJob to
  10:12 UTC. Kubernetes started the scheduled job. The job reported `verify`
  during its checks after capture and ended `BackoffLimitExceeded`. Its log
  records the stage without the underlying exception. The catalogue had zero
  completed sets.
- **NOT RUN** A fresh restore, reading the saved chat at either width and the
  restored write refusal. The failed backup left no verified set to restore.
- **PASS** Retained startup and service logs, the backup Job failure and the
  browser screenshots. Released the package and slot and removed the temporary
  sign-in app.

The regression creates and accepts an invitation through HTTP and then reads the
directory as the owner. With the event-store position lookup for totals expired,
the old server returns HTTP 503. The fixed server returns the authorised member
rows and enables invitations while the counts report unavailable. It also logs
the failing stage and a safe cause for essential reads. The retained logs of the
previous rehearsal omit the underlying exception for its HTTP 503.

**PASS** The invitation and realtime suites passed twice, with 143 tests each
time. Typecheck, the event catalogue check, Knip, the whole-stream read check,
changelog lint, Markdown lint, the README check and scoped ESLint passed.
[Regression finding and fix](https://github.com/elewa-git/opencrane-new/pull/1187#issuecomment-7158260577).

## Fix round 1 packaged rehearsal

On 25 November 2026, one fresh run used
`fbf6ed4566355031857ca5d86c8cf31ef1ebd6bb`. Both image approval runs had
unexpired artifacts for that exact revision.
[Application approval](https://github.com/elewa-git/opencrane-new/actions/runs/45568219689)
and [scanner approval](https://github.com/elewa-git/opencrane-new/actions/runs/45568223596).
[Hosted CI for the tested revision](https://github.com/elewa-git/opencrane-new/actions/runs/45568226777).

- **PASS** Installed the package in provider qualification mode after both
  secondary slots were free and the one-minute load was under six for five minutes.
  Package startup recorded the `accepted-dev-box-366` F1 swap and F2 crash-dump exception.
- **PASS** Signed in through the browser, claimed the silo and confirmed the
  owner could open Settings. Reachability and the quoted model test each
  returned HTTP 200 before the driver read the saved result. The owner enabled
  member chats. [Provider connected](screenshots/fix-round-1/provider-connected.png).
- **PASS** The wrong account signed in at 390 px and was refused with
  `wrong_identity`. The invited member signed in and accepted the link.
- **FAIL** The owner's next visit to People & groups returned HTTP 503 from
  `GET /api/members`. The page showed “Members are unavailable right now”
  and the second invitation button was absent. The service logs confirm
  the HTTP 503 and do not identify its underlying exception.
  [Members page at failure](screenshots/fix-round-1/members-unavailable.png).
- **NOT RUN** Separate owner appointment, member replies at 1280 and 390 px,
  scheduled backup verification, a new restore namespace, and reading the same
  chat and checking write refusal after restore.
- **PASS** Retained startup and service logs and the masked failure screenshot
  before teardown. Released the package and slot and removed the temporary sign-in app.

The regression tests failed first on the network-idle wait with a usable sign-in form
and on the premature provider status read returning HTTP 503. The driver now
follows the credential fields and waits for the selected provider's verification
response. The focused Node tests (45), restore tests (28) and invitation tests (3)
passed twice. Typecheck, the event catalogue check, Knip, changelog lint, Markdown
lint and ESLint for the changed web files passed. The repository's ESLint config
excludes infrastructure files, which passed the package and dev-stack typechecks.

## Earlier packaged rehearsal

- **PASS** Ordinary fresh secondary install, status and journey, followed
  by teardown.
- **FAIL**, then **PASS** Packaged sign-in and first-owner claim worked.
  When the browser opened Settings before permissions were ready, provider
  creation returned `access_applying`. The repeat confirmed the first
  owner in **People & groups → Owners** before opening Settings.
- **PASS** With the approved `10ac5d39cceb664e501392b64967ee9393dad3cb`
  images, the repeat connected the free provider in Settings. The wrong
  account was refused, an invited member accepted and a separate test
  owner accepted and was appointed. The member sent a different prompt
  and received a completed reply at 1280 px and 390 px.
- **PASS** The repeat confirmed the 02:00 UTC schedule and moved only the
  disposable CronJob to 05:23 UTC. Kubernetes ran the job. The catalogue
  verified the backup at event position 121 and an archive was copied to
  private storage before teardown.
- **FAIL** A new namespace and new volumes were used for recovery. Its
  restore Job rejected the complete provider-mode backup with
  `invalid_backup`. The saved routines checkpoint was absent from the
  restore job's expected list. The final product revision shares the
  projection list between backup and restore. Its regression tests cover
  validation and restored database tables. The fixed validator also
  accepted the archived set in provider mode and rejected it in stand-in
  mode.

The earlier source screenshots were retained before teardown.

- [Provider connected](screenshots/provider-connected.png)
- [Wrong account refused at 390 px](screenshots/wrong-account-390.png)
- [Two owners](screenshots/separate-owners.png)
- [Member chat at 1280 px](screenshots/member-chat-1280.png)
- [Member chat at 390 px](screenshots/member-chat-390.png)

## Earlier exact-head repeats

These repeats used `931a8819d1288d4c79957d286282181bd5ae1f02`. Its
[CI](https://github.com/elewa-git/opencrane-new/actions/runs/45555352321) passed.
Its [application](https://github.com/elewa-git/opencrane-new/actions/runs/45555379310)
and [scanner](https://github.com/elewa-git/opencrane-new/actions/runs/45555379303)
approvals had unexpired artifacts when checked.

- **PASS** Two fresh packages installed with the final approved images.
  The browser signed in, claimed the silo and confirmed the first owner's
  permissions. Packaged runs used the recorded local dev-box exception for
  the F1 swap and F2 crash-dump checks.
- **FAIL** One run [connected the provider](screenshots/repeat/provider-connected.png)
  but the browser driver timed out waiting for network activity to stop
  during the wrong-account sign-in.
  The next run stopped on a provider status read that returned HTTP 503
  while reachability verification was still being submitted. The service
  logs show the verification submission later completed with HTTP 200.
- **NOT RUN** A final repeat was queued with the browser waiting for the
  verification submission to complete. The two-hour admission allowance
  expired before both slots were free with a full five-minute load window
  below six.

Startup and service logs and the masked failure screenshots were saved
privately before tearing down each claimed slot. Each package and its slot
were released. The temporary sign-in apps were removed.

## Tailnet switch-over

**NOT RUN** The real `.ts.net` name and Tailscale HTTPS. The secondary slot
used a loopback TLS fixture with real sign-in in the development
organisation. The owner or orchestrator checks the actual tailnet route
and certificate at switch-over.

**NOT RUN** The demo switch and rollback, the designated owner's actual
account and a paid call. The rehearsal uses separate test accounts and the
local provider qualification service.
