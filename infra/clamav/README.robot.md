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
updates a separate candidate using the pinned engine and writes its SHA-256
manifest. Review that candidate, package it in an offline image, then change the
image digest here, in compose and in the test fixture together. Re-run EICAR and
clean-file qualification before deployment. The script never changes the shared
dev stack or the signatures of a running daemon. Keep the previous digest for
rollback. Cached image layers keep a pinned deployment independent of the CDN.
