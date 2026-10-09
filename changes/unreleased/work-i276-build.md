Handler subscription upgrades now keep existing events and receipts. The new
`npm run ops -- upgrade-handlers` command offers a dry-run plan and queues only
new subscriptions' historical events while writers and workers are stopped.
The dispatcher reports subscription changes and the recovery command before
waiting for shutdown.

Interrupted handler upgrades now resume from saved scan progress. Dry-run works
while the dispatcher waits and reports unfinished work and failed jobs. Operators
can list failed jobs and cancel one deliberately. Old events preserve later
membership changes, permission removals, model revocations and budget reservations.
