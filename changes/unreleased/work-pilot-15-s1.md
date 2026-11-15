Packaged installations include persistent file storage and a private ClamAV service
for chat attachments. Clean files use the existing upload and chat path; infected
files are refused. The scanner checks approved signature bytes and refuses stale
update evidence. The application receives rotating, short-lived storage credentials.

Storage credential issuance now has a deadline and cancellation. Readiness refuses
expired leases, and STS diagnostics cannot reach errors or logs. Scanner database
validation is shared and refusal tests isolate each size, identity and time bound.

A scheduled GitHub job now verifies and packages fresh scanner definitions on free
standard runners. Packaged preparation fetches approval from the successful job
for its exact source commit; local candidates cannot approve a scanner. Image
publication supports the existing plain HTTP development registry without changing
Docker settings. Packaged images include the shared scanner database reader and
storage readiness entrypoint needed to start those services.

Scanner configuration preserves its bundled database verification certificates,
and packaged projection workers retain their required scanner import.
