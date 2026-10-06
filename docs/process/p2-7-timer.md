# Daily fresh timer

Installed on 2026-10-06. The service updates a detached checkout at
`~/dev/daily-fresh` before each run. The user timer runs at 03:17 UTC with
`Persistent=false`. Its receipt file is `~/.opencrane/daily-fresh/ledger.md`.
Failed runs save `last-error.log` and any failure screenshots in a dated folder there.

The install script reported this timer list:

```text
NEXT                        LEFT LAST                           PASSED UNIT                           ACTIVATES
Wed 2026-10-07 03:17:00 UTC  12h -                                   - opencrane-daily-fresh.timer    opencrane-daily-fresh.service
Wed 2026-10-07 14:14:45 UTC  23h Tue 2026-10-06 14:14:45 UTC 43min ago launchpadlib-cache-clean.timer launchpadlib-cache-clean.service

2 timers listed.
```

The hand run used the local model stub and cleaned up its claimed secondary slot.
The last two full runs reached the existing mobile approval check, then failed while
waiting for its decision to appear. The external receipt ledger records both failures.
