# First computer start on a fresh package

**FAIL.** Neither width met the 20-second limit from package readiness.
The desktop message reached the computer within 20 seconds of Send.
The mobile message took 42.1 seconds after Send. Both first replies used
the image already on the node, with zero time spent downloading it.

The tested commit was `16a820345e9e12a29244fe7236429be3d48d0f10`.
[CI](https://github.com/elewa-git/opencrane-new/actions/runs/45786771180),
[application approval](https://github.com/elewa-git/opencrane-new/actions/runs/45786776284)
and [scanner approval](https://github.com/elewa-git/opencrane-new/actions/runs/45786777128)
passed for that commit. Both approvals had their artifacts when the run started.

## Browser steps

1. Waited for slot 1 to be free and for the one-minute load to stay below six
   for five minutes before each claim.
2. Prepared an empty package, used the recorded `accepted-dev-box-366` host
   exception and ran the installer. Kubernetes recorded the image Job
   completing before the installer reported ready.
3. Signed in as the test owner and invited a separate ordinary member through
   People & groups. The member signed in, accepted the invitation and opened
   the workspace at the chosen width.
4. Sent the member's first message and waited for the free stand-in reply.
   The package recorded the moment the computer reported that it started
   the turn. An unsigned read of the chat history returned HTTP 401.

The first 390 px attempt reached invitation acceptance. The workspace read
then returned HTTP 403, 0.6 seconds after acceptance, and showed
“You no longer have access.” That attempt produced no message timing.
[First mobile attempt](browser-failure-390.png).

A new 390 px install opened the workspace on the first read and completed the
reply. During this run the one-minute load rose above 30, after the five-minute
load check passed and the slot was claimed.

## Timings

| Step | 1280 px | 390 px |
| --- | ---: | ---: |
| Package ready to turn start | 55.1 s | 108.0 s |
| Send to turn start | 18.4 s | 42.1 s |
| Send to first visible reply | 22.3 s | 48.1 s |
| Accept invitation to computer claim | 1.9 s | 2.8 s |
| Claim to disk bound | 5.0 s | 6.0 s |
| Disk bound to image available | 1.0 s | 3.0 s |
| Image download | 0 s | 0 s |
| Image available to container started | 0.0 s | 1.0 s |
| Container started to computer ready | 4.0 s | 20.0 s |

- [Desktop reply](first-reply-1280.png) and [desktop timings](timings-1280.json).
- [Mobile reply](first-reply-390.png) and [mobile timings](timings-390.json).

## What the timings measure

The install-ready clock starts when `package-up` returns successfully. It
includes opening the browser, signing in and joining the installation.
The Send clock starts at the button click. Both stop at the saved report
from the computer that the turn started. Kubernetes reports some startup
steps to the nearest second.

The node already had the reviewed image during the install and again when
the member's computer needed it. The package used the free stand-in, with zero
paid calls. The live run of an in-place update to a different approved image
is **NOT RUN**. Helm render tests exercise the upgrade with a different
digest. The approved packages available for these runs share the same
computer digest.

## Installer refusal and cleanup

- **PASS in the installer test.** The simulated pull Job failed. The installer
  reported the computer image pull failure and stopped before gateway setup
  and readiness checks. It recorded ownership so cleanup could remove the
  failed release.
- **NOT RUN live.** Other work held slot 1 and the host did not provide five
  minutes below the load limit before the admission wait ended. The refusal
  check made no claim.
- **PASS cleanup.** The three browser installations were removed and slot 1
  was released after each. The screenshots and startup and service logs were
  saved before teardown. The private logs include `package-up.log`,
  `events.log`, `deployment-server.log` and `deployment-worker-computers.log`.

## Local checks

The first test commit, `05537ac66`, failed for the missing install and
upgrade Jobs and the generic install error. The local chart and installer
suite passed twice with 609 tests. All 276 chart tests passed with Helm 4.
The 19 NATS route tests passed when run on a quieter host after eight
fixtures hit their existing deadlines in the first supplementary run.

Typecheck, the event catalogue, Knip, package licences, changelog,
README checks, Markdown lint, privacy and secret scans passed. Scoped
ESLint reported that the repository excludes the changed infrastructure
files.
