Provider dependency reads now check for routines through one indexed database position, so long routine histories do not need to be loaded. Delayed, failed or changing data stays unavailable; older and retired routines still block a complete dependency result.

Provider dependency reads keep the same access refusal for removed administrators and ordinary members when provider history fails, expires or contains invalid records.
