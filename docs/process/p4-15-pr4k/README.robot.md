# Native personal write protocol

For people, read [README.md](README.md) first.

Part of #97, P4-15 PR 4k. Base: `9ac1c6e3f`. Test-first commit: `06e499692`.
On 29 October 2026, the initial native test failed because its runner was absent;
the CI registration test failed because the image group omitted the new test.

Codex 0.159.2 uses single-operation builders and synthetic preparation evidence.
A scripted Responses service makes Codex author each call; a recorder checks its
name, personal scope, arguments, protocol and thread/call ids. Receipts match
memory/mcp.ts: empty content and structuredContent, with a random changeId.

Successful writes consume one receipt. Refusals consume none; no call is resent.
Cancellation discards partial receipt bytes. A second session survives.
Native consent accepts one matching thread/turn/server/MCP kind. Altering each
identity field, requesting shell consent or repeating consent returns a fixed error.
This tests the fixture's consent handler; production still uses never.

Only fixed case names and counts leave Docker. Child failures are sanitised.
The existing image is `ocn-upload-computer:test`, id
`sha256:c72eafd94319227d3d48dd9baadf74bf01ec8d0de7b0c2f7baf3219c04534377`.
Each run creates a disposable container with no external network, tmpfs homes and
read-only repository sources. RISKY_FIELD_NAME has no new event/API field to assess.

Own checks and limitations are recorded in the PR. Logs use `/tmp/p4-15-pr4k-`.
Native admission remains disabled. Backend lineage, current access, gateway routing,
host/disk isolation, production launch and fresh-install qualification: NOT RUN.
No full root suite, owner stack, paid model call or secondary stack was used.
