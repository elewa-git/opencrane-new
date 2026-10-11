New turns can use an assistant's saved provider choice or the silo default after switch-on is recorded. Paused or missing choices refuse new work. Running turns keep their original model and provider. Old passes are refused before holding money after switch-on. Existing installations keep their current path because the safe switch-on command and managed gateway are not built yet. Model decisions read switch-on from the silo's exact spending stream, without scanning unrelated providers.

Holds saved before switch-on still settle, release or expire without restarting
the models process. A refused unsent call releases its hold at zero cents, and
late usage settles once at its original price. New holds remain refused.

Spending-limit edits can retry after switch-on using the revision shown to the admin, even if an earlier access check expired or a new spending hold was refused. Existing holds do not need to be released first.

Starting a personal turn reads each new budget row once. The payer and provider
switch-on check share the same small summary, so growing spending history does
not add a second read of new rows.
