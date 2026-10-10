# Store a memory fact

## Why

People need a clear way to save a fact in a memory scope they can use.

## Functional outcome

The Memory panel has a store form for facts and a saved receipt. The form counts
UTF-8 bytes, limits Preference to personal memory and offers only source references
already returned by an authorised detail read. Cancel makes no request. A busy store
waits for the server's `Retry-After`; an unknown result offers a status read that does
not send the fact again.

## Architecture

The browser uses the existing memory write and command status routes. Draft text and
command ids stay in page memory. The shared memory panel remains the place for scope,
source and access state.

## Evidence

Panel tests cover Cancel, UTF-8 byte limits, Preference rules, saved and definite
failure receipts, busy retry and unknown status checks without a resend. Browser
captures cover the form, oversized text, saved receipt and unknown receipt at 1280px
and 390px, including reduced motion. Web lint, typecheck, build and tests are recorded
with the pull request.

## Not in this PR

Undo, editing, pinning and forgetting need later memory commands.
