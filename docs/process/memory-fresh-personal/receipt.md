# Personal memory qualification

25 October 2026. Part of #94. Part of #95. Both remain PARTIAL.

The latest fresh journey **FAILS on the first Memory load**. Ownership setup was
still reaching the permissions service when the browser requested Memory. The
server returned 503 and the desktop page kept saying Memory is unavailable.
No personal fact was saved. The merged Forget fix was therefore NOT RUN in this
installation. No memory write was retried, and no product check was bypassed.

## Source and installation

PASS: `git fetch origin` and rebase finished on `e718e3e90`. Main is an ancestor
of the branch and no rebase remains in progress. This includes the first-load fix
in #688 `f01ee18f7`, cleanup and correction refresh in #697 `88a436e44`, and the
Forget revision fix in #699 `e718e3e90`. The rebased journey source was `11af2155e`;
only its output directory changed before execution. Earlier prerequisites are
PR #646 `59a81b70f` and PR #641 `105071aaa`.

One secondary slot, number 1, was claimed through `infra/dev-stack/claim.sh` and
started with `--fresh` and `DEV_OWNER_BOOTSTRAP=0`. The collector confirmed that
there were no members before the browser claimed ownership through real SSO.
The run used only the local model stub. `ZITADEL_KEY_FILE` held a credential file
path. The configured owner contact and browser session stayed in private slot
files. Memory and personal key directories belonged to the slot; no private
memory custody files were inspected. The owner stack was not used.

## Results from this installation

The [original observations](forget-fixed-rerun/observations.jsonl),
[request timing](forget-fixed-rerun/request-timing.json),
[setup timing](forget-fixed-rerun/setup-timing.json) and
[read-only diagnosis](forget-fixed-rerun/diagnosis.json) belong to this run only.
Timing records contain fixed log fields and identifiers, without request bodies.

| Step | Result | Observed outcome |
| --- | --- | --- |
| Empty install, SSO and owner claim | PASS | No members before claim; browser confirmed ownership. |
| First Memory load | FAIL | Scopes returned 503; desktop showed Memory is unavailable. |
| Save a personal fact | NOT RUN | The journey stopped at its first read. |
| Find and open the saved fact | NOT RUN | No personal fact was saved. |
| Correct the fact | NOT RUN | No personal fact was saved. |
| Forget after correction | NOT RUN | The merged revision fix was not exercised. |
| Original save, correction and forget receipts | NOT RUN | No memory write was submitted. |
| Correction and forget cleanup | NOT RUN | No memory write was submitted. |
| Drop an accepted reply and recover through GET only | NOT RUN | No memory write was submitted. |
| Phone save, correction and forgetting | NOT RUN | No writes followed the first-read failure. |
| Another member's HTTP and browser isolation | NOT RUN | No saved fact existed to test. |
| Forgotten fact absent after reload | NOT RUN | This installation never saved or forgot a fact. |
| Forgotten fact absent after server restart | NOT RUN | Restart qualification was not attempted. |
| Stopped-worker rebuild and retained correction | NOT RUN | Rebuild qualification was not attempted. |
| Forgotten fact absent after rebuild | NOT RUN | This installation never saved or forgot a fact. |
| Complete live acceptance checker | NOT RUN | Required write and persistence evidence is absent. |
| Later read-only Memory load | PASS | Scopes returned 200; both widths showed an empty list. |
| Public captures of the original failure | PARTIAL | Desktop shows the error; phone resizing caused new reads. |
| Governed MCP recall and native memory | NOT RUN | Native memory stayed off; browser search does not qualify it. |

The later empty list is diagnostic evidence only. It does not replace the failed
first load or qualify any write. The event log contains no memory events, and the
local model stub recorded zero requests.

## Cause of the first-load failure

The saved events and worker logs show this order, in UTC:

1. The owner claim was saved at 13:12:28.272. OpenFGA applied it by 13:12:28.935.
2. The background ownership handler saved `ownership.seeded` at 13:12:29.102.
3. The failing scopes request began at 13:12:29.980 and returned 503 about
   481 ms later, at 13:12:30.461.
4. OpenFGA started applying the ownership seed at 13:12:33.161 and finished at
   13:12:33.433, after the failed read.

`currentMembership` includes the ownership seed among the facts that grant the
owner access. `readActiveMember` requires each fact's OpenFGA receipt. Until that
seed is applied, it throws `AuthorityApplying`; the Memory route returns 503.
The memory worker had already handled the bootstrap event, and this request
specified neither an assistant nor a group. This is a different setup race from
the assistant-notes failure fixed in #688.

The root cause is the gap between confirming ownership to the person and applying
its follow-up permission event. The browser's `loadScopes` makes one read and
leaves any unavailable reply on an error screen. It does not recover when those
permissions finish applying. The access check itself must remain in place.

PASS: an isolated diagnostic test reproduced the same 503 with real NATS,
PostgreSQL, OpenFGA, the memory worker and server entrypoint. It used the existing
`memory-main.test.ts` fixture, leaving only the ownership seed unapplied. Applying
that seed through the ordinary permission handler changed the next scopes read to
200. The existing first-load test applies both ownership events before its first
read, so it does not cover this interval. The temporary test was removed after
execution; it made no request to a live development stack.

This diagnosis follows the saved event order, worker timing and code; the route
does not log its caught exception, so there is no original exception record.

The collector also stalled while reading the first scopes response body. Its
body read has no timeout and it records the reply only after that read finishes.
The collector's own debugger was used to capture its existing desktop error page
and preserve its private browser session. Resizing then caused fresh product reads;
the collector recorded failure and exited with status 1. No original scopes body
was recovered. No product process was debugged or changed.

## Pictures and privacy

All six new pictures and all ten MEM-30/33/34/40/41 reference frames were inspected
by eye. No new picture contains an email address, home directory or private path.

- [First desktop failure](forget-fixed-rerun/first-read-failure-1280.png) shows
  Memory is unavailable before the collector was released from its stalled read.
- [First phone capture](forget-fixed-rerun/first-read-failure-390.png) and
  [collector desktop capture](forget-fixed-rerun/failure-1280.png) show the workspace
  with the Memory panel closed. They do not prove a Memory outcome.
- [Collector phone capture](forget-fixed-rerun/failure-390.png) shows the empty list
  after resizing triggered fresh reads. It does not show the original failure.
- [Later desktop](forget-fixed-rerun/later-read-only-1280.png) and
  [later phone](forget-fixed-rerun/later-read-only-390.png) show a settled empty list
  during a separate read-only diagnosis.

The first diagnostic script stopped before saving evidence because it read the
OpenFGA binding from the wrong settings file. Reading the existing binding file
fixed that collector setup mistake. It made no product writes.

## Earlier attempts

Earlier evidence remains unchanged. The [first observations](observations.jsonl)
record a first-load 503 before #688. The separate setup and input attempts failed
during sign-in and contact validation. Those were setup failures.

The [earlier rerun](rerun/observations.jsonl) passed desktop operations, lost-reply
recovery, HTTP isolation and absence after reload, restart and rebuild. Its cleanup
query used the wrong database, and phone correction hit a read-after-write delay.
Both causes were fixed in #697. Its acceptance input failed; it is not current
qualification evidence.

The [previous fixed rerun](fixed-rerun/observations.jsonl) passed saving, correction,
cleanup, isolation and correction persistence. Forget submitted revision 1 while
revision 2 was still refreshing and received 409. That cause was fixed in #699.
Its forgotten-fact persistence and recovery checks remained NOT RUN. Neither
previous run supplies missing evidence for this installation.

## Local checks and release

PASS: clean `npm ci`, existing NATS and Lychee links, eight acceptance tests twice,
and `check:events` with all 153 event types matching. All build, lint, typecheck
and test commands ran under `nice -n 10`. The full root suite is NOT RUN, as required
by the build prompt. Product files, Stage B, authority tests, event contracts and
the acceptance checker are unchanged.

PASS: 438 event security tests and the isolated ownership diagnostic test, using
a disposable PostgreSQL 17.6 database with `PG_TEST_URL` set. Its container and
volume were removed with `docker rm -f -v`.

PASS: `down.sh --id 1` released the slot. Its owner marker and Compose containers
are absent. Only claimed resources were removed.

PASS: full workspace typecheck, including package and development-stack checks.
PASS: documentation/privacy and changelog checks. Full lint also passed, including
Knip, dependency boundaries, documentation/privacy, links, fixtures and licences.
ESLint reported 25 function-length warnings and no errors.
