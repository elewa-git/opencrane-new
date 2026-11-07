Repeat development stack starts stop every saved worker before checking handler subscriptions.
They apply safe changes, restart unchanged subscriptions with queued jobs, and give fixed
instructions when maintenance is needed. The stack waits for the dispatcher to consume
events before saying it is ready, and removes that ready marker as soon as dispatch fails,
even if database lock cleanup is still in progress.
