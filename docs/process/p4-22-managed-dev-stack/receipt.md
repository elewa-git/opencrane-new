# Managed calls in the local development stack

18 October 2026. Product source: `12e2b17941cd4eebbd836e6aa556a4f158896fad`.
The branch was fetched and rebased onto `287f957731b81f83f167d56bd440e89e4dc0e45d`.
The rebase finished and that main commit is an ancestor of this branch.
Secondary id 2 was obtained through `infra/dev-stack/claim.sh`. The owner stack was
not used. No paid provider was called.

## Source checks

| Check | Result |
| --- | --- |
| Failing-first regression commit `26fb3a80` | PASS: all three real setup cases reached switch-on and got 403 instead of 200 before the fix |
| Real provider setup, confirmed spending and replay tests | PASS: 62 provider tests passed twice |
| Switch-on guard tests | PASS: 51 tests passed twice, including reserved reachability, other unreserved sends, expired holds and unknown settlement |
| Dev-stack setup, stub and environment tests | PASS: all 9 tests passed twice |
| Guard removal probes | PASS: removing redirect refusal, either error sanitiser or missing-file handling made the new tests fail; all probes restored |
| Workspace typecheck | PASS |
| Event catalogue | PASS: 143 event types agree |
| Event-security tests | PASS: 438 tests; file unchanged |
| Changelog validation | PASS |
| Lint, including knip | PASS: all stages; code lint has 20 existing warnings and no errors |
| Full root suite | NOT RUN, as requested |

All tests and checks used `nice -n 10`. The integration tests used disposable NATS,
OpenFGA and gateway fixtures plus a dedicated PostgreSQL 17.6 container, with
`PG_TEST_URL=postgres://postgres:test-only@127.0.0.1:47403/postgres`.
The first focused run passed all 551 tests. A concurrent repeat passed the 51
switch-on tests but timed out in the existing in-flight key-save test; the next test
then failed through its leftover mock. A separate rerun passed all 62 provider tests
with no assertion, timeout or product change. The throwaway database and its volume
were removed after testing.

The original switch-on tests seeded successful reachability evidence directly.
They never created the real admission event, which concealed the fresh-install bug.
The new tests keep that event, require exactly one switch-on marker and retry after
projection replay with a new event-store reader. Paid model tests and ordinary
unreserved sends remain refused until confirmed settlement. Unknown settlement
still refuses. No paid settlement is invented for free reachability.

## Fresh-install checks

The first launch stopped before services started because this worktree had no local
Zitadel credential file. The next launch supplied the existing `ZITADEL_KEY_FILE`
setting. It used the same claimed slot and the normal `up.sh --id 2 --fresh` command.

| Check | Result |
| --- | --- |
| Shared provider folder created as the host user, mode 0700; models mount read-only | PASS |
| Stub credential file mode 0600 | PASS |
| Create provider, save credential, reachability, consented model test | PASS |
| Provider status `ready`; non-streaming reply accepted by product verification | PASS |
| Enable chat models, select explicit silo default, start drain | PASS |
| Switch-on accepted and exactly one marker saved | PASS |
| Models restarted without `MODEL_KEY_FILE`, including its running container environment | PASS |
| Member joins after the marker and chats through the explicit default | PASS: 11 default-provider turns; 9 completed replies checked |
| Stub accepts only the managed value after switch-on | PASS: counters started at 0/0 after restart and ended at 12 managed / 0 other |
| Credential value and private locations absent from replies, logs and events | PASS: 372 events, 15 file logs, model container logs, 4 computer logs and the completed member replies |
| Complete `up --fresh` | PASS on the third service-start attempt; earlier results are recorded below |
| Twice-fresh qualification | NOT RUN; one complete passing fresh run, with two failed attempts before it; remains for PR 5e |

The [third attempt's safe counts](attempt-3.json) retain the final checks. The
[first attempt's counts](attempt-1.json) record 303 checked events and the same
12 managed requests, with no other credential. Both desktop-view
checks also passed. The later `typed integration rows` check timed out because the
MCP catalogue worker had stopped with `EVENTS stream is incomplete`; the integration
list returned no rows. Reading all 303 events afterwards succeeded. This attempt
therefore does not claim a complete fresh startup. No access, money or memory check
was weakened, and the journey assertion remains unchanged.

The [second attempt](attempt-2.json), after source checks finished, stopped at
`Provider setup create: 503`. Setup correctly made no later request.
The third fresh attempt used the same source and the same slot, with this task's
lint and tests stopped. It completed `up --fresh`: browser chat, uploads, desktop
viewing, computer recovery, integration rows, audit, budget refusals, projection
replay and loopback listeners all passed. The existing approval journey remains
skipped by the runner; this receipt makes no approval-continuation claim.

The final scan also read nested log files and every current computer Pod's logs.
Only safe counts and booleans are retained here. It checked the provider directory's
host-user ownership and 0700 mode, the stub file's 0600 mode, the read-only mount and
the running models container's environment. The managed value and private locations
were absent from all checked logs, events and replies.

## Images and gateway

| Process | Running image id |
| --- | --- |
| Models: Node 22.23.1 bookworm slim | `sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3` |
| PostgreSQL 17 | `sha256:d74eeac9a635390a49bc21bd49fccd973de707e2a53a76ac49b552b8712ec46f` |
| NATS 2.15.0 alpine | `sha256:ac8f88a6494bffc2c2a5289a0ca61cb28a9145c11ba5677cf24265d07f46d8d4` |
| OpenFGA 1.21.0 | `sha256:2113c664a486b5da8d7a2cdab479e0d4e30639c80fd2c000540f645c1dbc1e55` |
| MinIO RELEASE.2025-10-15T17-29-55Z | `sha256:cf23643a6cf9ce159c57643ceb88279e431262282428c9e0bf3a7ef1a97e84b4` |
| ClamAV 1.5.2 no-unrar | `sha256:701a670a1666ecfac079b9aa5a3716218c4c500c7f96518e1df574ca5b610ace` |

Gateway SHA-256: `daca5cda76e8c5ab0c1a75912fecf2d6365095403f810db72029c49d14a37e7b`.

Teardown: PASS. `down.sh --id 2` removed the stack containers, both namespaces,
private directory and claim. The throwaway test database was removed with its volume.
The owner stack was not used.
