# Live service process checks

8 November 2026. Own build evidence for the server delivery and computer bridge
process checks. This is source evidence, not a fresh installation qualification.

## Outcome

The service processes call the existing native helper before they handle private
work. A local socket returns a fresh protection result. Linux supplies the socket
peer PID. The checker reads PID, start time, executable, UID, cgroup and PID
namespace before and after that result. It refuses a missing, changed or unreadable
process. A saved result or caller observation cannot fill the inventory.
The first identity read includes command arguments before discovery checks the
script. Later reads compare those arguments too, so an exec into another Node
script cannot keep the same PID and start time and pass this check. Both service
sockets destroy a client connection after an error without stopping the service.
The root computer entrypoint now records the bridge PID and Linux start time in
its private runtime directory. Discovery requires that launch record and the
expected bridge script. A replacement child cannot supply its own start time
as the expected value.

The server-container runner cannot read the bridge in the computer's separate PID
namespace. Linux can also hide a protected process's executable from an unprivileged
reader. Both conditions refuse rather than count as proof. Cross-container bridge
proof is NOT RUN and reports `complete: false`. The full container journey remains
incomplete. The supervisor, proxy, native wrapper, native child and
canary helper still lack process proof. Memory admission remains disabled. Neither
complete qualification was run or marked PASS.

## Own checks

| Check | Result |
| --- | --- |
| Failing-first discovery and socket tests | FAIL before implementation, as expected |
| Failing-first replacement test | FAIL before implementation, as expected |
| Changed tests, first run | PASS: 166 tests in seven files |
| Changed tests, second run | PASS: 166 tests in seven files |
| Root entrypoint launch record removal check | PASS: test failed when the write call was removed; call restored |
| Scoped ESLint, repository typecheck and Knip | PASS |
| Qualification TypeScript check | PASS |
| Event catalogue | PASS |
| Changelog and Markdown lint | PASS |
| Root suite, fresh installation and full live journeys | NOT RUN |

The tests use disposable processes and Docker containers. The positive service
fixture grants process inspection access inside that container. It does not change
the deployment's permissions or prove cross-container inspection.
