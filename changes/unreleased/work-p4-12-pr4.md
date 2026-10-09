# Memory reads

## Why

People need to review the memory facts the server allows them to see.

## Functional outcome

The Memory tab in the workspace session panel lists permitted scopes and facts. It
searches, pages results and shows separately checked source status. It clears protected
content when access changes and discards replies from an earlier scope.

## Architecture

The browser reads the existing memory scope, fact list and fact detail routes. It keeps
no memory content in browser storage. The page has no write actions.

## Evidence

Component tests cover loading, empty, no search results, refused reads and unavailable
sources. Browser captures at 1280 and 390 pixels match the Memory handoff layout:

- [Desktop](../../docs/process/p4-12-memory/captures/MEM-03-1280.png) and [phone](../../docs/process/p4-12-memory/captures/MEM-03-390.png)
- [Desktop with reduced motion](../../docs/process/p4-12-memory/captures/MEM-03-1280-RM.png) and [phone with reduced motion](../../docs/process/p4-12-memory/captures/MEM-03-390-RM.png)

## Not in this PR

Storing, editing, pinning and forgetting facts remain unavailable.
