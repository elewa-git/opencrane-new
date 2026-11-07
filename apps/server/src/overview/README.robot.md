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
its own priority even if the other check passed later. A cursor includes source
checkpoint states and ordered row keys. Changed states or expiry-driven row moves
require a fresh first page. Publication, memory and routines remain unavailable
until their owning reads are built.

The [server contract](../../README.robot.md) lists the service tests and the
remaining fresh-install qualification.
