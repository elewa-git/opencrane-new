- Keep connection cleanup and command tests reliable under load by waiting for their
  database locks and completed scan pages. Continue checking every cleanup retry, the
  saved failed job and the production deadline when a lock is already held.
