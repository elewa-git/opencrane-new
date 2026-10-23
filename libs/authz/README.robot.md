# Member authorisation

For people, read [README.md](README.md) first.

`@opencrane/authz` projects member events into OpenFGA. The public entrypoint is
`src/index.ts`; hosts register its `update-openfga` handler with
[`HandlerRuntime`](../handlers/README.md). Commands only append events.
The [catalogue](../../docs/architecture/events.md) owns the subscriptions and
[plan](../../plan.md) owns the architecture. The server and models process use its
access checks; the ops host runs its reaction.

```ts
import { createStore, memberAuthorisation } from '@opencrane/authz';

const binding = await createStore('http://127.0.0.1:8080', 'acme');
const authz = memberAuthorisation(binding, eventStore);
// Pass authz.handler in HandlerRuntime's handlers array; start dispatcher/workers.
const decision = await authz.check('alice', 'admin');
if (!decision.allowed) { /* refuse the operation */ }
```

Persist the store/model ids as deployment configuration; reuse them on restart.
Only provisioning creates models. No public arbitrary tuple-write API is exposed.
The SDK adapter's narrow read/check/write methods are private to this package;
only the handler writes relationships, including during rebuild.
[Model v1](model/v1.fga) is the versioned DSL; its generated JSON is checked against
that DSL in tests. Teams, assistants and grants use separate object and relation
types in the current model. The reaction applies their registered subscriptions.
Invitations do not grant membership.

`member.joined` writes membership and an optional owner/admin role.
`member.role_changed` replaces the elevated role and requires existing membership.
Owners also pass admin checks; every elevated check requires membership.
`member.removed` deletes that person's membership and role tuples on the silo.
It keeps grants, team membership, conversation participants and assistant links.
A later join restores membership and makes those saved relationships available again.
IDs encode both silo and member without delimiter collisions.
Checks always request higher consistency, with no application cache. Errors and
one-second HTTP timeouts return `allowed: false`, `status: 'unavailable'`, and an
internal error with its cause. `applied(eventId)` keeps its boolean contract: it
returns false for a missing receipt or an unavailable OpenFGA check.
`checkApplied(eventId)` returns the full result, including status and the internal
error. Egress uses this method to distinguish an outage from a missing receipt.
Desktop views keep using `applied`: a false result cannot renew a lease, but an
overlapping timeout does not cancel a lease renewed by a healthy check.
Do not return the internal error to an API caller. `test/receipts.test.ts` covers
both receipt methods against real OpenFGA, including an outage and recovery.

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
[@openfga/syntax-transformer 0.2.2](https://github.com/openfga/language/blob/906bdc546a4686c9a31409ac9948c05df9cf8dc6/LICENSE)
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
The server exposes group chat creation and participant changes. Creation and
participant permission jobs share `conversation-<id>` for exact current and legacy
subjects in this silo.
The [queue upgrade procedure](../handlers/README.robot.md#conversation-job-keys)
keeps old and new jobs from running under different keys.

New group creations have at most 97 people including the creator. The person tuples,
creator, silo and event receipt fit OpenFGA's default 100-tuple atomic write limit.
The dev stack and fixtures use that default.

## Older events after later permission changes

Reaction hosts pass their event store as the second argument to `memberAuthorisation`.
Read-only callers can keep passing only the binding. Before changing permissions,
the handler reads later events on the same stream and checks their OpenFGA receipts.
A later applied change for the same person or resource makes the old event a no-op.
The handler saves the old event's receipt and logs why it skipped the change.
Conversation creation checks each participant separately, so a later removal cannot
restore their access. The [full reaction audit](../handlers/README.robot.md#old-event-audit)
lists every currently enabled pair and its test.

Conversation backfill compares global event positions across `conversation-<id>`
and `participation-<id>`. The first stream holds creation and older participant
changes; the second holds new participant changes. A later applied participant
change takes precedence over an older addition or removal. Creation still writes
its immutable creator and silo links, but skips a participant whose latest applied
change is removal. Re-addition restores participation only; the server enforces
the new history interval. Silo rejoin cannot undo an explicit participant removal.
The cross-stream cases in `test/projection.test.ts` compare permissions and event
receipts against a clean rebuild before and after silo removal and rejoin.

Ownership transfers check the owner's authority at the saved transfer, using the
ownership events before it. A later step-down or member removal of the person who
made the transfer does not undo a valid transfer to somebody else. Old grant
removals without a grantee kind check each kind separately. They remove earlier
grants while keeping newer applied grants for the same id.

Member roles saved before ownership was seeded can still be applied. They keep
any later applied ownership change for that person. An old demotion that happened
before the seed can remove a stale owner role when the seed did not include that
person. New owner changes start with a request on the ownership stream.

Saved relationships stay independent of silo membership. A delayed grant, team
addition, participant addition or personal assistant creation still writes its
relationship after the member is removed. Only a later applied change to that
relationship can replace it. Membership checks in the server and models process
still refuse removed people. The real OpenFGA tests save join, relationship and
removal, apply join and removal, backfill the relationship, then save and apply a
rejoin. The resulting tuples and receipts equal a clean rebuild of that history.

Member/Admin changes on an Owner keep its role and record a receipt. See the
[role contract](../../docs/api/members.md#change-a-member-or-admin-role).

Role changes and ownership appointments use separate worker keys. The event-store-backed
handler compares saved global sequences and requires OpenFGA receipts for earlier relevant
changes on the other stream. A role change waits for the ownership seed and earlier changes
for that member. An appointment waits for earlier membership and role changes for its target.
An unmet requirement throws before changing tuples or recording a receipt. The existing
worker retries the job; exhausted retries use its existing dead-letter repair process.
Rebuilds apply events in saved order and need no such wait. `test/role-order.test.ts`
covers both saved orders and both delivery orders, retries, repeated delivery and full
tuple/receipt comparison against replay.

## Shared child records

Shared-child creation writes explicit person participants, creator, silo and receipt
in the existing atomic write. It adds no parent, group or resource relationships.
Delayed creation uses the existing per-person removal guard; replay gives identical tuples.
New owners need `member.ownership_confirmed`: see the [ownership contract](../../docs/api/ownership.md).

## Routine permissions

`memberAuthorisation(binding, eventStore).routine(memberId, routineId, relation)` checks
`read_metadata` or `manage`. It loads routine history with its own ten-second limit,
then checks the member and silo ownership histories, their exact applied receipts and
OpenFGA. It checks access once. This read result is not a write permit; future commands
must still use the existing two-second authority check over small access streams.
No conversation history is read or watched. Missing history, receipts or IAM refuse access.

The model records `silo`, `owner` and `active_silo` relationships. `read_metadata` needs
current silo membership and either recorded ownership or current silo admin status.
`manage` needs the recorded owner and membership through `active_silo`. Retirement
removes `active_silo` while retaining the metadata relationships. Neither relation
grants instructions, private results, profile use, approval or execution.

`update-openfga` applies modern creation, reassignment and retirement atomically with
an event-id receipt. Later applied ownership changes prevent an old creation or transfer
from restoring an earlier owner. Legacy records receive receipts without relationships;
legacy migration is not enabled. Commands still append events and cannot write tuples.
Rebuild uses the existing handler, without SQL, event appends or execution services.

This subscription and model change requires stopped services. Follow the
[handler subscription upgrade](../../apps/ops/README.robot.md#handler-subscription-upgrade)
to drain old work, stop clients and writers, and upgrade the stored manifest. Keep its
startup guard enabled. Rebuild into a fresh OpenFGA store with
`npm run replay -- openfga --confirm-openfga-stopped`, then switch both store/model ids
for readers and workers before restarting. Omit `--verify` when upgrading an older model:
its tuples cannot yet include routines. After the upgrade, `--verify` compares all tuples
and receipts against a stopped current store. Retain queue state and existing receipts.

`test/routines.test.ts` uses real NATS/OpenFGA for owner/admin separation, stale access,
missing receipts, IAM outage, transfers, retirement and replay. No execution is enabled.
Fresh-install execution qualification remains NOT RUN.
