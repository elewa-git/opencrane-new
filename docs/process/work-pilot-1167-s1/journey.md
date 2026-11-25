# Tailnet pilot rehearsal

Journey on a fresh dev stack: FAIL

Run date: 25 November 2026. The final product revision is
`931a8819d1288d4c79957d286282181bd5ae1f02`. Its
[CI](https://github.com/elewa-git/opencrane-new/actions/runs/45555352321) passed.
Its [application](https://github.com/elewa-git/opencrane-new/actions/runs/45555379310)
and [scanner](https://github.com/elewa-git/opencrane-new/actions/runs/45555379303)
approvals had unexpired artifacts when checked.

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

## Exact-head repeat

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
  below six. The corrected packaged restore and restored-chat write refusal
  still need a live check.

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
