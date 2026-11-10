# File access contract

`GET /api/conversations/:conversationId/files` and
`GET /api/conversations/:conversationId/files/view` keep their current membership,
participation, join-position, private-session and file-specific checks after close.
The owner may still read a saved session file. Other participants retain only
their existing screenshot access. A removed or foreign member cannot list or
download private files.

`POST /api/conversations/:conversationId/files` still refuses a closed chat.
The file command reads the chat history, checks for a saved close, then uses one
conditional append to the conversation stream. A close or competing upload
cannot admit a later file record.

`scripts/real-upload-scanner.test.mjs` uses `launchScanner`, the shared HTTPS
service, the current `scanFile` and `uploadFile` functions, and a disposable NATS
event store. It keeps only object keys and sizes in memory. It skips real scan
checks unless `P5_SCANNER_MANIFEST`, `P5_SCANNER_APPROVED_SHA`,
`P5_SCANNER_IMAGE` and `P5_SCANNER_RELEASE` name separately reviewed fresh
inputs. Recovery also needs the corresponding `P5_SCANNER_NEXT_*` inputs with
a different approved manifest hash. The test refuses an old database, a bad
caller, an untrusted TLS connection and an outage before checking recovery.
Run it with a process deadline of 20 minutes. The launcher has its own
15-minute startup limit, and each upload scan has a 60-second limit.

`scanner.ts` requires `SCANNER_MANIFEST_DIGEST` from trusted deployment settings.
It must match the manifest digest in the authenticated reply at first validation
and again before upload admission. Missing or changed values return the typed
scanner 503. The expiry check covers both the reply's deadline and the verified
database's 24-hour deadline. The upload refusal fixture changes one response
binding at a time and holds one reply across the database deadline.
