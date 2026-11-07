# Native Codex in the qualification image

7 November 2026. Part of #97. Branch `work/p4-15-pr5v`.

The deployment image build now takes Codex 0.159.2 from the existing integrity-checked
npm lockfile. It checks the executable and launcher before copying them, and copies
only the four production computer helpers used by the native check. The running
check makes no network or model call. The image still keeps its read-only filesystem
and requires private tmpfs homes and scratch space for the check. The native check
also refuses `/run` on persistent storage.

The test-first commit `5fcd9b797` removed the auxiliary native files from the
fixture image. Its targeted run returned FAIL / journey_failed against the old
package image. This is the expected failing-first result, not live qualification.

The saved image inventory in `infra/package/native-runtime-inventory.json` records
all newly copied application files and their reviewed OSI licences. The existing
package promotion review still names the earlier image and grants no approval to
this new build. A fresh full scan, immutable digest review and fresh-install journey
remain required. Admission stays disabled. The known container-only protection
cannot qualify other processes.

The locally built image from source `f47581d85768da96cfebeceaf024f78b2256a374`
has Docker digest `sha256:d93ecf8ea0941acc11e342ea6bbf5a1d79e447ef58375b2af8939d367ab9ee95`.
This is a local inspection identity, not a promoted deployment pin.

The archive test found a pre-existing clean-context packaging conflict. Bootstrap
imports `libs/event-store/test/certificates.ts`, but `.dockerignore` excludes the
`test` directory. The recursive bootstrap import check and its synthetic startup
therefore fail. This PR preserves the requested test-file exclusion. The new native
hash, launcher, imports, one-layer and absence checks all pass. The package archive
suite is FAIL until the bootstrap dependency is moved into production source.

## Own checks

| Check | Result | Observation |
| --- | --- | --- |
| Main update, dependencies and local tools | PASS | Fast-forward, npm ci and both tool links completed. |
| Failing-first image test | PASS | Old package returned FAIL / journey_failed for pinned native start. |
| Final image build and layer inventory | PARTIAL | Final local build and five native/layer checks pass twice; full archive suite has two bootstrap failures among 11 checks. |
| Changed tests twice and security rules | PASS | The complete native image suite passed 46 cases twice; security rules passed 460 once. |
| Lint, typecheck, events, Knip and changelog | PASS | All exited zero. Qualification TypeScript and focused ESLint also passed. |
| Package licence fixtures | PASS | All 77 existing licence checks passed. |
| Fresh-install private memory journey | NOT RUN | No dev stack or paid model call in this change. |
| Pushed-head ci-ok | NOT RUN | Record after the draft PR and CI. |

Tests and builds ran under `nice -n 10`. No root suite, dev stack, image promotion
or paid model call ran. The image's new native runtime does not enable admission.
