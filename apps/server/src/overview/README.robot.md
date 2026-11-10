# Organisation overview read contract

For people, read [README.md](README.md) first.

`routes.ts` registers `GET /api/org/overview`. The query accepts an optional
`limit` from 1 to 50 (default 20) and an optional cursor. Each source query reads
at most 51 records under one two-second data deadline. The extra record makes
an overfull source unavailable. The route checks current Owner/Admin access once
after loading, independently of that deadline. It never calls an external provider,
starts discovery, scans event streams or appends an event.

`rows.ts` orders unknown outcomes, needed input, failures and dated Ready evidence.
Within a class it uses event time, source and id. Provider Ready requires current
passing reachability and model results. A current unknown or failed result keeps
its own priority even if the other check passed later. Memory rows come from the
bounded audit table. Due and prepared nights stay unknown; refused and missed nights
need attention. No changes creates no task row. The audit checkpoint reports a late
or unavailable source without clearing rows from other sources. The task opens the
checked audit detail, never a maintenance command. Memory row ids and detail
links use the saved random public reference. The original event and night ids
never leave the audit table through this route. A cursor includes source
checkpoint states and ordered row keys. Changed states or expiry-driven row moves
require a fresh first page. Routine rows use bounded audit history and its
checkpoint, with a checked public reference link. Due, Stop and uncertain sends
stay unknown; skipped and missed work needs attention. Ready needs the saved
finish's settlement proof and date. Ask, Run now, retry and final source
coverage remain unavailable. Publication awaits its owning read.

The [server contract](../../README.robot.md) lists the service tests and the
remaining fresh-install qualification.
