# Review fixes

## Response contract

PASS: reproduced the unchanged exact-response failure in
`direct-chat-http.test.ts`, case `hides pre-join timestamps, counts and snippets
from ordinary personal-session participants`. Its only extra response field was
`sessionConfiguration`. The assertion and test file remain unchanged.

Test-first commit `f42aa5192` adds browser checks for personal and team rows without
that field. The personal check failed with restricted instead of memory-free.
The fix removes the extra server field and moves `sessionDefaults` into
`libs/protocol`. The browser calls it with the assistant kind it already receives;
the helper still calls the shared event-library configuration. All existing list
response fields and creator-only ownership checks stay unchanged.

## Guard removal proofs

PASS: removed each guard individually, ran the named new test, observed the failure
below and restored the guard. These are own mutation checks, not review verdicts.
The computer's shipped code has no changes in this fix round.

| Removed guard | Consuming test and observed failure |
| --- | --- |
| Restricted attachments | All four `refuses restricted attachments before dispatch` cases failed: malformed object, null, non-empty list and omitted count no longer produced a failure before dispatch. |
| Shared-child recall exclusion | `checks the shared recall boundary` accepted an otherwise valid personal memory catalogue. |
| Restricted-process recall requirement | `checks the memory_free recall boundary` accepted that catalogue. |
| Preparing-turn count | `leaves a third private turn unreserved` opened three sessions while preparation was held, instead of two. Restored code also accepts a redelivery after a slot is released. |
| Private snapshot exclusion | `completes a private turn without reading workspace snapshots or artifacts` called the snapshot reader. Restored code completes without either reader. |
| Private failed late Stop handling | `closes only its private process after a late start reply and failed Stop access removal` failed to close that process. Restored code keeps its neighbour running and the bridge connected. |
| Private-process clearance requirement | `sends personal output clearance` sent a personal receipt for a memory-free Stop. |
| Shared-child clearance exclusion | The same test sent a personal receipt for a shared-child Stop. A personal Stop is the positive control. |
| Duplicate Stop grant removal | `does not remove a completed private Stop grant again` removed access twice. |
| Memory-free code mode | `enables code mode, shell and unified execution` received `code_mode_host = false`. |
| Memory-free shell | The same test received `shell_tool = false`. |
| Memory-free unified execution | The same test received `unified_exec = false`. |

The positive personal-recall control loads the valid catalogue through the existing
thread-loader fixture. Command-report tests also cover a restricted command refusal
and a memory-free success. The command-report filtering guard remains protected
by the earlier item refusal; these tests do not claim an independent mutation
failure for that later guard.

## Cleanup

Kept one configuration owner. Removed the server helper replaced by the protocol
helper. Used named functions and the existing bridge and recall fixtures; put the
new direct-runner fixture under `test/support`. Added no dependency, event, access
rule, timeout, retry, ownership change or size suppression. New code fits the
function and file limits. Updated the affected README sentences and diagrams.
