import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OpenFgaClient, ConsistencyPreference } from "@openfga/sdk";
import { transformer } from "@openfga/syntax-transformer";
import { event, natsFixture } from "@opencrane/event-store/testing";
import { parseEventByType, type EventEnvelope } from "@opencrane/events";
import { createLogger } from "@opencrane/observability";
import { pgDb } from "@opencrane/projections";
import { dispatch, HandlerRuntime, provisionDispatcher } from "@opencrane/handlers";
import {
  createStore,
  memberAuthorisation,
  rebuildMembers,
  type Binding,
} from "../src/index.ts";
import model from "../model/v1.json" with { type: "json" };
import { databases, openfga, until } from "./services.ts";

let dbs: Awaited<ReturnType<typeof databases>>;
let fga: Awaited<ReturnType<typeof openfga>>;
beforeAll(async () => {
  dbs = await databases();
  fga = await openfga();
}, 120_000);
afterAll(async () => {
  await fga?.close();
  await dbs?.close();
});
const noSql = { query: () => Promise.reject(new Error("Unexpected SQL")) };

function member(
  id: string,
  type = "member.joined",
  memberId = "alice",
  data = {},
) {
  const raw = event(id, `member-${memberId}`, type);
  const parsed = parseEventByType({ ...raw, data: { ...raw.data, ...data } });
  if (!parsed.success) {
    throw new Error("Invalid test event");
  }
  return parsed.event;
}
async function snapshot(binding: Binding) {
  const client = new OpenFgaClient(binding);
  const rows: string[] = [];
  let token = "";
  do {
    const response = await client.read(
      {},
      {
        continuationToken: token,
        pageSize: 100,
        consistency: ConsistencyPreference.HigherConsistency,
      },
    );
    rows.push(...response.tuples.map(({ key }) => JSON.stringify(key)));
    token = response.continuation_token;
  } while (token);
  return rows.sort();
}
async function apply(
  projection: ReturnType<typeof memberAuthorisation>,
  events: EventEnvelope[],
) {
  for (const event of events) {
    await projection.handler.handle(event, noSql);
  }
}

it("keeps the versioned DSL and installed model identical", async () => {
  const dsl = await readFile(
    new URL("../model/v1.fga", import.meta.url),
    "utf8",
  );
  expect(transformer.transformDSLToJSONObject(dsl)).toEqual(model);
});

it("projects membership, promotions, demotions and removal; refuses other people and silos", async () => {
  const p = memberAuthorisation(await createStore(fga.apiUrl, "test"));
  await apply(p, [member("join", "member.joined", "alice", { role: "owner" })]);
  expect(await p.check("alice", "owner")).toMatchObject({ allowed: true });
  expect(await p.check("alice", "admin")).toMatchObject({ allowed: true });
  expect(await p.check("bob", "member")).toMatchObject({ allowed: false });
  const foreign = memberAuthorisation({ ...p.binding, silo: "other" });
  expect(await foreign.check("alice", "member")).toMatchObject({
    allowed: false,
  });
  await expect(
    foreign.handler.handle(member("bad-silo"), noSql),
  ).rejects.toThrow("silo");
  await apply(p, [
    member("demote", "member.role_changed", "alice", {
      previousRole: "owner",
      newRole: "admin",
    }),
  ]);
  expect(await p.check("alice", "owner")).toMatchObject({ allowed: false });
  expect(await p.check("alice", "admin")).toMatchObject({ allowed: true });
  await apply(p, [
    member("basic", "member.role_changed", "alice", {
      previousRole: "admin",
      newRole: "member",
    }),
  ]);
  expect(await p.check("alice", "admin")).toMatchObject({ allowed: false });
  expect(await p.check("alice", "member")).toMatchObject({ allowed: true });
  await apply(p, [member("remove", "member.removed")]);
  expect(await p.check("alice", "member")).toMatchObject({ allowed: false });
  await expect(
    apply(p, [member("late-role", "member.role_changed")]),
  ).rejects.toThrow("existing member");
  await expect(
    apply(p, [{ ...member("bad-subject"), subject: "member-bob" }]),
  ).rejects.toThrow("subject");
  await expect(
    apply(p, [
      { ...member("bad-role"), data: { memberId: "alice", role: "superuser" } },
    ]),
  ).rejects.toThrow("Invalid");
  const future = parseEventByType({
    ...event("future", "team-t", "team.created"),
    data: { teamId: "t", name: "T", createdBy: "alice" },
  });
  if (!future.success) {
    throw new Error("Invalid future fixture");
  }
  await apply(p, [future.event]);
  expect(await p.applied(future.event.id)).toBe(true);
});

it("survives a committed write with a lost reply, redelivery and complete replay without restoring old roles", async () => {
  const binding = await createStore(fga.apiUrl, "test");
  let loseReply = true;
  // Forward a real transaction, then lose only its reply at the HTTP boundary.
  const proxy = createServer((request, response) => {
    void (async () => {
      const chunks = [];
      for await (const chunk of request) {
        chunks.push(Buffer.from(chunk));
      }
      const upstream = await fetch(`${fga.apiUrl}${request.url ?? ""}`, {
        method: request.method ?? "POST",
        headers: { "content-type": "application/json" },
        body: Buffer.concat(chunks),
      });
      const body = await upstream.text();
      if (request.url?.endsWith("/write") && loseReply) {
        loseReply = false;
        response.destroy();
      } else {
        response.writeHead(upstream.status, {
          "content-type": "application/json",
        });
        response.end(body);
      }
    })().catch(() => response.destroy());
  });
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");
  const address = proxy.address();
  if (!address || typeof address === "string") {
    throw new Error("No proxy port");
  }
  const p = memberAuthorisation({
    ...binding,
    apiUrl: `http://127.0.0.1:${address.port}`,
  });
  const events = [
    member("join"),
    member("role", "member.role_changed"),
    member("remove", "member.removed"),
  ];
  try {
    await expect(apply(p, [events[0]!])).rejects.toThrow();
    expect(await p.check("alice", "member")).toMatchObject({ allowed: true });
    await apply(p, events);
    const before = await snapshot(binding);
    await apply(p, [...events, ...events].reverse());
    expect(await snapshot(binding)).toEqual(before);
    expect(await p.check("alice", "admin")).toMatchObject({ allowed: false });
  } finally {
    proxy.closeAllConnections();
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
  }
});

it("dispatches real NATS events through pg-boss, revokes under 2 seconds and rebuilds the exact tuple set", async () => {
  const nats = await natsFixture();
  const p = memberAuthorisation(await createStore(fga.apiUrl, "test"));
  const db = pgDb(dbs.queue);
  const runtime = new HandlerRuntime({
    db,
    silo: "test",
    handlers: [p.handler],
    logger: createLogger("authz-test", { level: "silent" }),
    retryLimit: 1,
  });
  const controller = new AbortController();
  let task: Promise<void> | undefined;
  async function append(e: EventEnvelope) {
    const history = [];
    for await (const stored of nats.store.readStream(e.subject)) {
      history.push(stored);
    }
    expect(
      (
        await nats.store.append({
          event: e,
          expectedSequence: history.at(-1)?.sequence ?? 0,
        })
      ).status,
    ).toBe("appended");
  }
  try {
    await runtime.start();
    await provisionDispatcher(nats.connection);
    task = dispatch(nats.dispatcherConnection, runtime, controller.signal);
    void task.catch(() => undefined);
    await runtime.work();
    await append(member("j1"));
    await until(async () => (await p.check("alice", "member")).allowed);
    await append(member("r1", "member.role_changed"));
    await until(async () => (await p.check("alice", "admin")).allowed);
    const start = performance.now();
    await append(member("d1", "member.removed"));
    await until(async () => {
      const result = await p.check("alice", "member");
      return result.status === "ok" && !result.allowed;
    }, 2000);
    const latency = performance.now() - start;
    console.log(
      `OpenFGA append-to-denied removal latency: ${latency.toFixed(1)} ms`,
    );
    expect(latency).toBeLessThan(2000);
    await append(member("j2", "member.joined", "bob"));
    await until(async () => (await p.check("bob", "member")).allowed);

    await fga.pause();
    expect(await p.check("bob", "member")).toMatchObject({
      allowed: false,
      status: "unavailable",
    });
    await append(member("d2", "member.removed", "bob"));
    await append(member("j3", "member.joined", "bob"));
    await until(
      async () => (await runtime.deadLetters("update-openfga")).length === 1,
    );
    expect(await runtime.boss.getBlockedKeys("update-openfga")).toEqual([
      "member-bob",
    ]);
    const receipts = await db.query(
      "SELECT event_id FROM handler_receipts WHERE event_id IN ('d2', 'j3')",
    );
    expect(receipts.rows).toEqual([]);
    await fga.resume();
    const head = (await runtime.deadLetters("update-openfga"))[0]!;
    expect(head.retryCount).toBe(1);
    await runtime.replay("update-openfga", head.id);
    await until(
      async () =>
        (
          await db.query(
            "SELECT event_id FROM handler_receipts WHERE event_id = 'j3'",
          )
        ).rows.length === 1,
    );
    expect(await p.check("bob", "member")).toMatchObject({ allowed: true });
    const before = await snapshot(p.binding);
    // Remove local receipts and run every original event through the handler again.
    await db.query(
      "DELETE FROM handler_receipts WHERE handler = 'update-openfga'",
    );
    const all = [];
    const last = await nats.store.head();
    for await (const stored of nats.reader.subscribe(1)) {
      all.push(stored.event);
      if (stored.sequence === last) {
        break;
      }
    }
    await apply(p, all);
    expect(await snapshot(p.binding)).toEqual(before);
    const rebuilt = await rebuildMembers(fga.apiUrl, "test", nats.reader, {
      verifyAgainst: p.binding,
    });
    expect(rebuilt.sequence).toBe(last);
    expect(rebuilt.verified).toBe(true);
    expect(await snapshot(rebuilt.binding)).toEqual(before);
    expect(await rebuilt.check("alice", "member")).toMatchObject({
      allowed: false,
    });
    expect(await rebuilt.check("bob", "member")).toMatchObject({
      allowed: true,
    });
  } finally {
    controller.abort();
    const result = await task?.catch((error: unknown) => error);
    await runtime.stop();
    await nats.close();
    expect(
      result === undefined ||
        (result instanceof Error && result.name === "AbortError"),
    ).toBe(true);
  }
}, 45_000);

it("persists model, tuples and event receipts in PostgreSQL across an OpenFGA restart", async () => {
  const service = await openfga(await dbs.postgres());
  try {
    const p = memberAuthorisation(await createStore(service.apiUrl, "test"));
    const events = [member("join"), member("role", "member.role_changed")];
    await apply(p, events);
    expect(await p.check("alice", "admin")).toMatchObject({ allowed: true });
    const before = await snapshot(p.binding);
    await service.restart();
    expect(await snapshot(p.binding)).toEqual(before);
    await apply(p, events);
    expect(await snapshot(p.binding)).toEqual(before);
    await apply(p, [member("remove", "member.removed")]);
    expect(await p.check("alice", "member")).toMatchObject({ allowed: false });
    await apply(p, events);
    expect(await p.check("alice", "admin")).toMatchObject({ allowed: false });
  } finally {
    await service.close();
  }
}, 45_000);

it("deletes the fresh OpenFGA store when replay fails", async () => {
  const client = new OpenFgaClient({ apiUrl: fga.apiUrl });
  const before = await client.listStores({ pageSize: 100 });
  const source = {
    head: () => Promise.resolve(2),
    async *subscribe() {
      await Promise.resolve();
      yield { sequence: 1, event: member("only") };
      throw new Error("injected replay failure");
    },
  };
  await expect(rebuildMembers(fga.apiUrl, "test", source)).rejects.toThrow(
    "injected replay failure",
  );
  const after = await client.listStores({ pageSize: 100 });
  expect(after.stores.map(({ id }) => id).sort()).toEqual(
    before.stores.map(({ id }) => id).sort(),
  );
});

it("hands events appended during an OpenFGA rebuild to the rebuilt projection", async () => {
  const nats = await natsFixture();
  const live = memberAuthorisation(await createStore(fga.apiUrl, "test"));
  const first = member("arrive-a");
  const second = member("arrive-b", "member.joined", "bob");
  const later = member("arrive-c", "member.joined", "carol");
  async function appendFixture(event: EventEnvelope) {
    const result = await nats.store.append({ event, expectedSequence: 0 });
    if (result.status !== "appended") throw new Error("Fixture append failed");
  }
  try {
    await appendFixture(first);
    await appendFixture(second);
    await apply(live, [first, second]);
    let appended = false;
    const arriving = {
      head: () => nats.reader.head(),
      async *subscribe(fromSequence: number, signal?: AbortSignal) {
        for await (const stored of nats.reader.subscribe(fromSequence, signal)) {
          yield stored;
          if (!appended) {
            appended = true;
            await appendFixture(later);
          }
        }
      },
    };
    const rebuilt = await rebuildMembers(fga.apiUrl, "test", arriving, {
      verifyAgainst: live.binding,
    });
    expect(rebuilt.sequence).toBe(2);
    expect(await nats.store.head()).toBe(3);
    await apply(rebuilt, [later]);
    await apply(live, [later]);
    expect(await snapshot(rebuilt.binding)).toEqual(await snapshot(live.binding));
  } finally {
    await nats.close();
  }
});

it("deletes the fresh OpenFGA store when model creation fails", async () => {
  const client = new OpenFgaClient({ apiUrl: fga.apiUrl });
  const before = await client.listStores({ pageSize: 100 });
  const proxy = createServer((request, response) => {
    void (async () => {
      const chunks = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      if (request.url?.endsWith("/authorization-models")) {
        response.writeHead(500, { "content-type": "application/json" });
        response.end('{"message":"injected model failure"}');
        return;
      }
      const upstream = await fetch(`${fga.apiUrl}${request.url ?? ""}`, {
        method: request.method ?? "POST",
        headers: { "content-type": "application/json" },
        ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
      });
      response.writeHead(upstream.status, { "content-type": "application/json" });
      response.end(await upstream.text());
    })().catch(() => response.destroy());
  });
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");
  const address = proxy.address();
  if (!address || typeof address === "string") throw new Error("No proxy port");
  try {
    await expect(createStore(`http://127.0.0.1:${address.port}`, "test"))
      .rejects.toThrow();
    const after = await client.listStores({ pageSize: 100 });
    expect(after.stores.map(({ id }) => id).sort()).toEqual(
      before.stores.map(({ id }) => id).sort(),
    );
  } finally {
    proxy.closeAllConnections();
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
  }
});

describe("PostgreSQL-backed rebuild cleanup", () => {
  let service: Awaited<ReturnType<typeof openfga>>;
  beforeAll(async () => {
    service = await openfga(await dbs.postgres());
  }, 120_000);
  afterAll(async () => {
    await service?.close();
  });

  it("cleans a rebuild store when the create response is lost at the HTTP boundary", async () => {
    const client = new OpenFgaClient({ apiUrl: service.apiUrl });
    const before = await client.listStores({ pageSize: 100 });
    let releaseCreate: () => void = () => undefined;
    const allowCreate = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    let markCreateCommitted: () => void = () => undefined;
    const createCommitted = new Promise<void>((resolve) => {
      markCreateCommitted = resolve;
    });
    let firstListCompleted = false;
    let createCommittedAfterFirstList = false;
    function proxyRequest(request: IncomingMessage, response: ServerResponse) {
      void handleProxyRequest(request, response);
    }
    async function handleProxyRequest(request: IncomingMessage, response: ServerResponse) {
      try {
        const chunks = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const isStoreList = request.method === "GET" && request.url?.startsWith("/stores");
        if (isStoreList && firstListCompleted) {
          // The retry list must wait until the lost create response is known to have committed.
          await createCommitted;
        }
        const isStoreCreate = request.method === "POST" && request.url === "/stores";
        if (isStoreCreate) {
          await allowCreate;
        }
        const upstream = await fetch(`${service.apiUrl}${request.url ?? ""}`, {
          method: request.method ?? "POST",
          headers: { "content-type": "application/json" },
          ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
        });
        const body = await upstream.text();
        if (isStoreCreate) {
          createCommittedAfterFirstList = firstListCompleted;
          markCreateCommitted();
          response.destroy();
          return;
        }
        response.writeHead(upstream.status, { "content-type": "application/json" });
        response.end(body);
        if (isStoreList) {
          firstListCompleted = true;
          releaseCreate();
        }
      } catch {
        response.destroy();
      }
    }
    const proxy = createServer(proxyRequest);
    proxy.listen(0, "127.0.0.1");
    await once(proxy, "listening");
    const address = proxy.address();
    if (!address || typeof address === "string") throw new Error("No proxy port");
    const empty = {
      head: () => Promise.resolve(0),
      async *subscribe() {
        await Promise.resolve();
        yield { sequence: 1, event: member("unused") };
      },
    };
    try {
      await expect(
        rebuildMembers(`http://127.0.0.1:${address.port}`, "lost", empty),
      ).rejects.toThrow();
      const after = await client.listStores({ pageSize: 100 });
      expect(createCommittedAfterFirstList).toBe(true);
      expect(after.stores.map(({ id }) => id).sort()).toEqual(
        before.stores.map(({ id }) => id).sort(),
      );
    } finally {
      await stopProxy();
    }

    async function stopProxy() {
      proxy.closeAllConnections();
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
    }
  });
});

it("preserves a rebuild store created by an earlier run", async () => {
  const client = new OpenFgaClient({ apiUrl: fga.apiUrl });
  const retained = await client.createStore({ name: "members-recovery-rebuild-retained" });
  const empty = { head: () => Promise.resolve(0), async *subscribe() {
    await Promise.resolve();
    yield { sequence: 1, event: member("unused") };
  } };
  const rebuilt = await rebuildMembers(fga.apiUrl, "recovery", empty);
  try {
    const stores = await client.listStores({ pageSize: 100 });
    expect(stores.stores.some(({ id }) => id === retained.id)).toBe(true);
    expect(stores.stores.some(({ id }) => id === rebuilt.binding.storeId)).toBe(true);
  } finally {
    await client.deleteStore({ storeId: retained.id });
    await new OpenFgaClient(rebuilt.binding).deleteStore();
  }
});

it('rejects alternate grant streams and keeps grant then revoke denied through the real ordered worker and replay', async () => {
  const p = memberAuthorisation(await createStore(fga.apiUrl, 'test'));
  const subject = `grant-${Buffer.from(JSON.stringify(['model', 'gpt-6-luna'])).toString('base64url')}`;
  const given: EventEnvelope = { ...event('resource-given', subject, 'grant.given'), principal: { kind: 'human', id: 'alice' }, correlation: {}, data: {
    resourceType: 'model', resourceId: 'gpt-6-luna', granteeId: 'alice', granteeKind: 'member', grantedBy: 'alice' } };
  const revoked: EventEnvelope = { ...event('resource-revoked', subject, 'grant.revoked'), principal: { kind: 'human', id: 'alice' }, correlation: {}, data: {
    resourceType: 'model', resourceId: 'gpt-6-luna', granteeId: 'alice', revokedBy: 'alice' } };
  await expect(apply(p, [{ ...given, subject: 'grant-alternate' }])).rejects.toThrow('Grant subject mismatch');
  expect(await p.applied(given.id)).toBe(false);
  const nats = await natsFixture(), controller = new AbortController();
  const isolated = await databases();
  const runtime = new HandlerRuntime({ db: pgDb(isolated.queue), silo: 'test', handlers: [p.handler], logger: createLogger('grant-order', { level: 'silent' }) });
  let task: Promise<void> | undefined;
  try {
    expect((await nats.store.append({ event: given, expectedSequence: 0 })).status).toBe('appended');
    expect((await nats.store.append({ event: revoked, expectedSequence: 1 })).status).toBe('appended');
    await runtime.start(); await provisionDispatcher(nats.connection);
    task = dispatch(nats.dispatcherConnection, runtime, controller.signal); void task.catch(() => undefined);
    await runtime.work();
    await until(() => p.applied(revoked.id));
    expect(await p.applied(given.id)).toBe(true);
    expect((await p.use('person', 'alice', 'model', 'gpt-6-luna')).allowed).toBe(false);
    await apply(p, [given]); // A late redelivery cannot restore the old grant.
    expect((await p.use('person', 'alice', 'model', 'gpt-6-luna')).allowed).toBe(false);
    const rebuilt = await rebuildMembers(fga.apiUrl, 'test', nats.reader, { verifyAgainst: p.binding });
    expect((await rebuilt.use('person', 'alice', 'model', 'gpt-6-luna')).allowed).toBe(false);
  } finally {
    controller.abort(); await task?.catch(() => undefined); await runtime.stop(); await nats.close(); await isolated.close();
  }
}, 40_000);


async function oldMemberEventAfterRemoval(type: string) {
  const nats = await natsFixture();
  try {
    const old = member(`old-${type}`, type, 'alice', {
      previousRole: 'member', newRole: 'admin', email: 'alice@example.test',
      displayName: 'Alice', identityIssuer: 'test', identitySub: 'alice',
    });
    const joined = member('first-join');
    const removal = member('later-removal', 'member.removed');
    await nats.seed([joined, old, removal]);
    const projection = memberAuthorisation(await createStore(fga.apiUrl, 'test'), nats.store);
    await apply(projection, [joined, removal]);
    await apply(projection, [old]);
    expect(await projection.check('alice', 'member')).toMatchObject({ allowed: false });
    expect(await projection.applied(old.id)).toBe(true);
  } finally {
    await nats.close();
  }
}
it.each(['member.joined', 'silo.owner_bootstrapped', 'member.role_changed'])(
  'receipts an old %s after removal without restoring access', oldMemberEventAfterRemoval);
