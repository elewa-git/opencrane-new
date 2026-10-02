# Conversation uploads

P2-6 back end, for the attach menu after P2-5 lands. No UI is included here.

## HTTP interface

Both operations use the member's existing session cookie. They require current
OpenFGA membership and conversation permission, and the event stream must show an
open `agent_session` created by that member. Other members' conversations and
other organisations are refused, including when a participant has read access.

`POST /api/conversations/:conversationId/files` takes one raw file:

| Header | Value |
| --- | --- |
| `Content-Type` | `application/octet-stream` |
| `Origin` | the app origin, as for chat commands |
| `X-File-Name` | original basename; 1–120 ASCII letters/digits/underscore, spaces, dots, parentheses or hyphens; first character must be a letter/digit/underscore |
| `Idempotency-Key` | caller-generated id; 1–200 letters/digits/underscore/hyphen |

The body is the original bytes, between 1 byte and **20 MiB**. No multipart form,
MinIO URL, object key or storage credential is exposed. Use a new key for each
attachment; retry the same key, filename and bytes after a lost reply or 409/503.
Changing an already committed upload under its key returns 409. Retries of a
committed upload do not repeat scanning or create another event.

| Status | Meaning / response |
| --- | --- |
| 201 | scan passed, object promoted and event committed: `{status:"appended", fileId, sequence}`; delivery is pending |
| 400 | missing/invalid headers, unsafe basename or empty body |
| 401 / 403 | missing session / membership, origin or conversation refused |
| 409 | event-stream contention or key reused for another file |
| 413 | request exceeds 20 MiB |
| 415 | unsupported or mismatched content/filename; unsafe Office container |
| 422 | `{status:"infected", error:"File rejected: malware detected", fileId}` |
| 503 | storage, scanner, authorisation or event store unavailable; no clean verdict is assumed |

Accepted: PDF; DOC/DOCX, XLS/XLSX and PPT/PPTX; UTF-8 TXT/MD/CSV/JSON; PNG, JPEG,
GIF, WebP, BMP and TIFF. Signatures, binary Office streams and Office ZIP entries
are inspected; HTTP MIME claims are ignored. Executables, scripts, SVG/HTML,
archives, macro-bearing/encrypted/embedded Office content are refused. All
inspection (including CFB, ZIP and XML) runs in a separate worker with a
1.5-second hard deadline, a 64 MiB old-generation heap limit, a 16 MiB
young-generation limit and a 4 MiB stack limit. A timeout, worker error or limit
terminates the worker and gives a clear 415 refusal. Office
containers also have entry and expanded-size limits; ClamAV also refuses scan limits
and encrypted content. This is type and malware screening, not a guarantee that a
third-party document parser will accept every damaged document.

`GET /api/conversations/:conversationId/files` returns `{rows:[...]}` from the
replayable projection. A row has `conversationId`, `fileId`, `uploadedBy`, `name`,
`mime`, integer `size` in bytes, `sha256`, `status` (`uploaded` or `delivered`) and
`path` relative to `/workspace`. A PDF also has `textPath` for its MarkItDown text.
Rejected and quarantined uploads never appear. The list may lag the POST until
the projection catches up. Poll until `delivered` before posting a request that
mentions the file, and include its `path`/`textPath` in the message. Original and
converted PDF paths are ready for the later file-view/preview integration.

## Flow and recovery

The HTTP module checks identity, ownership, size and content, writes a unique
quarantine object, then submits the complete bytes to clamd. On a clean verdict
it writes an immutable promoted object before invoking the upload command. An
infected verdict invokes the rejection command. Each command makes one conditional
append to the conversation stream. Quarantine is deleted on success or failure;
the bucket's one-day lifecycle removes abandoned uploads after a process crash.
An orphan promoted object after an ambiguous append is private and cannot be
listed or delivered without `file.uploaded`; retention cleanup is a later task.

The bridge watcher reads committed `file.uploaded` events, wakes a suspended
computer for pending work and sends original bytes in 64 KiB frames. It serialises
file transfers per connection and waits for a matching digest acknowledgement
before starting a chat turn. The computer checks byte count and SHA-256, then
uses its existing socket-denied tools executor (UID 1001) to write the file.
Directory descriptors and no-follow opens prevent symlink path escapes. Atomic
publication without replacement and fsync protect the saved disk;
repeating unchanged content keeps its mtime. Existing files with differing bytes
are kept and the conflicting upload is skipped, including converted PDF text
and a file created during delivery. PDFs are converted through MarkItDown inside
that same sandbox before
acknowledgement; conversion failure leaves delivery pending.

The acknowledgement invokes a separate `file.delivered` command. A server crash
before that append or a disconnected transfer retries the original event. New
connections check the recorded acknowledgement for that computer and send
only undelivered files. A retry before the event is committed preserves existing
edits. The acknowledgement reports `saved` or `kept_existing`; `file.delivered`
records that outcome and the HTTP list exposes it as `deliveryOutcome`.
`kept_existing` means existing workspace edits were kept and conflicting upload
files were skipped; those paths contain the member's content. Older events
without an outcome mean `saved`. Completed uploads alone do not wake an idle
computer repeatedly. The computer has no MinIO access, URL or credential.

The dev stack starts the `files` projection worker, provisions private MinIO
buckets and supplies only the server with a rotating 15-minute bucket-scoped STS lease
through a file reference. Root credentials stay in the dev-box secret directory;
its local issuer refreshes the lease atomically every five minutes. Expired or
overlong leases fail closed; the application reloads the lease for each request. See
[the scanner notes](../../infra/clamav/README.md) for the source copy, licences,
offline engine/database pin and dev-box refresh procedure.

## Qualification

[Upload evidence](../process/upload-evidence.md) records the repeatable service
checks and remaining fresh-install journey. Office-to-PDF rendering/LibreOffice,
image-size and Pod-ready measurements for that preview work are outside this back
end change. No rendered-preview endpoint or attach menu is introduced.
