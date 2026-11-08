# Organisation audit read contract

For people, read [README.md](README.md) first.

The memory maintenance prerequisite merged on main as
`29df1f8a74e19e940dc721b6c28c56fc9bdc67e2` (PR #963).
`memory.maintenance_recorded` is a scope-stream receipt. It binds `scopeId`,
`nightId`, `batchKey`, `inputRevision`, UTC date, binding revision, member,
100-cent accepted cap, intended and selected times, and at most 32 input
references. Its action is due, prepared, refused, missed or no changes.
Only prepared names a `rootId`, model and provider. The separate
`budget.root_allowance_set` event binds that root to the same scope, night,
batch and input revision, plus its assistant, payer, computer, model, provider,
price table and 100-cent allowance. Neither event proves a run, hold or charge.

The audit route loads bounded history before one current organisation access
check. It gives the personal owner a link to the existing memory status GET.
That GET checks its own rights. Other admins see safe action and time metadata
without the scope, member or root ids. A missing audit checkpoint leaves the
overview memory source unavailable; a lagging one leaves it applying. GET and
replay append no events and start no maintenance.
Existing installations must rebuild the audit read table once to include older saved
night receipts. The audit rebuild reads the event store without starting a run.
