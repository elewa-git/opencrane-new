# Member authorisation

For people, read [README.md](README.md) first.

`@opencrane/authz` projects member events into OpenFGA. The public entrypoint is
`src/index.ts`; hosts register its `update-openfga` handler with
[`HandlerRuntime`](../handlers/README.md). Commands only append events.
The [catalogue](../../docs/architecture/events.md) owns the subscriptions and
[plan](../../plan.md) owns the architecture. Server wiring is separate work.

```ts
import { createStore, memberAuthorisation } from '@opencrane/authz';

const binding = await createStore('http://127.0.0.1:8080', 'acme');
const authz = memberAuthorisation(binding);
// Pass authz.handler in HandlerRuntime's handlers array; start dispatcher/workers.
const decision = await authz.check('alice', 'admin');
if (!decision.allowed) { /* refuse the operation */ }
```

Persist the store/model ids as deployment configuration; reuse them on restart.
Only provisioning creates models. No public arbitrary tuple-write API is exposed.
The SDK adapter's narrow read/check/write methods are private to this package;
only the handler writes relationships, including during rebuild.
[Model v1](model/v1.fga) is the versioned DSL; its generated JSON is checked against
that DSL in tests. Future teams, assistants and grants can add separate object
and relation types. Their currently reserved subscriptions throw and hold their
stream; they do not silently complete. Invitations do not grant membership.

`member.joined` writes membership and an optional owner/admin role.
`member.role_changed` replaces the elevated role and requires existing membership.
Owners also pass admin checks; every elevated check requires membership.
`member.removed` deletes all that person's silo tuples. A later join can restore
membership. IDs encode both silo and member without delimiter collisions.
Checks always request higher consistency, with no application cache. Errors and
one-second HTTP timeouts return `allowed: false`, `status: 'unavailable'`, and an
internal error with its cause. Do not return that error to an API caller.

The handler uses higher-consistency reads, then one atomic OpenFGA write of the
changes **and an event-id receipt tuple**. A lost response is retried safely;
redelivery of an old join after removal cannot restore access. Duplicate receipt
writes must fail atomically. Receipts are retained for the lifetime of the store.
Event ids must be immutable and unique, and one ordered writer must own each
member stream. The handler validates event data, silo and member subject.
pg-boss owns bounded retries and blocks successors on a failed head; repair and
replay that head through `HandlerRuntime.replay`. HTTP writes throw on failure.

## Rebuild and operation

Production OpenFGA uses the silo PostgreSQL cluster's **`openfga` database**, with
OpenFGA migrations run before startup. This library does not deploy that service.
For an offline rebuild, follow the
[operator runbook](../../apps/ops/README.robot.md#rebuild-openfga-offline). The tool
creates a fresh store/model and replays to the captured global head through the
same handler, checking sequence gaps and silo identity. It returns the new binding
and sequence only on success. Rebuild stores have unique names; failures, ambiguous
create replies and stale stores from an interrupted prior run are cleaned by name.
A cleanup failure is reported with the original error. Switch both readers
and workers to the returned binding before resuming; retain dispatcher/queue state
so later events are processed normally. Already queued events deduplicate using
OpenFGA receipts. Do not clear SQL receipts against an empty store and resume
mid-stream. Rebuild does not run other reactions or mutate the old store.

## Real-service tests and licences

Run `npm test -- libs/authz/test/projection.test.ts` on Linux with Docker and Node
22. `pretest` installs pinned NATS. Tests own OpenFGA containers (memory by default),
a real NATS process and disposable pg-boss databases. Without `PG_TEST_URL`, they
also start/stop PostgreSQL. With it, the selected database is only a control
database and its user needs `CREATEDB`; the suite creates and drops isolated,
randomly named databases so test files can run in parallel. Docker host networking
is required; OpenFGA HTTP/gRPC listen only on 127.0.0.1, and metrics/playground are
disabled. No Docker or PostgreSQL means a failure, not a silently skipped authz
test. CI uses the same fixtures.

The persistence test uses `OPENFGA_TEST_PG_URL` if supplied (a disposable database
which it migrates), otherwise creates its own. The local qualification uses
`postgres://postgres:test@127.0.0.1:55432/openfga_dev`; pg-boss uses a separate fresh
database created through `PG_TEST_URL`. These are test-only credentials.
See [evidence](evidence.md) for results, revocation latency and untested conditions.

Verified licences: [OpenFGA v1.21.0](https://github.com/openfga/openfga/blob/v1.21.0/LICENSE),
[@openfga/sdk 0.9.7](https://github.com/openfga/js-sdk/blob/v0.9.7/LICENSE) and
[@openfga/syntax-transformer 0.2.2](https://github.com/openfga/syntax-transformer/blob/v0.2.2/LICENSE)
are Apache-2.0 (source/npm metadata and installed LICENSE files).
The transformer is dev-only. Axios is overridden to **1.20.0 (MIT)** because the
SDK pins vulnerable 1.19.0. The real-service tests exercise the overridden SDK.
The fixture pins the server image by digest; no new dependency is used by apps/web.

P3-1 adds explicit `resource#use` grants for people, assistants and team members,
plus team membership and assistant ownership relations. `use` and `applied` support
live admission and event-receipt freshness checks. The existing rebuild includes
these grant/team events; replay only restores recorded access. Initial model
grants come from the [model-grant reaction and upgrade](../models/README.robot.md#per-tool-policy-p3-1).
Rebuild into a new OpenFGA store/model binding before switching a running silo.

Use `grantStream(resourceType, resourceId)` for both grant and revoke commands.
The reaction refuses any other subject. This gives the existing worker one
ordering key per resource; splitting a permission across streams is unsafe.

Desktop views additionally require a `shared_desktop` member or team grant, independently
of conversation participation. Grant events use `grantStream('shared_desktop',
computerId)` and project the resource's `use` tuple. The viewer also checks current
event history and receipts for an explicit member grant or current team membership.
Assistant grants cannot admit a human viewer. Delayed revocations fail closed; a
direct member grant stays independent of group membership.

Flat groups reuse `team#member`, assistant `acts_for` and resource `use`; no new
model is needed. [Group commands](../../docs/api/groups.md) append events, never
write tuples directly. Exact-subject checks fence pending membership changes.

## Conversation participants

Group creation writes explicit person tuples for its audience and one `creator` tuple.
`manage_participants = creator and read`; every read still requires silo membership.
Group membership never grants conversation access. Receipts and permission changes
share one atomic OpenFGA write. Rebuild into a fresh model/store before using these
relations. Direct chats and assistant sessions keep their existing tuples.
The server still refuses group mode. Creation and participant IAM jobs share `conversation-<id>` for exact current and legacy subjects in this silo.
The [queue upgrade procedure](../handlers/README.robot.md#conversation-job-keys)
keeps old and new jobs from running under different keys.

OpenFGA needs `--max-tuples-per-write=103`: 100 participants plus creator, silo and
event receipt commit together. The dev stack and fixtures set this limit.
