# Add an integration

This folder shows the Add an integration page. Admins can register an outside tool server by its address, or submit an exact software package for safety checks before it can run.

## What it is responsible for

- Offers a remote HTTPS address at `/org/integrations/new`. [MCP, the Model Context Protocol](../../../../../GLOSSARY.md#mcp-server-tool-server), is the standard used by these tool servers.
- Shows discovered tools, separating read-only tools from tools that change data or have unclear effects. Every tool starts unreviewed and unavailable for calls.
- Accepts a package image fixed by a SHA-256 digest, a content fingerprint that identifies one exact version, with its platform, upstream host and port.
- Shows dated package checks, refusals and expired results. Failed reads can be checked again; choosing another version returns focus to its input.
- Checks encoded host names before submission and ignores status replies for an older package.

The package checks show signature and licence refusals separately from an unavailable
scanner. An unavailable result offers another status read and keeps Continue disabled;
it cannot start a new scan here. A save whose reply is lost keeps its original request
reference for a status check before another action is offered.

## Main files

| File | What it does |
| --- | --- |
| `mcp-install.*` | Draw the source choices and handle remote registration and tool discovery. |
| `hosted-install.*` | Submit exact packages and display their admission checks. |

## How it connects

[Integrations](../integrations/README.md) supplies setup steps and status messages.
Remote discovery leads to [Tools & access](../tool-policy/README.md).
[The server](../../../../server/README.md) registers and checks submissions.

## Not done here

Catalogue selection is unavailable. Package discovery is unavailable, so Continue stays
disabled even when its four checks pass. Saving a package gives nobody access.
