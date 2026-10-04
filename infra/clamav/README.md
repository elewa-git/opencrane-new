# Upload scanner

The dev daemon runs ClamAV 1.5.2, based on the immutable upstream image
`clamav/clamav-debian@sha256:14e2e0805c6a5ff6728ea591c05565e0f0954d93e8701919012c3a8c44e20674`.
Its bundled databases are main 63, daily 28046 and bytecode 339. Startup runs
`clamd` directly: no FreshClam, entrypoint download or network access is needed.
The digest pins both the engine and offline signatures. Our Dockerfile removes
the non-OSI `libclamunrar` and `libclamunrar_iface` plug-ins, then copies the
remaining filesystem into a scratch stage so their bytes are absent from every
shipped layer. Tests build that same Dockerfile and config in disposable containers.
RAR scanning is unavailable; the API already refuses archives. See the
[reviewed image licences](LICENCES.md). Quarantine expires abandoned objects after
one day; normal completion deletes them immediately.

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

## Licences

| Added runtime component | Licence | Source |
| --- | --- | --- |
| ClamAV 1.5.2 | GPL-2.0 (OSI-approved) | [ClamAV COPYING](https://github.com/Cisco-Talos/clamav/blob/clamav-1.5.2/COPYING) |
| Copied OpenCrane 1 scanner | AGPL-3.0-or-later (OSI-approved) | `upstream/LICENCE`, commit 10abd0ef6 |
| MinIO JS client 8.0.7 | Apache-2.0 | installed package `LICENSE`; version/integrity in the lockfile |
| file-type 21.3.4 | MIT | installed package `license`; content signatures rather than filename trust |
| yauzl 3.4.0 | MIT | installed package `LICENSE`; bounded Office ZIP inspection |
| cfb 1.2.2 | Apache-2.0 | installed package `LICENSE`; legacy Office stream inspection |
| fast-xml-parser 5.11.2 | MIT | installed package `LICENSE`; decoded Office metadata inspection |

The daemon image uses Debian main. MinIO's existing pinned server is AGPL-3.0.
No licence exceptions, provider SDK, runtime data package or new computer-image
package is added. MarkItDown already exists in the reviewed computer image.
