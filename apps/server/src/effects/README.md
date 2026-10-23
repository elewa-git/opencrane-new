# Effects

This folder lets owners and admins inspect AI and tool calls whose cost or delivery needs checking. It provides the requests used to review money set aside for a call and record a supported resolution when the outcome is uncertain.

## What it is responsible for

- Lists saved call records and returns the details of one call.
- Checks current owner or admin access after loading records.
- Accepts a resolution only from this website and the browser session that read the call.
- Passes resolution checks and saving to the shared spending code.
- Tells browsers and caches not to store spending replies.

Before a call, OpenCrane puts money aside: this is a hold. Afterwards it charges the real cost and releases unused money. A call that might have been sent cannot simply be treated as free. Conflicting costs keep it blocked. An accepted zero-cost resolution with proof that the call was never sent can release a reopened hold. Saved results survive a restart and rebuilding the read tables.

History loads before the short final write access check. A removed admin receives no spending records, and a lost permission check cannot authorise a resolution.

## Main files

| File | What it does |
| --- | --- |
| [routes.ts](routes.ts) | Handles call lists, detail and protected resolution requests. |

## How it connects

The [server](../../README.md) registers these requests. [Integrations](../integrations/README.md) supplies shared organisation request settings. [The models library](../../../../libs/models/README.md) reads and resolves saved calls; [providers](../providers/README.md) uses their settled state before switching provider operation.
