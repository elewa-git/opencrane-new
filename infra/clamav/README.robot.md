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
Each database is at most 512 MiB; the input manifest is at most 8 KiB, tool output
at most 1 MiB and each Docker operation at most 15 minutes. The complete attempt
must also finish within 15 minutes; each container removal has 30 seconds.

After all checks and container removals succeed, the verifier atomically renames
the private attempt directory into place. Its `release.json` is at most 1 KiB and
contains only `formatVersion`, `imageDigest`, `manifestDigest`, `databaseUpdatedAt`
and `inspectedAt`. Errors use the fixed message `Scanner release refused`.
Failed cleanup retains the lock directory and its container names; an operator
confirms those containers are removed before deleting that directory. No later
attempt can reuse it while it remains. Other failures leave no new release record.

The release tests use Docker and tool fixtures, including publication and cleanup
failures and private canaries. These are not real image or live scanner qualification.
Immutable loaded-set startup with no reload, HTTPS, scan expiry, consumers and
fresh-install clean/EICAR/two-silo checks remain later work. This record admits no upload.
