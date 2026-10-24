# Budget editor failure pictures

The local budget check now saves a private picture when the editor cannot load.
Stack-free browser checks cover refused and repeated saves at desktop and phone widths.
The intermittent baseline load failure remains unresolved.

CI now runs the budget editor browser checks with Chromium and one worker.
Every dev-stack test must run in CI or have a named exclusion with a reason.
