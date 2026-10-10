# Store a memory fact safely

## Why

People need a clear way to save a fact in a memory scope they can use.

## Functional outcome

The Memory panel has a store form for facts and a saved receipt. The form counts
UTF-8 bytes, limits Preference to personal memory and offers only source references
already returned by an authorised detail read. Cancel makes no request. A busy store
waits for the server's `Retry-After`; an unknown result keeps its original command
available for a status read that does not send the fact again. Access loss or a
requester change clears every store field and pending request. Invalid text shows its
reason beside the field.

## Architecture

The browser uses the existing memory write and command status routes. Draft text and
command ids stay in page memory. The shared memory panel remains the place for scope,
source and access state. Replies and busy retries keep the scope and command from the
request that started them, so a late reply cannot change a different requester's view.

## Evidence

Panel tests cover access refusal, requester changes during a pending write, unknown
status checks, validation feedback, busy retry and saved receipts. Browser captures
show the fact detail and invalid store form at 1280px and 390px. Web and repository
checks are recorded with the pull request.

## Not in this PR

Undo, editing, pinning and forgetting need later memory commands.
