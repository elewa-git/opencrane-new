# File and image part scanner

For people, read [README.md](README.md) first.

The dev daemon runs ClamAV 1.5.2, based on the immutable upstream image
`clamav/clamav-debian@sha256:24b4b24c303efed21633b29d61096fab4a8a7e158a595149238c7bef7b39873c`.
This is the linux/amd64 manifest from the previously pinned index
`sha256:14e2e0805c6a5ff6728ea591c05565e0f0954d93e8701919012c3a8c44e20674`.
The Dockerfile and CI pre-pull use this manifest to avoid missing mirror
attestations. See the [download details](../../scripts/ci/README.robot.md#test-image-downloads).
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
The server's `scanner.ts` now calls the authenticated HTTPS wrapper. Direct INSTREAM
checks remain in disposable test support and in the wrapper's owned scan operation. The upstream AGPL notice
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
HTTPS, consumers and fresh-install clean/EICAR/two-silo checks remain later work. This record admits no upload.

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
2 GiB memory and 64 processes. A 64 MiB tmpfs at `/tmp` holds ClamAV's temporary
scan files in memory, with no execution or host storage. The root and databases
remain read-only. Container logs are disabled.

`launchScanner` returns `ready()`, `stop()`, `scan(input)` and the unchanged `databaseUpdatedAt`.
Readiness checks freshness before and after a daemon ping. A timer also removes
owned containers at 24 hours; backwards time refuses. Startup has a 15-minute
limit shared by image lookup, creation, inspection, start and the initial ping.
Each Docker call gets only the time remaining; no call starts when none remains.
The initial ping also has a 65-second limit, later pings six seconds and each
container removal its own 30 seconds. Cleanup keeps that separate limit after
startup time runs out. TERM/INT and failure remove only recorded container names.
Unconfirmed removal retains the ownership directory and prevents another attempt;
an operator must confirm those containers are gone before removing it.
Launch errors contain only `Scanner launch refused`. No customer bytes or scan results
are recorded. Fixture evidence cannot qualify live scanning. Fresh reviewed inputs,
HTTPS, issuance, consumers and two-silo qualification remain later.

## Owned scan requests

P5-6a PR 5 adds `scan({ bytes, sha256, byteCount, signal? })`. Bytes must be a Buffer
of at most 20 MiB and match the expected hash and count. The method copies them
before awaiting anything, then hashes and counts the chunks placed in INSTREAM
frames: `zINSTREAM`, 64 KiB chunks with four-byte lengths, and the zero terminator.
Only a fixed `docker exec -i <verified-id> nc 127.0.0.1 3310` sends those frames.
The existing Debian image supplies netcat. No host listener, bind mount, fetch URL or
caller-selected command is added.

Startup records the container ID, image ID, start time and restart count. Every
scan compares that state before and after transfer. The immutable ID also targets
readiness and removal, so replacing a container name cannot redirect a scan.
One 60-second deadline covers both checks and transfer; each wait receives only
its remaining time. Replies are bounded to 4 KiB and must end with exactly one
recognised clean or infected reply. Other replies and process errors refuse with
`Scanner scan refused`; diagnostic output is discarded.

Results contain `verdict`, `sha256`, `byteCount`, `imageDigest`, `manifestDigest`,
`databaseUpdatedAt`, `databases` (file, hash, version and build date), `checkedAt`
and `expiresAt`. All database facts come from startup's verified manifest.
Freshness is checked before and after each process call. Backwards or future time
and a complete update check aged 24 hours refuse. Result expiry is the earlier
of two minutes after checking and database expiry. Returned facts are separate
copies; changing them cannot renew or alter the loaded facts.

Concurrent successful requests use separate buffers and processes. Any failed or
cancelled request retires the whole handle and stops its containers, also refusing
other pending requests. Transport failures retire it when detected, without waiting
for the Docker client's close event. The failed request waits for container cleanup
before rejecting and gives the killed client up to 30 seconds to close. It still
rejects after cleanup finishes if the client never closes.
Killing the Docker client alone cannot prove its remote
process stopped. Cleanup retains its separate limits and ownership record until
removal succeeds. Failed cleanup blocks reuse, including another launch at that
ownership path. Per-request recovery without retiring the daemon is not provided.
These are internal process results, not authenticated HTTP responses or admission
proof. Upload/image consumers and fresh-database qualification remain NOT RUN.

## Authenticated HTTPS uploads

P5-6a PR 6 adds `createScannerService({ scanner, tls, trust, clock? })` in
`service.mjs`. Supply a `launchScanner` handle, TLS key/certificate material from
existing custody, and public trust entries `{ issuer, jwks, services }`.
`services` maps each allowed service to its silo. The existing `verifyScanner`
checks each configured issuer; requests cannot choose keys or change the mapping.
The returned Node HTTPS server starts listening only when its caller starts it.
Node execution needs `--experimental-strip-types` for auth. The launch handle's
new `signal` also refuses pending HTTP transfers when the scanner retires.

The upload route accepts `POST /scan/upload`, with `Expect: 100-continue`,
`Content-Type: application/octet-stream`, `Content-Length` and the standard
`Authorization: Bearer` pass. Metadata headers are `X-Scan-Silo`, `X-Scan-Purpose`
(exactly `upload`), `X-Scan-Request-Id`, `X-Scan-File-Id` (UUIDs) and `X-Scan-Sha256`
(lowercase hex). Unknown/duplicate headers refuse. Identity is checked before
`100 Continue` and file reading. Early bytes cannot bypass verification.
Header receipt, verification, transfer and scanning share 60 seconds after TLS.
TLS handshakes also have a 60-second limit. Headers are at most 8 KiB, files 20 MiB and replies
4 KiB. Connections handle one request. The server admits at most eight TCP connections,
including incomplete TLS handshakes. Node closes excess connections before creating
TLS or HTTP buffers. A shared limit admits two active requests before metadata checks,
pass verification, body collection or scanning. Excess requests receive the fixed
503 refusal without `100 Continue`, body collection or a queue. Each active request
can collect at most 20 MiB; the existing scan operation also copies and frames those
bytes. The reservation lasts until the request finishes, including cancelled scan
cleanup, and is released on success, error, timeout or client abort.
Disconnect cancels scanning and retires
the handle; cleanup retains its separate limits. Refusals are fixed HTTP 503 JSON
`{ "error": "Scanner request refused" }`; malformed HTTP may close the socket.

Responses contain owned scan facts plus `silo`, `purpose`, `requestId` and `fileId`.
Expiry is capped by the pass, database expiry and the scan's two minutes. Pass and
database freshness are checked after transfer and before replying. Callers must
check their configured CA/hostname and match results against unchanged bytes and
the pending request. Retries need fresh ids; copied JSON grants nothing.
No URL, redirect, minting endpoint, queue, store, credential log or clamd port is added.
`scripts/clamav-service.test.mjs` uses real TLS/ES256 and process fixtures for the
existing scan operation. Capacity tests cover transfer and scan saturation, early
bytes on refused requests, reuse after success, authentication error, transfer abort
and transfer timeout, and TCP admission before TLS. Cancelling an active scan still
retires the scanner; releasing capacity does not make a retired scanner reusable.
Production issuance, consumers, fresh clean/EICAR and
two-silo qualification remain NOT RUN. This admits no production upload.

## Upload file identity compatibility

The wrapper accepts the existing lowercase 64-hex upload file id as well as UUIDs.
Request ids still require UUIDs. P5-6b PR 1 connects the upload caller with trusted
silo/file bindings; it changes no image, event or image-worker contract.
The real TLS consumer tests interleave two trusted silos. Their scanner facts are
fixtures; deployed clean/EICAR, entry/rotation and fresh-install checks remain NOT RUN.

## Authenticated image parts

P5-6b PR 2 adds only `POST /scan/image-part`. It shares the loaded scanner,
ES256 verification, two request slots and eight connections with uploads.
Limits remain 20 MiB per part, 60 seconds per request and 4 KiB per response.
Cancelled work holds its slot until scanner cleanup settles. Scanner failure
retires the handle; recovery needs a newly verified scanner and service.

The route requires an `image-worker` pass with `purpose=image`, its mapped silo
and the exact request UUID. The trusted caller supplies a fresh UUID per attempt;
there is no replay store. Upload and computer passes refuse before Continue.
Image passes cannot scan uploads. TLS, Expect, content type, content length and
common metadata headers follow the upload contract above. Image requests replace
`X-Scan-File-Id` with all four required headers below. Unknown or duplicate headers
refuse before Continue, as do malformed or unsupported bindings.

| Header | Accepted value | Response field |
| --- | --- | --- |
| `X-Scan-Server-Id` | 1–200 word characters or hyphens | `serverId` |
| `X-Scan-Attempt-Id` | Positive safe integer, decimal with no leading zero | `attemptId` |
| `X-Scan-Platform` | `linux/amd64` or `linux/arm64` | `platform` |
| `X-Scan-Image-Digest` | Immutable image SHA-256, 64 lowercase hex characters | `targetImageDigest` |

`X-Scan-Sha256` and `Content-Length` describe this part's bytes. The owned scan
checks the bytes fed to INSTREAM. Responses echo these as `sha256` and `byteCount`,
plus `silo`, `purpose`, `requestId` and the four image bindings. The existing
`imageDigest` field still identifies the scanner engine image. All other scan
facts and expiry limits remain unchanged. Results belong to this authenticated
connection and pending request; copied JSON grants nothing.

This proves only one bounded part. The service does not resolve an image, prove
that a part belongs to it, unpack all layers or claim complete coverage. Those
checks and the image consumer remain later work. Unsupported or oversized parts
must refuse there too. Nothing writes `mcp.image_checked` or opens admission.
Signature, vulnerability and licence gates remain independent.

`scripts/clamav-image-service.test.mjs` uses real TLS/ES256 and simulated scanner
processes. Its delayed-cleanup fixture isolates transport capacity; other failure
tests use the owned scan operation and retire the handle. Deployed rotation,
fresh-install clean/EICAR and full image coverage remain NOT RUN.
