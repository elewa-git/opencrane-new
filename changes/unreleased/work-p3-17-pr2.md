- Computers can now stop tool executors through a root-only socket, including
  detached children, surviving worker threads and private Codex processes.
  Children forked during the stop check cannot escape termination. Executor admission
  stays closed after a restart or unavailable stop proof. Desktop control remains disabled;
  browser quietness and bridge pause handling are still pending.
