# Persistent member account block through HTTP

Part of #49. Date: 26 October 2026. Base and prerequisite #723 merge:
`690c2e44ce8b1b861319e1a7044cddc2bd70c9eb`. Tests were committed first at
`58065acc9`; all 50 failed against the absent route. Implementation source:
`f86289804ebe82f04292f7df4e4e67c50ace20f3`. Tests used disposable NATS and
OpenFGA fixtures, plus the supplied PostgreSQL test service on loopback port 55432.
This is source testing, not a fresh installation. Cost: 0 euro cents.

## Route contract

`POST /api/integrations/:serverId/members/:userId/profiles/:profileId/disable`
accepts only `changeRef` and non-negative integer `expectedSequence`. Use the
admin profile GET's `controlRevision`, not `profileRevision`. Identifiers contain
1–200 letters, digits, underscores or hyphens. The body limit is 4096 bytes and
query fields are refused. Replies use `Cache-Control: no-store`.
The route maps the session to its member, requires the configured organisation
and exact Origin, then calls the unchanged disable command. History loads before
one current admin permission decision. The final write check lasts at most two
seconds and watches only small access streams. A refusal remains 403 even if a
later dependency call would fail.
Success returns `{ status: 'disabled', sequence, changeRef }`. Errors are fixed:
400 invalid input, 401 no session, 403 refused access, 413 oversized body and
503 unavailable for conflicts or dependency failures. The router also limits path length.
The command appends once to `connection-control-<user>-<server>`. Exact retries
recover the original receipt beyond transport deduplication; changed intent refuses.
No custody read/delete, provider call, selection or release runs. Identity stays
unverified and calls remain unavailable. Existing external work is not undone.
The receipt owns this route's documentation because the assigned file boundary
excludes every file changed in #723, including both package guides and readers.

## Evidence and remaining work

PASS: Vitest with one worker ran disable, revoke, admin-read, bearer-connections and
security-rules: 601 tests. Repeating the disable file passed all 50 tests again.
PASS: `npm run check:events`, seven API names against the exact risky-name matcher.
PASS: `npm run lint` (includes knip and changelog), and `npm run typecheck`.
Lint, typecheck and Vitest use `nice -n 10`. Logs: `/tmp/p3-8-pr7h-*.log`. Protected files are unchanged.
Full root suite, live fresh-install journey, admin receipt reader, re-enable, UI,
broker and OAuth: NOT RUN. No stack or model calls. No new events or dependencies.
