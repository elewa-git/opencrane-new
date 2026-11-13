Packaged installations include persistent file storage and a private ClamAV service
for chat attachments. Clean files use the existing upload and chat path; infected
files are refused. The scanner checks approved signature bytes and refuses stale
update evidence. The application receives rotating, short-lived storage credentials.

Storage credential issuance now has a deadline and cancellation. Readiness refuses
expired leases, and STS diagnostics cannot reach errors or logs. Scanner database
validation is shared and refusal tests isolate each size, identity and time bound.
