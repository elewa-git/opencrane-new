# Scanner refresh on a fresh install

Journey on a fresh dev stack: PARTIAL

## Fresh packaged run on 26 November 2026

Two fresh slot-1 Helm installs used product commit `7acb49a90b2146381a0bc98ae2641ccf7cd473d0`.
Each started after five minutes below the one-minute load limit. Both created
a fresh namespace and claims. Package-up used the documented local swap exception
`OPENCRANE_ACCEPT_DEV_HOST_RISK=accepted-dev-box-366`. The approved artifacts
were still available at installation.
[Application approval](https://github.com/elewa-git/opencrane-new/actions/runs/45904823967),
[starting scanner](https://github.com/elewa-git/opencrane-new/actions/runs/45904824008),
[replacement scanner](https://github.com/elewa-git/opencrane-new/actions/runs/45904989776).

| Step | Verdict | Observation |
| --- | --- | --- |
| Fresh package and upload before refresh | PASS | Both browser widths returned HTTP 201 and showed Ready on the source under test. [1280 px](screenshots/upload-before-1280.png), [390 px](screenshots/upload-before-390.png). |
| Refuse a mismatched image | PASS | The command exited 1 and left the Ready scanner, its generation and the approval file version in place. |
| Interrupt and recover a replacement | PARTIAL | The replacement reached the Kubernetes rollout wait. The host rejected the test signal command. A separate host test confirmed the systemd stop command works. |
| Refuse uploads during a scanner outage | NOT RUN | This step follows interruption recovery. The 24-hour expiry and upload refusals passed in source tests. |
| Refresh from the host timer | NOT RUN | The host timer started a disposable service and reported its exit status in a separate test. The timed refresh of the installed package was not reached. |
| Upload after the timer refresh | NOT RUN | This step follows the timed refresh. |
| Refuse a superseded rollout | NOT RUN | The superseding-race fixtures passed in source tests. |
| Tear down | PASS | Logs were saved before package-down and down. Both attempts left slot 1 free. |

The first test stopped after counting a server pod that was shutting down after
startup. The repeat checked the Ready server and the scanner’s generation and
approval file version. It reached the rollout and stopped when the host rejected
the signal command. The startup and service logs from both attempts were kept
privately. The other pilot slot was excluded throughout.

The host did not stay below the load limit for another five minutes in time to
start and tear down a fresh package within the two-hour window.

## Source checks

- Both runs passed 167 focused Vitest tests and 437 package and claim tests.
  The strengthened scanner suite also passed twice. Altering 29 guards or file
  mappings made the matching assertions fail.
- Typecheck, the event catalogue, Knip, changed-file ESLint, Markdown,
  changelog, public privacy and the secret scan passed. The repository ESLint
  configuration excludes infrastructure files. Infrastructure syntax and package
  tests ran separately.
- GitHub CI passed lint and all four test shards on the source and test tip.
  [CI run](https://github.com/elewa-git/opencrane-new/actions/runs/45905920126).

## Earlier manual journey

The original manual journey passed on product commit `bda841ca8`. It proved
uploads before and after a manual scanner replacement and a mismatched pin
refusal. The browser screenshots for its successful post-refresh uploads are
[1280 px](screenshots/upload-after-1280.png) and [390 px](screenshots/upload-after-390.png).
