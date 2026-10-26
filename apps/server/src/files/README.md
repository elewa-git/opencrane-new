# Files

This folder handles files people attach to conversations. It checks the file's contents, scans for malware and stores clean files so people and the assistant can use them.

## What it is responsible for

- Checks the signed-in member, current conversation access and the website making a write.
- Checks file names and supported document, image and text formats against their contents.
- Runs document inspection separately with time and memory limits, so an unsafe file cannot stall the server.
- Scans bytes before saving them in [MinIO](../../../../GLOSSARY.md#minio-file-storage), the file store.
- Saves upload or rejection records, and recognises a repeated upload without saving it twice.
- Lists and serves files only within the person's current conversation access.
- Sends clean files to the assistant's computer and waits for its confirmation before that chat's next turn.

A file waits in server memory while [ClamAV](../../../../GLOSSARY.md#clamav-virus-scanner) scans it. Only a clean file reaches the files bucket; an infected file receives a rejection. File access follows the latest join, so a later participant cannot fetch older attachments. A later invitation alone does not undo a saved removal. Replies tell browsers and caches not to store private results.

File lists use the saved read tables before checking newer events. They return a waiting response while the file table catches up with a saved upload. The website checks again before showing the upload as Ready. Other chat activity does not hold up the list, and old messages do not need to be replayed.

Delivery sends each file once per computer connection and waits for its receipt, meaning confirmation of arrival. Reconnection can try delivery again. Waiting for a receipt leaves spending stops and approval checks available. Saved control intent holds files that have not started transmission; one already being sent can finish.

Storage requests have a time limit. Backup callers can cancel an active request,
including one waiting for headers. Every reply except an expected file download has a size
limit before the storage library reads it, including unexpected success replies,
so a broken endpoint cannot keep filling memory. Refused requests close their connections.

## Main files

| File | What it does |
| --- | --- |
| [routes.ts](routes.ts), [commands.ts](commands.ts), [refusals.ts](refusals.ts) | Handle uploads, file access, saved records and safe errors. |
| [types.ts](types.ts), [types-worker.ts](types-worker.ts) | Check actual contents and reject unsafe documents in a separate worker. |
| [scanner.ts](scanner.ts) | Sends bytes to the virus scanner. |
| [storage.ts](storage.ts) | Connects to file storage with short-lived, limited credentials. |
| [delivery.ts](delivery.ts) | Sends file bytes and their details to the computer. |

## How it connects

The [server](../../README.md) registers file requests. [Members](../members/README.md) and [chat](../chat/README.md) check access. Chat manages computer delivery; [computers](../computers/README.md) sends screenshots through these same upload checks. The [scanner service](../../../../infra/clamav/README.md) runs separately.
