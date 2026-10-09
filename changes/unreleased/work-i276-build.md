Handler subscription upgrades now keep existing events and receipts. The new
`npm run ops -- upgrade-handlers` command offers a dry-run plan and queues only
new subscriptions' historical events while writers and workers are stopped.
The dispatcher reports subscription changes and the recovery command before
waiting for shutdown.
