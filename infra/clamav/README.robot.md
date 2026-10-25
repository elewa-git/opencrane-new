# Upload scanner

For people, read [README.md](README.md) first.

The dev daemon runs ClamAV 1.5.2, based on the immutable upstream image
`clamav/clamav-debian@sha256:14e2e0805c6a5ff6728ea591c05565e0f0954d93e8701919012c3a8c44e20674`.
Its bundled databases are main 63, daily 28046 and bytecode 339. Startup runs
`clamd` directly: no FreshClam, entrypoint download or network access is needed.
The digest pins both the engine and offline signatures. Our Dockerfile removes
the non-OSI `libclamunrar` and `libclamunrar_iface` plug-ins, then copies the
remaining filesystem into a scratch stage so their bytes are absent from every
shipped layer. Tests build that same Dockerfile and config in disposable containers.
The daemon image uses Debian main. RAR scanning is unavailable because the
plug-ins needed for it have a licence that is not open source. See the
[reviewed image licences](LICENCES.md). The server scans upload bytes in memory and
saves only clean files in the `files` bucket. The dev stack creates a `quarantine` bucket with one-day expiry, but current
uploads do not use it.

`upstream/clamscan.ts` is copied unchanged from
[OpenCrane 1 commit 10abd0ef6](https://github.com/elewa-git/opencrane/blob/10abd0ef6/libs/backend/artifacts/scanner/main/src/clamscan.ts).
That scanner uses shell-free execution, bounded time and fail-closed verdicts.
The server's `scanner.ts` adapts those rules to clamd's INSTREAM protocol, sending
every byte and accepting only an explicit clean verdict. The upstream AGPL notice
is retained in `upstream/LICENCE`; no OpenCrane 1 contracts or other runtime code
are imported.

## Refresh on the dev box

Run `infra/clamav/refresh.sh /absolute/scratch/candidate-signatures`. FreshClam
updates a separate candidate using the pinned engine and writes `signatures.json`.
Review that candidate, package it in an offline image, then change the image digest here, in compose and in the test fixture together. Re-run EICAR and
clean-file qualification before deployment. The script never changes the shared
dev stack or the signatures of a running daemon. Keep the previous digest for
rollback. Cached image layers keep a pinned deployment independent of the CDN.

## Candidate update evidence

`refresh.sh` invokes the adjacent Node 22 helper. It runs FreshClam from the pinned
image against the complete main/daily/bytecode set, using a fixed configuration
with database testing and bytecode enabled. No caller-provided success or old log
is read. The helper requires a successful process exit and one matching upstream
update result per database. It then requires successful `sigtool --info`
verification, matches each version, and compares SHA-256 before and after that
verification with a streamed hash of the actual candidate file.

The JSON has `formatVersion: 1`, `toolImage`, `databaseUpdatedAt`, `databases` and
`updaterEvidence`. Each database has `file`, `sha256`, `version` and `builtAt`.
The safe updater evidence records FreshClam's successful exit and each database's
file, version and `updated` or `up-to-date` result. Raw tool output is discarded.
Dates are stored in UTC. Build dates come from the pinned tool's metadata, with
its numeric timezone offset converted to UTC. Impossible, unknown or future dates
refuse. The build date must match the numeric timestamp that `sigtool` verifies
against the database's internal record; the stored date keeps its seconds.
The update-check time comes from this invocation
after the whole check succeeds, never file mtimes or the bundled image's age.

The helper accepts exactly one CVD or CLD file for each database. It refuses
missing, duplicate, symbolic-link or altered databases. Each file is at most
512 MiB, captured tool output at most 1 MiB, and the manifest at most 8 KiB.
The update and verification have a 15-minute limit; container cleanup has a
30-second limit. The candidate directory must be private to the packaging job.
A directory lock prevents concurrent helper runs. If the Docker client fails,
the helper attempts to remove its container. Failed cleanup keeps the lock and
blocks later attempts because the updater may still be writing candidate files.
After failed cleanup or an interrupted run, the operator confirms its updater
container has stopped before removing a leftover
`.refresh-lock` directory. Starting another attempt removes both the old JSON
manifest and the former `signatures.sha256` before running the updater. The new
JSON is renamed into place only after every check passes.

P5-6a PR 2 covers candidate evidence only. Copying this JSON never makes it trusted or newer.
Tests in `scripts/clamav-refresh.test.mjs` use temporary files and updater fixtures;
they are not live upstream, clean/EICAR or two-silo qualification.
The Docker fixture also checks that failed container cleanup blocks a retry and
successful cleanup allows one. It does not induce a real Docker connection failure.

## Packaging evidence

P5-6a PR 3 builds on PR 2's squash commit
`b88276a8d76c8f8ce15613fad1012b77b82fdfed`. The trusted packaging job supplies a
reviewed candidate manifest, its separately approved SHA-256 (64 lowercase hex
characters) and a reviewed scanner image reference ending in `@sha256:…`.
The approval must come from the job's review inputs, not a hash supplied alongside
untrusted JSON. The image review still includes flattened UnRAR removal and the
licence checks; database inspection does not replace either check.

```sh
node infra/clamav/release.mjs /private/job/signatures.json "$APPROVED_MANIFEST_SHA256" \
  "$REVIEWED_SCANNER_IMAGE" /private/job/new-release
```

The parent directory is private to the packaging job. The destination is a new,
absolute directory, on the same filesystem as its sibling `new-release.lock`.
Keep earlier records in separate directories. The verifier refuses mutable tags
and host paths as image references. Docker must already have both digest-selected
images; pulls are disabled. It creates a scanner container without starting it,
checks its resolved image identity and copies `/var/lib/clamav` from that container.
That directory must contain only main, daily and bytecode, each as one regular
CVD or CLD file. A second, network-disabled container uses the existing pinned
tools with a read-only copy of those files. No host database input is accepted.

The verifier reuses the updater's hash, version and build-time checks. It compares
the results with the approved manifest and requires successful upstream evidence
for all three databases. It refuses future dates and update checks older than
24 hours, including checks that expire during inspection. Old build dates are
allowed. Copies, mtimes and restarts never change the approved update-check time.
Each database is at most 512 MiB; the input manifest is at most 8 KiB and tool output
at most 1 MiB. Each Docker operation gets only the time remaining from one
15-minute allowance. No inspection operation starts once that time runs out.
The complete attempt must finish within 15 minutes; each container removal has
its own 30-second limit, even after the inspection allowance runs out.

After all checks and container removals succeed, the verifier atomically renames
the private attempt directory into place. Its `release.json` is at most 1 KiB and
contains only `formatVersion`, `imageDigest`, `manifestDigest`, `databaseUpdatedAt`
and `inspectedAt`. Errors use the fixed message `Scanner release refused`.
Failed cleanup retains the lock directory and its container names; an operator
confirms those containers are removed before deleting that directory. No later
attempt can reuse it while it remains. Other failures leave no new release record.

The release tests use Docker and tool fixtures, including publication and cleanup
failures and private canaries. These are not real image or live scanner qualification.
HTTPS, scan expiry, consumers and fresh-install clean/EICAR/two-silo checks remain
later work. This record admits no upload.

## Verified database launch

P5-6a PR 4 adds `launch.mjs`, separate from the current upload scanner.
The trusted job supplies the approved image reference, independent manifest hash,
manifest and matching `release.json`. These inputs carry the same review trust as
packaging; the launcher does not verify cryptographic signatures. Image approval
still includes UnRAR removal and the licence checks.

```sh
node infra/clamav/launch.mjs /private/job/signatures.json "$APPROVED_MANIFEST_SHA256" \
  "$REVIEWED_SCANNER_IMAGE" /private/job/release.json /private/job/scanner-owner
```

The ownership directory must be new, absolute and under a private parent. The
launcher reuses release inspection against its own container, then checks hashes,
regular files and the exact file count again inside the read-only running container
before starting clamd. No database mount is accepted, including image-declared
volumes. The daemon runs as `clamav`, with no capabilities, network access or host
port. Its TCP listener is container-local loopback. Automatic reload is disabled;
the launcher exposes no reload operation. FreshClam never runs. Limits are one CPU,
2 GiB memory and 64 processes. Container logs are disabled.

`launchScanner` returns `ready()`, `stop()` and the unchanged `databaseUpdatedAt`.
Readiness checks freshness before and after a daemon ping. A timer also removes
owned containers at 24 hours; backwards time refuses. Startup has a 15-minute
limit shared by image lookup, creation, inspection, start and the initial ping.
Each Docker call gets only the time remaining; no call starts when none remains.
The initial ping also has a 65-second limit, later pings six seconds and each
container removal its own 30 seconds. Cleanup keeps that separate limit after
startup time runs out. TERM/INT and failure remove only recorded container names.
Unconfirmed removal retains the ownership directory and prevents another attempt;
an operator must confirm those containers are gone before removing it.
Errors contain only `Scanner launch refused`. No customer bytes or scan results
are recorded. Fixture evidence cannot qualify live scanning. Fresh reviewed inputs,
HTTPS, issuance, per-scan expiry, consumers and two-silo qualification remain later.
