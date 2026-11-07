# Provider retirement preview contract

Part of #104. The preview reads provider and assistant events, indexed routine
presence and current permissions. It returns 50 bindings per page, tied to
provider and routine positions. Existing routines have no model binding and
block proposal validation. No retirement command is exposed.

The failing-first test commit is `230dc89ff` (the route returned 404).
[Own checks](receipt.md) record the results.
