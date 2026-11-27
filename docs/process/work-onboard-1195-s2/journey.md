# Restore onboarding and Memory from a nightly pilot backup

Journey on a fresh dev stack: PASS

The 27 November 2026 run used the package for
`87f229661f17ab7413ec044cebcc4aadea7a609c` and the free qualification model.
[Hosted CI](https://github.com/elewa-git/opencrane-new/actions/runs/45947500848/attempts/2),
[application approval](https://github.com/elewa-git/opencrane-new/actions/runs/45947512305)
and [scanner approval](https://github.com/elewa-git/opencrane-new/actions/runs/45947512702)
passed for that commit.

## Packaged journey

1. **PASS** Claimed slot 1 after five minutes with the one-minute load below six.
   Installed the package on empty storage. Two invited members signed in,
   completed all four survey steps, approved their persona and finished the
   welcome chat. Each member saved a different fact and saw it after reloading.
   - At 1280 px, [survey](survey-1280.png), [persona](persona-1280.png)
     and [Memory](memory-1280.png).
   - At 390 px, [survey](survey-390.png), [persona](persona-390.png)
     and [Memory](memory-390.png).
2. **PASS** Confirmed the 02:00 UTC nightly schedule. Moved the next run forward
   on this disposable installation so Kubernetes launched the normal Job.
   The catalogue listed and verified the same four-part set. It held 105 events,
   17 checkpoints and a 589-byte encrypted key archive. The Memory checkpoint
   matched the saved event position.
3. **PASS** Copied the verified set to private storage and released slot 1.
   After another five minutes below the load limit, claimed it again. The
   recovery package used the same images, a new namespace and new volume claims.
4. **PASS** Imported a copy with the encrypted key part withheld. The Job
   reported `member_keys_unavailable` at the backup check. Its log said the
   onboarding and Memory keys were missing or could not be verified. The
   server stayed at zero replicas.
5. **PASS** Imported the complete set into that still-empty recovery
   installation. The restore Job verified it and opened the server for reading.
   Both members signed in. Each saw their original approved persona and saved
   fact. Their browser sessions also confirmed that all four answers matched
   the original survey.
   - At 1280 px, [restored persona](restored-persona-1280.png) and
     [restored Memory](restored-memory-1280.png).
   - At 390 px, [restored persona](restored-persona-390.png) and
     [restored Memory](restored-memory-390.png).
6. **PASS** Copied the screenshots before removing the recovery package and
   releasing the slot.

Both package installs used the documented development host exception for swap
and crash-dump settings. The screenshots show disposable test accounts and
fictional answers.

## Checks

- **PASS** The 218 focused Vitest tests and 323 Helm and installer checks passed
  twice. The PostgreSQL restore test rebuilt a saved Memory fact from a
  restored revision key.
- **PASS** Typecheck, the event catalogue, Knip, changelog and Markdown lint,
  the README and whole-stream read checks, and public privacy and secret scans.
  Scoped ESLint passed for the files it covers. The repository excludes
  infrastructure files from ESLint.
- **PASS** The first hosted CI run timed out in a routine test's setup. That test
  passed in isolation, and the hosted rerun passed on the same commit.
- **NOT RUN** The separate standard development stack check reached the slot
  wait limit. Slot 1 did not provide another five continuous minutes below
  the load limit before the wait ended.

## Earlier attempt

The first package started, and the 1280 px member completed onboarding. An
extra sign-in timed out before they saved a fact. The second run kept the
member's session through that step. The first run's `browser.log`, startup
logs and service logs were saved before teardown.

## Recovery policy still open

A separate disposable test confirmed that an older set can still read a fact
whose key was erased after that set was taken. The existing Memory recovery
rules require current deletion evidence. The decision about recovery when
that evidence is unavailable remains open before merge.
[Memory recovery rules](../../specs/phase-5/decisions.md).
