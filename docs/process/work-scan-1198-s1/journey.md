# Scanner refresh on a fresh install

Journey on a fresh dev stack: PASS

## Fresh packaged run on 26 November 2026

Slot 1 was claimed at 19:43 UTC after five minutes with the one-minute load below
six. The package installer created a new namespace and six new volume claims
for commit `bda841ca866b7988797906aff48e99f41c7fc995`. GitHub still had both
approval files and image archives for the three runs at the start of the
install. [Application approval](https://github.com/elewa-git/opencrane-new/actions/runs/45882914633),
[starting scanner approval](https://github.com/elewa-git/opencrane-new/actions/runs/45882919803),
[newer scanner approval](https://github.com/elewa-git/opencrane-new/actions/runs/45883138189).

| Step | Verdict | Observation |
| --- | --- | --- |
| Install a fresh package on slot 1 | PASS | Package preparation, private settings, `package-up --id 1` and `package-check --id 1` passed. Package-up used the documented local swap exception, `OPENCRANE_ACCEPT_DEV_HOST_RISK=accepted-dev-box-366`. |
| Upload a PDF before refreshing the scanner | PASS | Both uploads returned HTTP 201 and showed Ready. [1280 px](screenshots/upload-before-1280.png), [390 px](screenshots/upload-before-390.png). |
| Refresh to a newer approved scanner | PASS | `package-refresh-scanner --id 1` reported that the new scanner was ready. The virus list check moved from 19:21:16 to 19:23:01 UTC. A new Ready scanner pod used the approved image and file hash. The server pod stayed Ready with the same ID. |
| Upload a PDF after refreshing the scanner | PASS | Both uploads returned HTTP 201 and showed Ready. [1280 px](screenshots/upload-after-1280.png), [390 px](screenshots/upload-after-390.png). |
| Refuse a mismatched image | PASS | Passing the starting image with `--image` returned exit 1 and the image mismatch message. The Ready scanner pod, image, deployment generation and approval ConfigMap version stayed the same. |
| Release slot 1 | PASS | `package-down --id 1` and `down.sh --id 1` exited 0. `status.sh --id 1` reported free at 19:53 UTC. |

The [result](result.json) records the approval run IDs, exact image digests and
file hashes, new volume claims and scanner observations. Startup logs, 18 service
logs and package events were kept privately before teardown.
`refresh-mismatched-failure.log` records the expected refusal.

## Source checks

- PASS for 83 focused tests in each of two runs, 682 package and claim tests,
  five image publication tests and 87 tests that use the packaged fixture.
  Before the fix, the regression test received an empty Kubernetes result
  for `release.json`. The same lookup worked with the escaped dot in a local
  `kubectl` client check.
- PASS for typecheck, the event catalogue, Knip, changed-file ESLint, changelog,
  Markdown and the public privacy and secret scans.
- FAIL for one test on the verified commit in GitHub CI. The routine handoff
  test reported that it could not append `computer.turn_started`. The package
  checks and the other three shards passed. [CI run](https://github.com/elewa-git/opencrane-new/actions/runs/45882894652).

## Earlier run

The first packaged run on `ac8f8861a` accepted uploads at both widths and refused
a mismatched image. The refresh failed before rollout because JavaScript removed
the escape for the dot in `release.json`. Kubernetes returned zero bytes.
The post-refresh uploads were NOT RUN. The regression test now checks the real
key name, and the refresh sends the literal backslash to Kubernetes.
