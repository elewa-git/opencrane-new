# Personal API keys

An admin chooses **Needs a personal key** during tool review and names a read-only,
zero-cost tool. That tool must accept `{}` and return a successful MCP tool result
whose `structuredContent.subject` is a stable account identifier. The review stores
`accountMode: personal` and `identityTool` through the normal conditional append.
The tool definitions and the connection are still reviewed and published separately
from member and assistant grants.

## Save and choose

All routes require an authenticated member of the current organisation. Writes also
require the exact Origin. Replies use `Cache-Control: no-store`.

- `GET /api/my/tools/:serverId/connection` returns the current `connectionId`,
  `identityTool` and `selectionRevision`. The server must be published, personal and
  granted to that member.
- `POST /api/my/tools/:serverId/profiles/:profileId/key` accepts `action` (`create`
  or `rotate`), `connectionId`, `changeRef`, `expectedSequence`, `expectedGeneration`
  and `material`. Material is a single API key, at most 4,096 printable ASCII bytes.
  The server sets the append deadline. The body limit is 8,192 bytes.
- After verification, the member explicitly chooses **Use this key**. This calls the
  existing selection command. Connecting a key alone never selects it.
- Existing profile, original-change and selection-change GETs recover saved outcomes.
  An original verified bearer save reports `identityStatus: verified`. This does not
  prove current usability.
- `GET /api/my/tools/needs?assistantId=<id>` returns names and ids for granted servers
  whose tools the turn builder omits because the requester has no verified selection.
  It uses the same readers and builder as turn admission. Its failure does not close
  or refuse the conversation.

The identity call checks current membership and the server grant before forwarding a
key. It sends only the reviewed identity tool, an empty argument object, the reviewed
catalogue digest and the protocol version. It uses the same HTTPS address, certificate,
address-pinning and bounded-response checks as other remote calls. There is no retry.
The credential-checked demo accepts this call through its `who_am_i` tool. After
staging, the command checks membership and current grants again and binds their exact
streams to the append. Remote calls never run inside that short write check.

Only successful identity evidence is stored with the normal bearer activation:
`verification.toolName`, `toolRevision` and safe `account` metadata. The credential
itself is staged through the existing secret-store adapter and never enters an event.
A changed account blocks the replacement. Unverified and blocked keys are unavailable
for tool offers and releases. OAuth keeps its existing settings and scope checks.

Invalid input returns 400; missing session 401; refused access 403; failed identity
verification 422 with `identity_unverified`; other unavailable or uncertain writes 503.
A 422 happens before staging or append and permits a corrected key. After an uncertain
write, the form keeps only the original profile id and change reference. A missing
receipt remains unknown and never permits a resend. No response returns key material.

## Browser handling

My tools clears the password input before waiting for a save reply, on access loss,
on a server change and on destruction. Browser storage contains only change references
and profile ids. The verified account is shown after an own-profile read. The member
must explicitly select the key before returning to chat; no earlier request is resent.
A definite selection conflict clears that refused reference and reloads the current
revision. An uncertain selection still requires the original status read.

## Runtime settings

`CONNECTION_CUSTODY_FILE` supplies the existing private Kubernetes secret-store
configuration to server, models and dispatcher processes. OAuth additionally uses
`MCP_OAUTH_CONFIGURATION_FILE`; bearer keys require no OAuth settings.
The dev stack supplies a namespace-scoped, short-lived Kubernetes identity and a
private Unix socket shared with the models container. It removes the namespace when
the secondary stack is released. No new secret store or runtime dependency is added.
