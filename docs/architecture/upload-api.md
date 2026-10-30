# Conversation uploads

P2-6: the workspace attach menu sends one file at a time with progress, refusal reasons and retry. Attachments replay in the transcript and session panel.

## HTTP interface

Both operations use the member's existing session cookie. They require current
OpenFGA membership and conversation permission, and the event stream must show an
open `agent_session` created by that member. Other members' conversations and
other organisations are refused for ordinary uploads, including when a participant
has read access. P3-18 screenshots are the exception: current participants can
list and reopen screenshot files, and capture also requires a shared-desktop grant.

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
| 413 | request exceeds 20 MiB: `{status:"refused", error:"File too large. Maximum size is 20 MiB."}` |
| 415 | unsupported or mismatched content/filename; unsafe Office container |
| 422 | `{status:"infected", error:"File rejected: malware detected", fileId}` |
| 500 | unexpected failure or invalid scanner response: `{status:"failed", error:"Unexpected failure"}` |
| 503 | confirmed storage, scanner or event-store outage; no clean verdict is assumed |

Inspection refusals add a fixed `reason` to the existing response, for example
`{status:"refused", error:"Unsupported or unsafe file content", reason:"macros"}`.
The codes are `unsupported_type`, `content_mismatch`, `macros`, `embedded_object`,
`external_link`, `encrypted`, `too_large`, `too_many_parts`, `invalid_file` and
`unsafe_name`. An unsafe upload basename keeps HTTP 400 and adds `unsafe_name`;
inspection refusals keep HTTP 415. `too_large` covers document inspection limits,
including unpacked size and oversized XML parts. Worker failures without a specific
rule return `invalid_file`. HTTP 413 and rate-limit responses are unchanged.
The refused request log includes only the fixed reason alongside ordinary request
facts, never file names, document part names, bytes or parser errors.

Files refusals carry their kind and HTTP status where detected, including
`invalid_request` (400) for an empty body or malformed command input. Connection
refusal, timeout and a dependency's own unavailable status carry a typed 503.
Unexpected errors stay distinct and expose only the stable 500 response above.

Accepted: PDF; DOC/DOCX, XLS/XLSX and PPT/PPTX; UTF-8 TXT/MD/CSV/JSON; PNG, JPEG,
GIF, WebP, BMP and TIFF. Signatures, binary Office streams and Office ZIP entries
are inspected; HTTP MIME claims are ignored. Executables, scripts, SVG/HTML,
archives and macro-bearing or encrypted Office content are refused. Office files may
contain checked embedded XLSX chart workbooks, printer settings and HTTP, HTTPS or
mailto hyperlinks. Other embedded files and external relationships remain refused.
Embedded workbooks may not embed further workbooks. All parts share the 2,000-part
and 80 MiB unpacked limits. All
inspection (including CFB, ZIP and XML) runs in a separate worker with a
five-second startup deadline, a separate 1.5-second inspection deadline, a 64 MiB old-generation heap limit, a 16 MiB
young-generation limit and a 4 MiB stack limit. A timeout, worker error or limit
terminates the worker and gives a clear 415 refusal. Office
containers also have entry and expanded-size limits; ClamAV also refuses scan limits
and encrypted content. This is type and malware screening, not a guarantee that a
third-party document parser will accept every damaged document.

`GET /api/conversations/:conversationId/files` returns `{rows:[...]}` from the
replayable projection. A row has `conversationId`, `fileId`, `uploadedBy`, `name`,
`mime`, integer `size` in bytes, `sha256`, `status` (`uploaded` or `delivered`) and
`path` relative to `/workspace`. A PDF also has `textPath` for its MarkItDown text.
Rejected and unscanned uploads never appear. While the files projection has not
applied the conversation's latest saved upload, GET returns HTTP 425 with
`{status:"applying"}` instead of a partial list. Clients retry this read briefly.
The website checks this list after POST succeeds, before showing Ready.
Poll until `delivered` before posting a request that
mentions the file, and include its `path`/`textPath` in the message. Original and
converted PDF paths are ready for the later file-view/preview integration.

`GET /api/conversations/:conversationId/files/view?path=<listed path>` downloads
only an original named by a committed `file.uploaded` event. `&preview=true`
uses inline disposition. The same session and current membership checks apply;
ordinary uploads require ownership, while screenshots require current participation;
arbitrary workspace paths and rejected files return 404. Bytes come from the
server's promoted MinIO object, never from the computer. Responses use the inspected
MIME, `nosniff` and private/no-store caching. The existing Open Terminal-style modal
renders PDF, text and browser-supported images; other formats offer a download.

The composer waits for delivery before sending. The bridge adds each attachment’s
workspace path and its PDF MarkItDown text path (or original plain-text path)
without changing the stored user message or its length limit. It reads at most
32 KiB of text across the turn’s attachments through the isolated tools executor
and marks the JSON content as untrusted document data, never instructions.
Missing text and truncation are explicit; local tools can read more. Images have
no converted text path. Only uploads recorded before the message are included,
with the newest 100 attachment entries per turn and an explicit count of older
entries omitted from context. Retrying an upload
retains its key and bytes on the page; reloading discards an uncommitted selection.

## Screenshot capture

`POST /api/conversations/:conversationId/screenshots` uses the session cookie,
exact configured Origin, `X-OpenCrane-View: 1` and a stable `Idempotency-Key`.
It takes no body or arbitrary URL/path/dimensions. Current participants also need
the shared-desktop audience grant. Capture uses one non-incremental framebuffer
request over the authenticated desktop proxy and fixed PNG encoding. The existing
inspection/scanner and 20 MiB file limit apply. The desktop transport limits raw
pixels to 4 MiB, each dimension to 4096, capture to ten seconds, and each server
to four concurrent captures. Current access and generation are rechecked before
promotion and conditional append.

A `file.uploaded` screenshot includes `screenshot: {computerId, generation,
capturedAt, width, height}` with the existing author, conversation, MIME, byte size
and SHA-256. Its list row includes that metadata without an object key. Reload
and projection replay restore the PNG; no replay repeats capture or scanning.
Participants get screenshot-only lists in conversations they did not create.
Removing a participant/member or expiring the session refuses a previously usable
preview/download URL. There is no public or signed object-store/Kasm URL.

Success returns 201 with `{status:"appended", fileId, sequence}`. Capture access
and input failures return 400/401/403; scan rejection returns 422, append contention
409, and unavailable capture, scanner, storage or capacity returns 503. An uncertain
reply is retried with the same key; an infected verdict is terminal for that key,
and a new explicit capture uses a new key. No failure appears as a saved file.
[Evidence](../process/p3-18-screenshots.md) separates fixture qualification from a
fresh deployed silo. No continuous recording or automatic collection is implemented.

## Flow and recovery

The HTTP module checks identity, ownership, size and content, then submits the
bounded in-memory bytes to clamd. Nothing is written to object storage before a
clean verdict. A clean verdict writes an immutable promoted object before invoking
the upload command. An infected verdict invokes the rejection command without
storing bytes. Each command makes one conditional append to the conversation stream.
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
end change. Office rendering is not included.
