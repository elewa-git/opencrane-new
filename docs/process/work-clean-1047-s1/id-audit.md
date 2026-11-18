# Record ID copy audit

Production TypeScript only; test and spec files are outside the migration scope.

| Package | Before | After outside ids.ts |
| --- | ---: | ---: |
| `apps/computer` | 5 | 0 |
| `apps/ops` | 6 | 0 |
| `apps/server` | 79 | 0 |
| `apps/web` | 9 | 0 |
| `libs/auth` | 4 | 0 |
| `libs/events` | 26 | 0 |
| `libs/models` | 29 | 0 |
| `libs/projections` | 2 | 0 |
| `libs/protocol` | 8 | 0 |
| Total | 168 | 0 |

The only remaining exact literal is in `libs/events/src/ids.ts`. The card counted
162 copies at an earlier commit. This branch started at `cdb8b80bf`; it contained
168 occurrences in 142 production files. Both spellings were counted.

## Patterns retained deliberately

- `apps/server/src/routine-{admin-pause,pause,reassign,retire,stop}.ts`:
  composite change IDs contain two record IDs separated by a colon.
- `apps/server/src/computers/view.ts`: HTTP and WebSocket route patterns include
  path prefixes and suffixes around the ID.
- `apps/web/src/app/app.ts`, `organisation/overview.ts` and `organisation/pages.ts`:
  route patterns include path prefixes and suffixes around the ID.
- `apps/server/src/members/guard.ts` and `libs/events/src/conversation.ts`:
  `idSchema` aliases `chatIdSchema`, which allows a different set of route IDs.
- `apps/computer/src/turn-runner.ts`, `libs/events/src/assistant-grant.ts`,
  `libs/events/src/provider-events.ts` and `libs/protocol/src/model-access.ts`:
  model IDs also allow dots.
- `apps/odoo-mcp/src/odoo.ts`: database names also allow dots.
- `libs/events/src/connections.ts` and `libs/models/src/oauth-attempt.ts`:
  OAuth scope patterns allow the protocol's wider ASCII character set.
- `apps/computer/src/read-attachment.py` and `receive-file.py`: Python expressions
  validate paths and upload metadata; these are outside the TypeScript literal migration.
- Existing test/spec literals remain unchanged. The new boundary test keeps both
  old spellings as its comparison values.

## Lint probe

A temporary production TypeScript file exported both old literals. Scoped ESLint
exited 1 with two `no-restricted-syntax` errors, one per spelling:

```text
1:22 error Import recordIdSchema or recordIdPattern instead of copying the ID pattern
2:23 error Import recordIdSchema or recordIdPattern instead of copying the ID pattern
```

The probe was removed. The real `ids.ts` and the changed composite-pattern callers
are included in the final scoped ESLint check.
