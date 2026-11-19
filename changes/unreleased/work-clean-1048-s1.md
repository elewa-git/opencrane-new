Tool change descriptions now ignore object key order at every depth while keeping
array order. Shared JSON comparison is available through the event and browser
contracts. Sensitive bindings, retries and replay verification keep exact JSON-text
checks; lint rejects new direct JSON.stringify equality comparisons.
