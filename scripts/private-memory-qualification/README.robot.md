# Private memory evidence collector

For people, read [README.md](README.md) first.

## Deployment collection

P4-15 PR 5e adds `await collectDeployment()` and `run.mjs`. The older file
parser below remains refusal-only. The disabled initial-load command reads only the
collector-owned result described below. No admission switch is added.

The collector uses `/usr/bin/docker` and the local `/var/run/docker.sock` only.
The deployment owner controls Docker, the image build and the collector process.
Browser, model and application users must have no access to these. Infrastructure
operators remain outside the application privacy promise. The collector accepts no arguments. Any supplied argument refuses before Docker runs.
The fixed `/etc/opencrane/private-memory-qualification.json` file contains
`containerId` (64 lowercase hex characters) and `siloId` (the expected raw `SILO_ID`).
It must also contain `computerContainerId` for the separate bridge and supervisor checks.
It must be a root-owned regular file, at most 1 KiB, with no group or world write
permission. Final symlinks are refused. Root must also own and protect its parent
directories. The deployment owner installs this file; neither its path nor target
can be selected through command-line arguments or environment variables. The
measured container id and silo must match it. Replacement requires the owner to
update the configured container id. No evidence bundle or caller observation is accepted.

Docker supplies the full container id, running image content digest, image revision
label, daemon identity, start time and `SILO_ID`. The source label must be a full
40-character revision. The host and silo form a hashed `environmentId`; the silo
and container/start/event-stream identity are also hashed. Raw names and environment settings
are not returned. The image must have a read-only root filesystem. Mounts outside
`/run/` and `/var/` refuse, so code and interpreter overrides cannot qualify.
Node runs from its absolute image path, with a fixed working directory and cleared
`NODE_OPTIONS`, `NODE_PATH` and `LD_PRELOAD`. No caller selects the child command.

Before journeys, a fixed Node probe uses the deployment's existing TLS/NKey NATS
connection to inspect `EVENTS`. Both message count and last sequence must be zero;
a purged stream with previous events refuses. The stream must have been created
after the container, and the container within five minutes. This is the measured
fresh event-store condition, before owner bootstrap. It does not replace the full
private-process and persistence journeys. Restarts and identity changes refuse.

Each of the nine checks and both complete qualifications executes the fixed
`/app/scripts/private-memory-qualification/journey.mjs` inside that container.
The runner receives one JSON object on stdin: measured binding, `name`, fresh
`runId` and fresh per-check `challengeId`. It must perform that named journey,
then return only the same fields plus `observedAt` (epoch milliseconds),
`result` and `complete`. PASS requires complete=true; PARTIAL and NOT RUN require
complete=false. Extra, stale or mismatched results refuse. Partial and missing journeys
are recorded but cannot qualify. Every process has a two-minute timeout and a combined stdout/stderr
limit of 64 KiB. The collector injects `supervisor.mjs` into each Docker exec. This
supervisor starts the fixed command in a new Linux process group and keeps stdin
open as a connection to the collector. EOF, including collector SIGTERM or SIGKILL,
cancels the group. The supervisor also enforces the timeout and output limit inside
the container, independent of the Docker client. Normal completion kills any
remaining children before returning output.

The supervisor holds `/run/opencrane-memory-qualification.lock` until all running
group members have stopped. A concurrent run refuses; it cannot remove another
run's lock. The runner must keep its children in that group. The image needs a
writable `/run` and Linux `/proc`. A failed cleanup keeps the lock and refuses
retries; the deployment owner must resolve the failure before retrying. The host
also bounds Docker attachment to 130 seconds, allowing ten seconds for cleanup.
The collector measures identity and event-stream creation before and after every child.
It checks the computer's root supervisor before and after the bridge check, and
again after each awaited journey. Missing supervisor proof refuses the run.
A copied response
cannot match the new challenge. It does not accept detached receipts or signatures.

Only validated metadata is hashed into `receiptDigests`; no memory text is hashed.
All child output and errors stay in process memory. A strict runner response containing
`result: FAIL`, `reason: host_refused` and an optional `protectionFailure` stops
collection. The collector returns and saves that category and its fixed message.
`protection-failure.ts` owns the allowlist and messages. Container failures distinguish
unreadable swap controls, non-zero swap, unproved memory limits or crash kernel settings,
failed core-limit measurement, non-zero core limits, failed dumpability measurement,
failed dump protection, a dumpable process, changed identity and an unavailable helper.
No observed value, private path or helper error is returned. The supervisor receives
the same allowlist from the collector and rejects unknown categories or extra fields.
The two-field refusal remains valid for a later safe-host check that fails; its message
remains "Host safety checks failed: swap and core dumps must be disabled."
Other failures expose only
`FAIL / collection_failed`. Completed collection reports measured identity, the nine checks,
both qualifications and receipt digests. This output is not an admission token.
The collector atomically writes its own result to
`/etc/opencrane/private-memory-qualification-result.json`, using a new file with mode 0600.
A new collection first replaces the prior result with FAIL. Its own incomplete run can replace that with PARTIAL, preserving each check status.
Only its own complete run can replace that with PASS. The owner runs the collector as root and protects the parent
directories. The collector changes no admission setting. Its runner appends the fixture
events described below. Saved JSON cannot
be fed back into this collector. The older file parser still cannot return PASS.

`readDeploymentQualification(silo)` reads that fixed file with no symlink following.
It requires a root-owned regular file, no group or world writes, and at most 8 KiB.
It parses the collector's complete output shape and requires nine PASS checks, both
complete qualifications and eleven distinct receipt digests. It independently measures
the current deployment and event-stream creation, checks the silo, and rechecks the
configuration and result after the measurements. It returns the collector run id and a
synchronous check that those protected files still match. Its local `catalogue` value
contains the measured runtime identity and the nine checked results for recall assembly.
It carries no caller credential and is never a bridge message. The initial-load command
retains that id, rechecks access after deployment reads, then checks the files without
another wait before each append. It repeats the checks after saving.
This reader requires local Docker access on the deployment host; no HTTP route exposes it.
Delivery and production admission remain disabled.

## Image-owned host probe

The computer image starts its root supervisor as PID 1. Its root entrypoint saves
the Linux start time in a mode-0600 launch record and starts the existing native
dump-protection service before private work. The inspector checks that record,
the fixed command, executable, UID, PID namespace and cgroup. A fresh socket
reply binds protection to the kernel's peer PID. Swap and dump checks surround
it. Docker checks container ID, image, start time and host PID on both sides.
The packaged-image test uses the real entrypoint. Proxy, native wrapper, native
child and canary helper proof remain missing.

P4-15 PR 5h adds the fixed `journey.mjs` entry. The existing package Dockerfile copies
these files; no code mount, caller executable or interpreter override is needed.
The entry accepts no arguments and at most 4,096 stdin bytes. Its strict request has
only the measured binding, one of the eleven existing names and a UUID challenge.
Unknown names, extra fields, malformed formats and paths refuse before observations.
Failures contain `result: FAIL` and `input_invalid`, `host_refused` or
`journey_failed` as the reason. Container protection refusals also name the fixed
`protectionFailure` category described above. No identity, raw observation or child output is echoed.
The native check described below starts children in the supervisor's process group.

The runner exits with status 1 for a host refusal. After stopping all children and
removing its lock, the supervisor forwards only the strict host refusal, with an
optional allowlisted protection category, with transport status 0. This means supervision finished; the returned result is still
FAIL. Other non-zero exits, extra fields, malformed output and failed cleanup do
not forward a result. The collector validates the refusal again before saving it.

The host probe reads `/proc/swaps`, the effective `core_pattern`, `core_uses_pid` and
`suid_dumpable` kernel settings, `/sys/kernel/kexec_crash_loaded`, its own core limits,
and the core limits of every process visible in `/proc`. It requires no swap entries,
an empty dump pattern, zero PID suffix and privileged dump settings, no loaded crash
kernel, and zero soft AND hard core limits. Duplicate limits, disappearing processes,
missing observations and unknown values refuse. It changes no setting. Pipe-based
collectors can ignore core limits, and an empty pattern alone can still produce a
PID-named dump; both settings matter ([Linux core documentation](https://man7.org/linux/man-pages/man5/core.5.html)).
The old P4-14 F1/F2 host exceptions never apply to memory.

A safe fixture passes only this host probe. It does not establish coverage of other
process namespaces or guest kernels. Server, bridge, supervisor and proxy buffers
all need disabled swap/dumps; later live checks must measure their actual processes.
Safe observations allow the checks below to run. The collector still withdraws its
earlier result and cannot save PASS with this partial runner.

**Complete live journeys / NOT RUN:** all nine live journeys (`privateTurns`, `nativeRecall`,
`requesterIsolation`, `sessionIsolation`, `invalidation`, `unrelatedActivity`,
`stopReconnect`, `replacementReload`, `persistence`); both complete qualifications
(`P4-14`, `P4-15`); native deployment launch; volatile replies; and immutable deployment
qualification. Their absence holds the later journey on `work/p4-15-pr5i`. Copied
receipts, human UI checks and protocol PASS cannot replace them. Disposable container
fixtures prove refusal and cancellation only. No stack, bootstrap or model call runs
here. Kubernetes collection remains outside this part.

Own checks: [host-runner receipt](../../docs/process/p4-15-pr5h/receipt.md).

## Container prerequisite split

P4-15 PR 5r applies the orchestrator's 5 November 2026 default, not owner approval.
The owner has not answered. The existing safe-host path remains. The alternative
requires a finite positive `memory.max`, `memory.swap.max=0`, no existing swap use,
no loaded crash kernel, zero soft/hard RLIMIT_CORE and PR_GET_DUMPABLE=0 in the
actual runner. Docker memory-swap equal to memory is only configuration; the probe
reads the effective controls itself. Environment claims are never evidence.

The probe resolves `/proc/self/cgroup` against `/proc/self/mountinfo` and checks its
PID in that group's `cgroup.procs`. This first part supports only cgroup v2.
Missing, unlimited, ambiguous, escaped or unreadable observations refuse, as do
covering mounts and membership changes. The Node-API helper sets dumpability once
in the runner and measures it on every check. It checks identity again too. An
exec starts a new process that needs its own protection; zero core limits and
`CoreDumping=0` cannot replace this check. No host configuration is changed.
The runner checks again after awaited work and before returning a receipt.

The container path also reads `/proc/sys/kernel/core_pattern` and
`/proc/sys/fs/suid_dumpable`. A pipe pattern with a non-zero `suid_dumpable` returns
`host_refused` with `protectionFailure: core_helper_enabled`: a helper program can
ignore RLIMIT_CORE and receive a dump even when the process is non-dumpable.
A plain file pattern, or a pipe with `suid_dumpable=0`, allows only the existing
prerequisite result when every container protection also holds. An unreadable or
unknown setting returns `core_pattern_unreadable` or `suid_dumpable_unreadable`.
An empty pattern is valid only when the proc file contains its terminating newline;
an empty read refuses. Only the fixed category and message reach logs and saved
results; the pattern, helper path and read errors stay out. No host setting changes.

This bounded first part ran no native or server journey through the container path.
The later process inventory below now refuses that path before a journey starts.
Equivalent measurements for every other plaintext-bearing process, guest kernels
and both complete qualifications remain NOT RUN. Existing safe-host journeys retain
their PARTIAL/NOT RUN results. The
collector still binds challenges and installations, withdraws failed evidence and
forwards only the fixed host refusal. Injected test observations cannot qualify.
See [own checks](../../docs/process/p4-15-pr5r/receipt.md).

## Private process inventory

The current container inventory names the runner, server delivery, bridge,
supervisor, proxy, native Codex wrapper, native child and any helper that receives
a private test value. `private-processes.ts` is the first bounded part. It reads
the runner's PID and start time from `/proc/<pid>/stat`, executable from `exe`, UID
from `status`, cgroup membership, PID namespace and command arguments. The namespace and the
collector's existing container and installation checks bind the observation to
the measured deployment. A second read around the runner's actual dumpability
check refuses PID reuse, exec, UID, cgroup and namespace changes. The cgroup's
effective finite memory and zero swap controls, and the actual runner's zero
core limits and non-dumpable state, are still measured by the existing probes.

The server delivery process is PID 1 in the package container. The computer
entrypoint's kernel child list gives possible bridge children. The inventory
reads each candidate's identity before checking its fixed command. It includes
the command arguments in both identity reads, so an exec into another Node script
between discovery and the live check refuses even when PID and start time stay the same.
The root computer entrypoint records the launched bridge's PID and Linux start time
in `/run/executor/supervisor/bridge-identity`, under a root-owned directory. The
inventory requires that record and rejects a different child or changed start time.
Both processes call the existing native helper before handling private work. A
local abstract Unix socket answers a fresh challenge with the helper's current
core-limit and dumpability result. The helper's socket probe obtains the peer PID
from Linux, rather than trusting a PID in the answer. The inventory rereads PID,
start time, executable, UID, cgroup, PID namespace and command arguments around that
live check. A client that closes early cannot take down either service's socket server. It
requires the same cgroup and PID namespace as the runner. Unreadable proc files,
including an executable hidden by Linux dump protection, refuse. A disposable
fixture with the required proc access proves the two service checks; it does not
grant that access to a deployment.

The protected target file names `computerContainerId`, the exact Docker
container id for the separate computer. Before the first server journey, the
collector measures its running container, image, start time and host PID. It
executes `bridge-check.ts` inside that container with a fresh challenge, the
server installation id and a digest of the computer installation. The checker
uses the root entrypoint's launch record and the live bridge socket. It reads
swap and dump protection and checks process identity again after the exchange.
The collector checks the exact computer container once more before accepting
the narrow response. A wrong container, changed installation, missing record,
unreadable process or changed bridge returns only a fixed failure category.
The computer may mount its fixed data homes, `/tmp`, `/run` and `/var`.
Mounting executable code paths such as `/app` still refuses. The container
fixture builds the computer image and runs its root entrypoint and packaged
bridge, with a normal `/home/agent` volume and no source-code mount.
Without `computerContainerId`, collection refuses before a journey starts.

The server-container runner still cannot see the bridge in its separate computer
container. It refuses with `complete: false` before any journey begins, even if
the separate bridge check succeeds and its server check passes.
The supervisor forwards a fixed host refusal after cleanup. Both the supervisor
and collector reject `private_process_missing` without `complete: false`. The
collector saves an accepted refusal with the fixed message. An unreadable runner
identity and an identity change have separate fixed categories. Caller-supplied
observations are ignored. The failure carries no PID, path, setting or test value.
The safe-host path is unchanged. The supervisor, proxy, native wrapper, native
child and canary helper groups remain unproved. Both complete qualifications are
NOT RUN. This part does not enable memory or make a container journey pass. The
disposable image test runs two live protected processes and checks missing and
changed identities. See the [own receipt](../../docs/process/p4-15-pr5w2/receipt.md).

The Linux [cgroup contract](https://docs.kernel.org/admin-guide/cgroup-v2.html)
defines the controls. The [exec contract](https://www.man7.org/linux/man-pages/man2/execve.2.html)
explains why dumpability must be measured again after executing a new program.

## Image-owned memory checks

P4-15 PR 5j, Part of #97, owns the shared assertions in `memory-journey.ts`.
The server invalidation suite imports this same file. The package image includes the
runner code and excludes repository test folders and test files.
The runner connects to the measured deployment through its existing NATS settings and
checks SILO_ID against the collector's hash before writing. Each case uses new random
conversation, requester and command ids. MEMORY_KEY_DIRECTORY must name the deployment's
existing memory key store. Facts use its ordinary revision encryption; no plaintext,
keys, private paths or assertion errors are returned. Fixture events remain in that
fresh installation, so a retry needs a new installation as the collector already requires.

For `invalidation`, the shared assertions check Correct and Forget, retained references,
unavailable execution status and exact retry recovery. For `unrelatedActivity`, they check that
correcting or forgetting another fact leaves the loaded context unchanged. These are
server checks with recorded context fixtures, not native memory delivery. Successful
runs return PARTIAL, complete=false. The isolation checks below also return PARTIAL.
The native check is described below. Two other journeys and both qualifications return
NOT RUN, complete=false. Failure returns only FAIL / journey_failed.
The collector binds every returned status to the image, host, silo, installation and
fresh challenge, then saves its protected result. These are challenge-bound receipts,
not cryptographic signatures. The qualification reader still accepts only complete PASS.

Native requester/session isolation, messages/uploads during native work, dispatch/output rejection,
process termination, persistence scans and real native recall remain NOT RUN. No native process starts during these six server checks, and no admission setting changes. The existing supervisor still owns
timeout and process-group cleanup. Tests run shared assertions on disposable NATS and
check denied appends, incomplete results and refusal by the qualification reader.

`memory-image.test.ts` builds the actual `infra/package/Dockerfile` with the root
`.dockerignore`. It checks that repository tests are absent, then calls all six memory
checks inside read-only containers against disposable NATS. Only temporary credentials
are mounted; all executable modules come from the image. Both Correct and Forget must
be saved, and invalidation must occur only for the affected context. Admission must
remain disabled. This test calls the memory checks directly, so it does not claim safe
host settings or live qualification. The separate entry-point test checks host refusal.

## Recorded requester and session isolation

P4-15 PR 5k, Part of #97, adds the first part of the remaining server checks.
`requesterIsolation` and `sessionIsolation` use `memoryJourney.isolatedContext`,
which the server invalidation tests also call. Each runs Correct and Forget with
two recorded contexts on the same assistant and computer. One context loads the
affected fact; the other loads an unrelated fact, either for another requester or
for the same requester in another session. The check requires exact invalidation
of the first context and unchanged saved state and event position for the second.
It rebuilds the second state from events, without a cached summary. Substituting
its thread or input generation in the first context's request must refuse.
Applying the first requester's cause to the second requester's context must refuse;
for the same requester, it must report unchanged because the loaded fact differs.

These two checks return PARTIAL, complete=false. They check recorded contexts,
not native threads, simultaneous canary delivery or requester-visible replies.
The collector keeps its existing challenge-bound, image/host/silo/install-bound
receipts and protected result file; no signature format or admission switch is added.
Denied writes, wrong deployment silos and assertion failures refuse. Image tests
require two contexts per mutation and check whether their requesters should match.
Only fixture credentials are mounted; the helper and assertions come from the image.
The existing supervisor still stops child processes on timeout or collector loss.

Persistence and native replacement/reload remain NOT RUN. Recorded Stop/reconnect
assertions are described below; native Stop/reconnect remains NOT RUN. Native recall, both qualifications, volatile replies and immutable deployment
qualification also remain NOT RUN. The private-turn assertions below remain PARTIAL. The full nine live journeys remain incomplete. No new event or API fields,
dependencies, authority checks or admission changes are introduced.

## Native process assertions

P4-15 PR 5l, Part of #97, adds `native-checks.ts` to `privateTurns`. Host refusal
still happens first. The runner generates two fresh child identities and homes,
independently of the receipt challenge, and starts both Codex processes before making
metadata requests. The helper reuses the production launcher,
configuration and JSON-RPC connection. It never resumes a thread or sends model input.
It checks the Linux x64 Codex 0.159.2 executable hash before launch and through the
running process. It checks the actual executable, parent-child relationship, working
directory, home settings, UID, no-new-privileges setting, core limits and finite positive
process limits. The home and `/run` scratch must use tmpfs. Both soft and hard core limits
must be zero.
It checks process identity and these observations again before returning. Each process
must stay in the runner’s Linux process group.

The native config must disable shell, files, browser access, code-host execution,
external tools, skills instructions, plugins and agent spawning. A new thread must
have no saved path, execution environments or turns. Reading it again must return
the same empty ephemeral thread. Child output is bounded in RAM and never returned.
Failures return only FAIL / journey_failed. Successful assertions return PARTIAL /
complete=false. They cannot prove gVisor isolation or attempted persistence.

The package image now includes the pinned Codex executable, its JavaScript launcher
and the four production helpers used here. `native-image.test.ts` builds that image
and a disposable derivative with only a test loader. The loader substitutes host
observations and individual bad native observations. It runs the shipped entry
without executable mounts, network or a model call. Derivative images remove the
binary or one helper, or replace the launcher link, to check refusal. The unmodified
entry still refuses the real host when its protection cannot be proved. These
fixtures are not deployment qualification. The package's saved-layer check confirms
the exact files, hashes, imports and version in the final image.

Current incomplete checks: `privateTurns` is PARTIAL only when these assertions run;
`requesterIsolation`, `sessionIsolation`, `invalidation`, `unrelatedActivity` and
`stopReconnect` and `replacementReload` are PARTIAL server checks. `nativeRecall` and
`persistence` are NOT RUN. Both complete qualifications, P4-14 and P4-15, are NOT RUN.
Still unproved: gVisor and other process namespaces; live and fault-time storage
scans; actual server, bridge and proxy RAM protection; native caller/catalogue launch;
requester-only volatile replies; native isolation, invalidation and unrelated-activity
journeys; and immutable fresh-install qualification. Admission stays disabled, the
collector cannot save PASS and 5i remains held. Own checks are in the
[receipt](../../docs/process/p4-15-pr5l/receipt.md).

## Simultaneous native processes and cleanup

P4-15 PR 5m, Part of #97, extends the image-owned assertions above. Both wrappers and
native executables must be alive together, with different homes, child identities,
PIDs, process/start identities and empty ephemeral threads. Their environment values
must match their own generated homes and child identities. The first process and
home must disappear before a metadata read from the second returns its original
thread and process identities. The second process and home must then disappear.
Distinct metadata does not establish filesystem isolation between these processes.

Cleanup records each wrapper and native process by PID and Linux start time. It
checks that identity before each signal and while waiting for removal, leaving a
reused PID alone. Each child has one cleanup attempt; later calls reuse its result,
including a failure. Cleanup freezes each wrapper before reading its children, so
a startup still in progress cannot create a child after that read. It kills and checks both processes,
even when startup, RPC or assertions fail. It refuses a surviving process or failed
home removal. A pre-existing home is refused before it belongs to cleanup. A failed
process cleanup retains the homes and refuses. The existing supervisor kills the
whole group on collector EOF; abrupt cancellation may leave homes in tmpfs and
returns no successful receipt. No model input is sent.

The derivative-image tests observe overlap and independent cleanup, check process
liveness after failures, and exercise actual supervisor EOF with two native children.
Only the test loader substitutes bad observations or faults. The ordinary package
now carries the native runtime and production launch helpers, but remains unqualified.
Those shipped files and safe host settings remain prerequisites for a deployment run.
All check and qualification statuses above stay unchanged. Delivery, persistence,
gVisor and fresh-install qualification remain unproved. Own checks are recorded in
[the receipt](../../docs/process/p4-15-pr5m/receipt.md).

## Native recall prerequisites

P4-15 PR 5t, Part of #97, is the first split of the native recall journey.
`native-recall-checks.ts` runs the existing pinned native checks for `nativeRecall`.
It hashes the actual `SILO_ID` and compares it with the collector's measured silo
before and after native work. The runner rechecks host protection after loading
the helper and before returning. It never switches to container-only protection
after starting native work. Missing or replaced Codex, failed process cleanup,
a foreign silo or changed host protection refuses with a fixed failure code.

The collector still owns source SHA, image digest, environment, installation,
run and challenge binding. No receipt fields or admission settings change.
Safe-host success remains `nativeRecall: NOT RUN`, `complete: false`.
Container-only protection starts no native work and remains NOT RUN. Other rows
and both qualifications keep their previous incomplete status.

The disposable backend test reuses `recallBackend` and its scripted native peer.
It starts NATS, PostgreSQL, OpenFGA, the server, bridge and gateway. It saves an
encrypted fact for another member through an event, rebuilds the projection and
checks the question contains neither answer. Recall returns only the requester's
fact. The backend observes the exact loaded reference before delivery; a cold
event read retains it. A request for the foreign scope refuses. The protected
qualification reader also rejects a changed fixture installation.
These observations are test results, not deployment evidence.

The full journey needs more than the agreed approximately 600 changed lines.
This first split does not admit a deployment session, start a model turn, or
produce an answer. Connecting those steps to the existing personal-memory path,
checking the current grant and access after waits, and testing late output,
lost replies, changed facts and concurrent native callers remain outstanding.
No fixture result can turn this runner's NOT RUN into PASS. The deployment still
needs shipped Codex and protection of every process holding private text.
Fresh-install qualification remains NOT RUN and admission remains disabled.
Own checks and the split are recorded in the [receipt](../../docs/process/p4-15-pr5t/receipt.md).

## Native answer checker, local split

P4-15 PR 5t part 2, Part of #97, adds `recallAnswerCheck` in
`native-recall-checks.ts`. It returns a one-use function. Success is PARTIAL with
complete=false; refusals contain only FAIL, journey_failed and complete=false.
There is no receipt input, public API, new event or private-text digest.
The expected fact stays in a buffer which is cleared when the attempt finishes.
JavaScript strings supplied by the caller cannot be overwritten.

The expected binding includes source SHA, image, silo, installation, challenge,
requester, conversation, turn, thread, computer/input generations and process identity.
The local driver must supply trusted observations; these are not deployment evidence.
Its read operation reads saved history and current revisions before checking current
grants. The driver must bound its awaited work under the existing supervisor.
The checker checks host protection after each awaited phase and compares the pinned
Codex executable digest reported by that driver. It does not measure the process itself.
A fresh active thread, an unexpired grant and the exact current reference are required.
The dispatch callback must await `loaded()` before releasing recalled bytes, and feed
`receive()` only from its bound native connection. The checker requires exactly one
saved reference before allowing that delivery, then reads current state again after
native completion. No second dispatch is available after success, failure or overlap.

Only completed agent-message notifications followed by successful turn completion can
match. Question-only output, a returned scripted string without native notifications,
wrong thread/turn, changed binding, old revision, forgotten fact, lost evidence and
late output refuse. Answer comparison stays in RAM and produces no diagnostics.
The caller supplies the other people's known fixture facts. The checker copies these
facts into buffers and clears them after the attempt. It refuses any completed answer
or streamed answer text containing one, even if the requester's fact is present too.
It binds answer messages and streamed text to the ID in the native turn-start
notification. A foreign-turn message or delta permanently refuses the attempt.
The tests use the production JSON-RPC decoder and scripted notifications. The backend
regression starts disposable services and compares the actual recalled fact against
the backend observation captured before delivery and a cold event read.
Correct/Forget, concurrent callers and grant/protection changes in checker tests are
simulated observations, not live mutation or isolation journeys.

The approximately 600-line split leaves the measured deployment driver and its real
native model turn to subsequent work. `journey.ts` deliberately still invokes only
the existing prerequisites; nativeRecall stays NOT RUN. A container whose other
private-text processes are unmeasured also stays NOT RUN. Admission remains disabled.
The sole 5i4 journey owns fresh-install execution; this change performs none.
Own checks: [receipt](../../docs/process/p4-15-pr5t2/receipt.md).

## Recorded Stop and reconnect assertions

P4-15 PR 5n, Part of #97, adds `memoryJourney.stopReconnect`. The runner and a
server test call the same assertions through production `stopInvalidatedMemory`.
Correct and Forget use encrypted loaded-context fixtures and saved invalidation causes.
The matching recorded connection must receive only the exact conversation, turn and
thread Stop. Unsaved or altered events, foreign silos and each changed identity field
must receive nothing. Missing and closed connections are ignored without opening a process.

After a simulated reconnect, replacement turns and unrelated loaded contexts receive
nothing. Only the original matching identity can receive withdrawal again. A failed
send must return `unavailable`; retry must leave the saved event position unchanged.
Cold reads must retain invalidation, unavailable execution and the original references.
The replacement turn and unrelated context must retain their state and event positions. Separate tests supply bad
results, frames and cold reads to prove the assertions refuse them.

`stopReconnect` now returns PARTIAL / complete=false. All other check and qualification
statuses stay unchanged. Recorded sends do not establish native or browser clearance,
persistence or live Stop/reconnect. Those journeys and both qualifications remain NOT RUN.
The collector cannot save PASS, admission stays disabled and queued 5i3 stays held.
The package-image fixture runs the shipped helper with only disposable credentials mounted.
No runtime import enters a test folder. Supervisor limits and cleanup remain unchanged.
Own checks: [build receipt](../../docs/process/p4-15-pr5n/receipt.md).

## Recorded replacement and cold reads

P4-15 PR 5o, Part of #97, adds `memoryJourney.replacementReload` and the production
`privateOutput` / `subscribePrivateOutput` lifecycle checks in `replacement-reload.ts`.
The shared journey saves unrelated Correct and Forget events using the existing encrypted
fixtures. It records computer loss and a replacement with a new computer and generation.
A pending private reply must be captured before connection loss, then its retained
buffer must contain only zeroes. A fresh subscriber receives nothing. A new output
helper refuses the old computer's frame and frames with old computer or input generations.
All captured replies are cleared after their release attempt.

The helper observes synchronous buffer allocation only during capture and restores it
before any await. Recorded sockets exercise production close callbacks and sends;
they are not browser or bridge connections. Fresh `readChatFacts` calls use event reads
without cached summaries. They retain the old loaded references and status, never
execution or private input. An unrelated context and the replacement context keep their
state. Replay leaves event positions unchanged and starts no model, tool or process.
Fault tests supply wrong cold state, retained bytes and unexpected sends.

`replacementReload` returns PARTIAL / complete=false. Other statuses and both
qualification gates stay unchanged. Native replacement, browser reload, persistence
and fresh-install qualification remain NOT RUN. Admission stays disabled.
The package-image fixture runs the shipped helper with only disposable credentials mounted.
Errors remain fixed, and the collector reader refuses a falsely complete result.
Own checks: [build receipt](../../docs/process/p4-15-pr5o/receipt.md).

## Storage scanner first split

P4-15 PR 5u, Part of #97, adds `persistence.ts`. Its caller supplies an in-memory
inventory, a fresh random hexadecimal canary and the measured installation digest.
Each inventory entry names one owned directory and one fixed category: `pvc`,
`rollout`, `cache`, `outbox`, `logs` or `dumps`. All six categories are required.
Several directories may share a category. Only those directories are read.
The scanner opens every path component without following symlinks, reads its actual
Linux mount id and keeps directory device/inode identities between scans.
Nested mounts, hard links, special files, missing or unreadable entries and changed
directories refuse. Hidden files are included. A skipped category cannot pass.

`scan('live', installationId)` must precede `scan('stopped', installationId)`.
A changed installation, repeated phase or earlier failure refuses. The caller must
measure the installation; this argument is not evidence of an actual replacement.
The scan reads synchronously and contains no awaited work. Its buffers compare raw,
UTF-16LE, hexadecimal and base64 representations, including chunk boundaries.
It clears read buffers after each file and retained patterns after completion,
failure or `close()`. It never hashes private bytes or returns paths, contents or
system errors. Results contain PARTIAL, FAIL or NOT RUN, complete=false and counts.
FAIL means private text was found in file contents or a stored name. NOT RUN means
inspection could not finish, including missing or unreadable storage, redirected
paths, changed identities and invalid input. It includes the fixed plain reason
"Storage inspection could not be completed." Both refusals name only the fixed
category and close the scanner. A retry keeps the original status and category;
reading some clean files before a refusal cannot make the inspection complete.

Limits are 128 named directories, 10,000 entries and 256 MiB per scan, 64 MiB per
file, and 64 nested levels. Exceeding a limit refuses. Metadata changes during a
read refuse, but this is not an atomic filesystem snapshot. Encoded or fragmented
forms outside the listed comparisons remain unproved.

This first part has no deployment caller and cannot produce a collector receipt.
Its regression tests also cover intermediate redirects and private output.
The runner's persistence row remains NOT RUN; all other rows and both complete
qualifications retain their holds. No runner, admission, image or enablement
behaviour changes. The next part must derive the complete inventory from the
measured computer's mounts and actual processes, including logs and dumps outside
its namespace. It must run the scanner during a real native personal turn and
after Stop/crash/reconnect, attempt all eight forbidden tool classes, and recheck
host protection after every awaited phase. Disposable writable folders and a
simulated Stop do not prove these native or host conditions. The sole journey
owner must still execute the fresh-install path. The existing collector refuses
copied or incomplete evidence; caller observations cannot make this helper complete.
Own checks: [receipt](../../docs/process/p4-15-pr5u/receipt.md).

## File parser scope and invocation

Part of #97, P4-15 PR 5c, first part. Import `collectEvidence` from `collect.ts`:
`await collectEvidence(bundlePath, expectedRun, observeDeployment)`.
This file parser has no deployment launcher, production writer or admission caller.
Every valid bundle returns `NOT RUN / live_launch_unavailable`; invalid input returns
`FAIL` with a fixed reason. No result can satisfy `personalRecallQualified`.

The deployment owner must supply `expectedRun` from its own current measurements,
never from the bundle, a browser, computer, model or command-line JSON claim.
`observeDeployment` returns the current binding before and after collection. A child
failure must reject its promise; the collector returns only `collection_failed`.
The observer must bound child execution and keep its output private. No child is
started here. These tests inject observations and failures, without a live process.

## Exact contract

The binding contains `sourceSha`, `imageDigest`, `environmentId`, `runId`,
`installationId` and `freshInstall: true`. Reuse the server's `personalRecallQualified`
format checks: full 40-character source SHA, immutable `sha256:` image digest and
bounded environment identity. The deployment owner creates a fresh UUID `runId`
for each run and a different UUID `installationId` whenever the deployment is replaced.
The expected run adds `evidenceDigest`, a SHA-256 digest of the exact manifest bytes.
All receipt digests are covered by that manifest digest. Digests detect changes;
they do not authenticate a test or prove that it ran.

`private-memory.json` is at most 65,536 bytes. It contains the binding,
`result: PASS`, `checks` and `qualifications`. Each array row contains only
`name`, `result: PASS` and `receiptDigest`. Checks must appear exactly once:
`privateTurns`, `nativeRecall`, `requesterIsolation`, `sessionIsolation`, `invalidation`,
`unrelatedActivity`, `stopReconnect`, `replacementReload`, `persistence`.
Qualifications must contain exactly `P4-14` and `P4-15`.

Each receipt lives beside the manifest as `<64 lowercase hex digest characters>.json`.
It is at most 16,384 bytes and contains only the same binding, its row's `name`,
`result: PASS` and `complete: true`. All files must be non-empty regular files;
final symlinks are refused. Extra fields, repeated/unknown checks, absent receipts,
non-PASS results and old run identities refuse collection. Parent directory custody
belongs to the deployment owner. No paths or private content belong in the JSON.

## Live invocation requirements

The deployment-owned journey runner must run both complete qualifications on the
measured fresh install through `collectDeployment`. Existing PASS receipts,
protocol fixtures and hand-written JSON cannot replace that invocation. Replacement
invalidates the old candidate, even when the image and host names stay the same.

The live journey needs simultaneous requester A/B canaries, the same requester in
two sessions, and a later requester. It must use saved facts through real native
recall, gateway, OpenFGA and current grants; answers must be absent from the request.
Revoke, Correct and Forget must stop affected work and reject late output. Unrelated
messages, uploads and memory activity must preserve unaffected turns and readers.
Stop, connection loss, reconnect, replacement and browser reload must clear old
output/grants without repeating work. Live and fault-time scans must inspect PVCs,
rollouts, caches, outbox, logs and dumps while canaries are present and persistence
is attempted. Shell/file/browser tools stay off; RAM, swap, crash dump and pinned
Codex/gVisor checks must pass. Missing launch leaves these journeys NOT RUN.

## Validation and ownership

Run the commands in README.md. The root Vitest include list does not discover this
folder, so the explicit config is required; no CI fixture list is changed.
The root lint and Knip projects include these files. The local TypeScript command
checks them directly. The only setting is the protected target file described above. Dependencies: existing server libraries, MIT Zod and Node built-ins.
No events or public API fields are added. All JSON field names were checked against
the unchanged `RISKY_FIELD_NAME` rule. Receipt digests contain no private text hashes.
Own results and outstanding live work: [receipt](../../docs/process/p4-15-pr5c/receipt.md).
