import { ChildProcess, execFile } from 'node:child_process';
import { readFile, rename, stat, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { z } from 'zod';
import { promisify } from 'node:util';
import { databases } from '@opencrane/authz/testing';
import { createLogger } from '@opencrane/observability';
import { pgDb, ProjectionRunner, mcpCatalogue } from '@opencrane/projections';
import { expect, it, onTestFinished, vi } from 'vitest';
import { gatewayObservationSchema, getEventDefinition, eventEnvelopeSchema } from '@opencrane/events';
import { lostReplyStore, natsFixture } from '@opencrane/event-store/testing';
import { catalogueDigest, toolReviewDigest } from '@opencrane/events/mcp-catalogue';
import { losslessJson } from '@opencrane/events/lossless-json';
import { toolPolicyFromRows } from '../src/tool-policy.ts';
import { publicationEntry } from '../src/publication.ts';
import { envelope, history } from '../src/actor.ts';
import { publicationDigest } from '../src/publication.ts';
import { gatewayConfigurationCurrent, prepareGatewayConfiguration }
  from '../src/gateway-generation.ts';
import { startGateway } from '../src/gateway.ts';
import { gatewayDelivery } from '../src/gateway-delivery.ts';
import { freePort, gatewayFixture } from './gateway-delivery-fixture.ts';

const appendEventSchema = eventEnvelopeSchema(z.unknown());

async function fixture() {
  const nats = await natsFixture();
  async function closeNats() {
    await nats.close();
  }
  onTestFinished(closeNats);
  const setup = await gatewayFixture();
  const faulty = await lostReplyStore(nats.connection);
  function declaration(name: string) {
    const definition = JSON.stringify({ name, description: 'CATALOGUE-CANARY',
      inputSchema: { type: 'object' } });
    return { name, definition, revision: losslessJson(definition).digest,
      reviewed: false, costCents: 0 as const };
  }
  const tools = ['read', 'delete'].map(declaration);
  const now = Date.now();
  const catalogue = { serverId: 'alpha', connectionId: 'installed', accountMode: 'none',
    toolCount: 2, tools, schemaDigest: catalogueDigest(tools),
    checkedAt: new Date(now).toISOString(), expiresAt: new Date(now + 300_000).toISOString() };
  await nats.seed([envelope('test', 'mcp-alpha', 'mcp.server_registered',
    { serverId: 'alpha', kind: 'remote', locator: 'https://fixture.example.test',
      registeredBy: 'admin' })]);
  await nats.seed([envelope('test', 'mcp-alpha', 'mcp.server_discovered', catalogue)]);
  function choice(tool: typeof tools[number]) {
    const mode = tool.name === 'read' ? 'allow' : 'block';
    return { name: tool.name, revision: tool.revision, mode, reviewDigest: toolReviewDigest(tool) };
  }
  const review = { serverId: 'alpha', connectionId: 'installed', accountMode: 'none',
    catalogueDigest: catalogue.schemaDigest, policyRevision: await nats.store.head('mcp-alpha'),
    reviewedBy: 'admin', tools: tools.map(choice) };
  const reviewed = envelope('test', 'mcp-alpha', 'mcp.server_reviewed', review);
  reviewed.principal = { kind: 'human', id: 'admin' };
  await nats.seed([reviewed]);
  const policy = toolPolicyFromRows(await history(nats.store, 'mcp-alpha', 'test'));
  const entry = publicationEntry(policy)!;
  const intent = { serverId: 'alpha', publishedBy: 'admin', commandId: 'publish-alpha',
    expectedSequence: policy.sequence, reviewRevision: policy.reviewRevision,
    fragmentDigest: publicationDigest(entry) };
  await nats.seed([envelope('test', 'mcp-alpha', 'mcp.server_published', intent)]);
  const member = { entry, sourceSequence: await nats.store.head('mcp-alpha'),
    fragmentDigest: publicationDigest(entry), changeRef: 'publish-alpha' };
  const saved = { changeRef: 'publish-alpha', generation: 1, rendererVersion: '1' as const,
    members: [member] };
  const record = { ...saved, recordDigest: publicationDigest(saved) };
  await nats.seed([envelope('test', 'gateway-config-test', 'gateway.configuration_requested', record)]);
  const settings = { ...setup.options,
    memoryRoute: { serverId: 'memory', connectionId: 'internal', upstream: 'unused' } };
  const options = { mode: 'live' as const, store: faulty.store, silo: 'test', child: setup.child,
    configFile: setup.options.configFile, controlPort: await freePort(), settings };
  const delivery = gatewayDelivery(options);
  await delivery.deliver(record);
  async function acknowledged() {
    expect(await delivery.observe()).not.toBeNull();
  }
  return { ...setup, nats, record, delivery, options, acknowledged, faulty };
}

async function recordsOnlyLiveAcknowledgement() {
  const setup = await fixture();
  const subject = 'gateway-config-test';
  expect(await history(setup.nats.store, subject, 'test')).toHaveLength(1);
  setup.faulty.loseNextReply();
  await expect.poll(setup.acknowledged, { timeout: 5000 }).toBeUndefined();
  const rows = await history(setup.nats.store, subject, 'test');
  expect(rows).toHaveLength(2);
  expect(rows[1]!.event.type).toBe('gateway.configuration_observed');
  expect(rows[1]!.event.data).toMatchObject({ generation: 1,
    recordDigest: setup.record.recordDigest, outcome: 'loaded' });
  expect(await setup.delivery.observe()).toEqual(rows[1]);
  expect(await gatewayConfigurationCurrent(setup.nats.store, 'test', setup.record)).toBe(true);
  expect(await prepareGatewayConfiguration(setup.nats.store, 'test', 'alpha', 'publish-alpha'))
    .toEqual(setup.record);
  const replay = gatewayDelivery({ ...setup.options, mode: 'replay' });
  expect(await replay.observe()).toBeNull();
  const bytes = await readFile(setup.options.configFile);
  await replay.deliver(setup.record);
  expect(await replay.observe()).toBeNull();
  expect(await readFile(setup.options.configFile)).toEqual(bytes);
  expect(await history(setup.nats.store, subject, 'test')).toHaveLength(2);
  await setup.gateway.stop('SIGKILL');
  expect(await setup.delivery.observe()).toBeNull();
  let child: ChildProcess | undefined;
  function spawned(value: ChildProcess) {
    child = value;
  }
  const gateway = await startGateway({ ...setup.options.settings, onChildSpawn: spawned });
  async function stop() {
    await gateway.stop('SIGKILL');
  }
  onTestFinished(stop);
  const replacement = gatewayDelivery({ ...setup.options, child: child! });
  expect(await replacement.observe()).toBeNull();
  await replacement.deliver(setup.record);
  async function reobserved() {
    expect(await replacement.observe()).not.toBeNull();
  }
  await expect.poll(reobserved, { timeout: 5000 }).toBeUndefined();
  const later = await history(setup.nats.store, subject, 'test');
  expect(later).toHaveLength(3);
  const first = gatewayObservationSchema.parse(rows[1]!.event.data);
  const second = gatewayObservationSchema.parse(later[2]!.event.data);
  expect(second.processRef).not.toBe(first.processRef);
  expect(await memberReceipts(setup)).toHaveLength(1);
  await setup.nats.seed([envelope('test', 'mcp-alpha', 'mcp.server_unpublished',
    { serverId: 'alpha', unpublishedBy: 'admin' })]);
  expect(await replacement.observe()).toBeNull();
}
it('records one exact live observation; replay and another process cannot acknowledge',
  recordsOnlyLiveAcknowledgement);

async function sends(setup: Awaited<ReturnType<typeof fixture>>, method: string,
  extra: string[]) {
  const content = '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"read"}}';
  const headers = ['content-length', String(Buffer.byteLength(content)),
    'host', 'localhost', 'authorization', `Bearer ${setup.pass}`,
    'content-type', 'application/json',
    'mcp-protocol-version', '2026-07-28', 'x-request-id', 'fixture', ...extra];
  return new Promise<number>(send);
  function send(resolve: (status: number) => void, reject: (error: Error) => void) {
    const options = { hostname: '127.0.0.1', port: setup.options.settings.port,
      path: '/mcp/alpha/installed', method, headers, signal: AbortSignal.timeout(2000) };
    function received(response: import('node:http').IncomingMessage) {
      response.resume();
      response.on('end', completed);
      function completed() {
        resolve(response.statusCode!);
      }
    }
    const outgoing = request(options, received);
    outgoing.on('error', reject);
    outgoing.end(content);
  }
}

async function enforcesRenderedRules() {
  const setup = await fixture();
  await expect.poll(setup.acknowledged, { timeout: 5000 }).toBeUndefined();
  const allowed = ['mcp-method', 'tools/call', 'mcp-name', 'read'];
  expect(await sends(setup, 'POST', allowed)).toBe(200);
  function dispatched(item: typeof setup.traffic[number]) {
    return item.path.startsWith('/dispatch');
  }
  expect(setup.traffic.filter(dispatched)).toHaveLength(1);
  const refused = [[], ['mcp-name', 'read'], ['mcp-method', 'tools/call'],
    ['mcp-method', 'tools/list', 'mcp-name', 'read'],
    ['mcp-method', 'tools/call', 'mcp-name', 'delete'],
    ['mcp-method', 'tools/call', 'mcp-name', 'unreviewed'],
    [...allowed, 'mcp-name', 'read'], [...allowed, 'mcp-name', ''],
    [...allowed, 'mcp-method', 'tools/call'], [...allowed, 'mcp-method', '']];
  for (const headers of refused) {
    expect(await sends(setup, 'POST', headers)).toBeGreaterThanOrEqual(400);
  }
  for (const method of ['GET', 'HEAD', 'OPTIONS', 'PUT', 'PATCH', 'DELETE']) {
    expect(await sends(setup, method, allowed)).toBeGreaterThanOrEqual(400);
  }
  expect(setup.traffic.filter(dispatched)).toHaveLength(1);
  const identity = { 'x-opencrane-gateway-generation': '1',
    'x-opencrane-record-digest': setup.record.recordDigest, 'x-opencrane-server-id': 'alpha',
    'x-opencrane-connection-id': 'installed', 'x-opencrane-review-revision': String(setup.record.members[0]!.entry.reviewRevision) };
  for (const copies of [1, 2]) {
    const spoofed = [...allowed, 'x-private-canary', 'CLIENT-HEADER-CANARY'];
    for (const name of Object.keys(identity)) {
      for (let index = 0; index < copies; index++) {
        spoofed.push(name, 'CLIENT-HEADER-CANARY');
      }
    }
    expect(await sends(setup, 'POST', spoofed)).toBe(200);
    expect(setup.traffic.at(-2)!.headers).toMatchObject(identity);
  }
  const outbound = setup.traffic.filter(dispatched);
  for (const item of outbound) {
    expect(Object.keys(item.headers).sort()).toEqual(['accept', 'content-length', 'content-type',
      'host', 'mcp-method', 'mcp-name', 'mcp-protocol-version', 'x-opencrane-mcp-permit', 'x-request-id']);
  }
  const evidence = JSON.stringify([await readFile(setup.options.configFile, 'utf8'),
    setup.traffic, setup.logs]);
  for (const canary of ['KEY-FILE-CANARY', 'CLIENT-HEADER-CANARY', 'CATALOGUE-CANARY']) {
    expect(evidence).not.toContain(canary);
  }
}
it('enforces reviewed rules before an allow-all stub and removes spoofed identity headers',
  enforcesRenderedRules);

async function rejectsStaleOrWrongWitnesses() {
  const setup = await fixture();
  await expect.poll(setup.acknowledged, { timeout: 5000 }).toBeUndefined();
  const { recordDigest: _oldDigest, ...previous } = setup.record;
  const saved = { ...previous, generation: 2, changeRef: 'second' };
  const next = { ...saved, recordDigest: publicationDigest(saved) };
  await setup.nats.seed([envelope('test', 'gateway-config-test',
    'gateway.configuration_requested', next)]);
  const settings = { ...setup.options.settings, keyFile: `${setup.options.configFile}.missing` };
  const rejectedDelivery = gatewayDelivery({ ...setup.options, settings });
  await rejectedDelivery.deliver(next);
  function rejected() {
    expect(setup.logs.join('')).toContain('Failed to reload config');
  }
  await expect.poll(rejected, { timeout: 5000 }).toBeUndefined();
  expect(await sends(setup, 'POST', ['mcp-method', 'tools/call', 'mcp-name', 'read'])).toBe(200);
  expect(await rejectedDelivery.observe()).toBeNull();
  expect(await setup.delivery.observe()).toBeNull();
  await setup.nats.seed([envelope('test', 'mcp-alpha', 'mcp.server_unpublished',
    { serverId: 'alpha', unpublishedBy: 'admin' })]);
  expect(await setup.delivery.observe()).toBeNull();
  expect(await gatewayConfigurationCurrent(setup.nats.store, 'test', setup.record)).toBe(false);
  expect(await history(setup.nats.store, 'gateway-config-test', 'test')).toHaveLength(3);
}
it('keeps old routes on rejected reload and refuses acknowledgement after withdrawal',
  rejectsStaleOrWrongWitnesses);

async function wrongWitness() {
  const setup = await fixture();
  const bytes = await readFile(setup.options.configFile, 'utf8');
  for (const field of ['generation', 'recordDigest', 'configDigest', 'processRef']) {
    const pattern = new RegExp(String.raw`(\\"${field}\\":)(\\"[^"]+\\"|[0-9]+)`, 'u');
    const changed = bytes.replace(pattern, '$1null');
    expect(changed).not.toBe(bytes);
    const sibling = `${setup.options.configFile}.wrong`;
    await writeFile(sibling, changed, { mode: 0o600 });
    await rename(sibling, setup.options.configFile);
    // Read the real control response before asking the delivery module to accept it.
    const path = /\/configuration\/1\/[a-f0-9-]+/u.exec(bytes)![0];
    async function wrongServes() {
      const response = await fetch(`http://127.0.0.1:${setup.options.controlPort}${path}`,
        { signal: AbortSignal.timeout(1000) });
      expect(await response.text()).toContain(`"${field}":null`);
    }
    await expect.poll(wrongServes, { timeout: 5000 }).toBeUndefined();
    expect(await setup.delivery.observe()).toBeNull();
  }
  expect(await history(setup.nats.store, 'gateway-config-test', 'test')).toHaveLength(1);
}
it('refuses wrong generation, either digest or process identity from the live listener', wrongWitness);

async function waitForDeliveredWitness(setup: Awaited<ReturnType<typeof fixture>>) {
  const bytes = await readFile(setup.options.configFile, 'utf8');
  const path = /\/configuration\/1\/[a-f0-9-]+/u.exec(bytes)![0];
  async function servesWitness() {
    const url = `http://127.0.0.1:${setup.options.controlPort}${path}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
    expect(response.status).toBe(200);
    const segments = path.split('/');
    const expected = { generation: 1, recordDigest: setup.record.recordDigest,
      processRef: segments.at(-1) };
    expect(await response.json()).toMatchObject(expected);
  }
  await expect.poll(servesWitness, { timeout: 5000 }).toBeUndefined();
}

const observationRaces = [
  { change: 'withdrawal', during: 'source read', cached: false },
  { change: 'preparation', during: 'source read', cached: false },
  { change: 'withdrawal', during: 'readback', cached: false },
  { change: 'preparation', during: 'readback', cached: false },
  { change: 'child exit', during: 'readback', cached: false },
  { change: 'replacement delivery', during: 'readback', cached: false },
  { change: 'withdrawal', during: 'source read', cached: true },
] as const;

async function refusesObservationRace(race: typeof observationRaces[number]) {
  const setup = await fixture();
  let armed = false;
  let changed = false;
  const append = setup.options.store.append.bind(setup.options.store);
  async function* readStream(subject: string, from = 1, deadline = Infinity) {
    const rows = [];
    for await (const row of setup.options.store.readStream(subject, from, deadline)) {
      rows.push(row);
    }
    if (armed && race.during === 'source read' && subject === 'mcp-alpha') {
      await change();
    }
    yield* rows;
  }
  const store = { append, readStream, head, readEvent };
  const options = { ...setup.options, store };
  const delivery = gatewayDelivery(options);
  async function change() {
    changed = true;
    armed = false;
    if (race.change === 'withdrawal') {
      const event = envelope('test', 'mcp-alpha', 'mcp.server_unpublished',
        { serverId: 'alpha', unpublishedBy: 'admin' });
      await setup.nats.seed([event]);
    } else if (race.change === 'preparation') {
      const { recordDigest: _digest, ...previous } = setup.record;
      const saved = { ...previous, generation: 2, changeRef: 'second' };
      const record = { ...saved, recordDigest: publicationDigest(saved) };
      const event = envelope('test', 'gateway-config-test',
        'gateway.configuration_requested', record);
      await setup.nats.seed([event]);
    } else if (race.change === 'child exit') {
      await setup.gateway.stop('SIGKILL');
    } else {
      await delivery.deliver(setup.record);
    }
  }
  async function head(subject?: string) {
    const position = await setup.options.store.head(subject);
    return position;
  }
  async function readEvent(sequence: number) {
    const row = await setup.options.store.readEvent(sequence);
    if (armed && race.during === 'readback' &&
        row.event.type === 'gateway.configuration_observed') {
      await change();
    }
    return row;
  }
  await delivery.deliver(setup.record);
  await waitForDeliveredWitness(setup);
  if (race.cached) {
    expect(await delivery.observe()).not.toBeNull();
  }
  armed = true;
  const receipt = await delivery.observe();
  expect(changed).toBe(true);
  expect(receipt).toBeNull();
  expect(await memberReceipts(setup)).toHaveLength(race.cached ? 1 : 0);
  if (race.change === 'withdrawal' || race.change === 'preparation') {
    expect(await gatewayConfigurationCurrent(setup.nats.store, 'test', setup.record)).toBe(false);
    expect(await delivery.observe()).toBeNull();
  }
  const rows = await history(setup.nats.store, 'gateway-config-test', 'test');
  function observed(row: typeof rows[number]) {
    return row.event.type === 'gateway.configuration_observed';
  }
  const observations = rows.filter(observed);
  if (race.change === 'preparation' && race.during === 'source read') {
    expect(observations).toHaveLength(0);
  } else {
    expect(observations).toHaveLength(1);
  }
}
it.each(observationRaces)(
  'refuses $change during $during (saved receipt: $cached)', refusesObservationRace);

async function replacesPrivateFile() {
  const setup = await fixture();
  const before = await stat(setup.options.configFile);
  expect(before.mode & 0o777).toBe(0o600);
  await setup.delivery.deliver(setup.record);
  const after = await stat(setup.options.configFile);
  expect(after.mode & 0o777).toBe(0o600);
  expect(after.ino).not.toBe(before.ino);
  await waitForDeliveredWitness(setup);
}
it('replaces the delivered file with a new private inode', replacesPrivateFile);

async function refusesUnavailableDelivery() {
  const setup = await fixture();
  const unspawnedOptions = { ...setup.options, child: new ChildProcess() };
  const unspawned = gatewayDelivery(unspawnedOptions);
  await expect(unspawned.deliver(setup.record)).rejects.toThrow('Gateway delivery unavailable');
  const first = setup.delivery.deliver(setup.record);
  const second = setup.delivery.deliver(setup.record);
  await expect(second).rejects.toThrow('Gateway delivery unavailable');
  await first;
  await setup.gateway.stop('SIGKILL');
  await expect(setup.delivery.deliver(setup.record)).rejects.toThrow('Gateway delivery unavailable');
}
it('refuses delivery to an unspawned or stopped child and during another write',
  refusesUnavailableDelivery);

async function refusesInvalidControlPort() {
  const setup = await fixture();
  const before = await readFile(setup.options.configFile);
  for (const controlPort of [0, -1, 65536, 1.5]) {
    const options = { ...setup.options, controlPort };
    const delivery = gatewayDelivery(options);
    await expect(delivery.deliver(setup.record)).rejects.toThrow(/^Gateway delivery unavailable$/u);
    expect(await readFile(setup.options.configFile)).toEqual(before);
  }
  const configFile = `${setup.options.configFile}/SECRET-PATH-CANARY`;
  const options = { ...setup.options, configFile };
  const delivery = gatewayDelivery(options);
  await expect(delivery.deliver(setup.record)).rejects.toThrow(/^Gateway delivery unavailable$/u);
  expect(await delivery.observe()).toBeNull();
}
it('rejects invalid control ports and hides file error details', refusesInvalidControlPort);

async function restrictsDeliveredControlRoute() {
  const setup = await fixture();
  await waitForDeliveredWitness(setup);
  const bytes = await readFile(setup.options.configFile, 'utf8');
  const path = /\/configuration\/1\/[a-f0-9-]+/u.exec(bytes)![0];
  const url = `http://127.0.0.1:${setup.options.controlPort}${path}`;
  const wrongPath = await fetch(`${url}/extra`);
  expect(wrongPath.status).toBe(404);
  await wrongPath.text();
  const wrongMethod = await fetch(url, { method: 'POST' });
  expect(wrongMethod.status).toBe(404);
  await wrongMethod.text();
  const wrongListener = await fetch(`http://127.0.0.1:${setup.options.settings.port}${path}`);
  expect(wrongListener.status).toBe(404);
  await wrongListener.text();
  for (const spoofed of [false, true]) {
    const headers: Record<string, string> = {};
    if (spoofed) {
      headers['host'] = '127.0.0.1';
      headers['x-forwarded-for'] = '127.0.0.1';
      headers['forwarded'] = 'for=127.0.0.1';
    }
    await new Promise<void>(send);
    function send(resolve: () => void, reject: (error: unknown) => void) {
      const options = { localAddress: '127.0.0.2', headers };
      const outgoing = request(url, options, received);
      function received(response: import('node:http').IncomingMessage) {
        let body = '';
        function chunk(value: Buffer) {
          body += value.toString('utf8');
        }
        function completed() {
          try {
            expect(response.statusCode).toBe(403);
            expect(body).not.toContain(setup.record.recordDigest);
            resolve();
          } catch (error) {
            reject(error);
          }
        }
        response.on('data', chunk);
        response.on('end', completed);
      }
      outgoing.on('error', reject);
      outgoing.end();
    }
  }
}
it('restricts the delivered witness to its exact GET path, listener and source address',
  restrictsDeliveredControlRoute);

function validatesObservationFields() {
  const valid = { generation: 1, recordDigest: 'a'.repeat(64), configDigest: 'b'.repeat(64),
    processRef: '00000000-0000-4000-8000-000000000001', outcome: 'loaded',
    observedAt: '2026-10-14T00:00:00.000Z' };
  expect(gatewayObservationSchema.safeParse(valid).success).toBe(true);
  const invalid = [
    { generation: 0 }, { generation: -1 }, { generation: 1.5 },
    { recordDigest: 'a'.repeat(63) }, { recordDigest: 'z'.repeat(64) },
    { configDigest: 'b'.repeat(63) }, { configDigest: 'z'.repeat(64) },
    { processRef: 'not-a-uuid' }, { observedAt: 'yesterday' },
    { outcome: 'ready' }, { extra: true },
  ];
  for (const fields of invalid) {
    const candidate = { ...valid, ...fields };
    expect(gatewayObservationSchema.safeParse(candidate).success).toBe(false);
  }
}
it('rejects malformed observation fields and unknown fields', validatesObservationFields);

async function memberReceipts(setup: Awaited<ReturnType<typeof fixture>>) {
  const rows = await history(setup.nats.store, 'mcp-alpha', 'test');
  function receipt(row: typeof rows[number]) {
    return row.event.type === 'mcp.configuration_observed';
  }
  return rows.filter(receipt);
}

async function savesOneReceiptPerOperation() {
  const setup = await fixture();
  await waitForDeliveredWitness(setup);
  const original = await history(setup.nats.store, 'mcp-alpha', 'test');
  const before = toolPolicyFromRows(original);
  await Promise.all([setup.delivery.observe(), setup.delivery.observe()]);
  await expect.poll(setup.acknowledged, { timeout: 5000 }).toBeUndefined();
  const receipts = await memberReceipts(setup);
  expect(receipts).toHaveLength(1);
  const member = setup.record.members[0]!;
  expect(receipts[0]!.event.data).toMatchObject({ serverId: 'alpha',
    changeRef: member.changeRef, fragmentDigest: member.fragmentDigest,
    reviewRevision: member.entry.reviewRevision, sourceSequence: member.sourceSequence,
    generation: 1, recordDigest: setup.record.recordDigest });
  const after = toolPolicyFromRows(await history(setup.nats.store, 'mcp-alpha', 'test'));
  expect(after).toMatchObject({ policyRevision: before.policyRevision,
    reviewRevision: before.reviewRevision, published: false,
    configurationObservation: receipts[0]!.event.data });
  expect(await gatewayConfigurationCurrent(setup.nats.store, 'test', setup.record)).toBe(true);
  const bravoEntry = { ...member.entry, serverId: 'bravo' };
  for (const row of original) {
    const fields = z.record(z.string(), z.unknown()).parse(row.event.data);
    let data: Record<string, unknown> = { ...fields, serverId: 'bravo' };
    if (row.event.type === 'mcp.server_reviewed') {
      data = { ...data, policyRevision: await setup.nats.store.head('mcp-bravo') };
    }
    if (row.event.type === 'mcp.server_published') {
      const position = await setup.nats.store.head('mcp-bravo');
      bravoEntry.reviewRevision = position;
      data = { ...data, commandId: 'publish-bravo', expectedSequence: position,
        reviewRevision: position, fragmentDigest: publicationDigest(bravoEntry) };
    }
    const event = envelope('test', 'mcp-bravo', row.event.type, data);
    event.principal = row.event.principal;
    await setup.nats.seed([event]);
  }
  const next = await prepareGatewayConfiguration(setup.nats.store, 'test', 'bravo', 'publish-bravo');
  await setup.delivery.deliver(next);
  await expect.poll(setup.acknowledged, { timeout: 5000 }).toBeUndefined();
  expect(await memberReceipts(setup)).toEqual(receipts);
  const bravo = toolPolicyFromRows(await history(setup.nats.store, 'mcp-bravo', 'test'));
  expect(bravo.configurationObservation).toMatchObject({ changeRef: 'publish-bravo', generation: 2 });
}
it('saves one receipt per operation under concurrent observation and unchanged generations',
  savesOneReceiptPerOperation);

async function recoversLostMemberReply() {
  const setup = await fixture();
  let lost = false;
  async function append(command: Parameters<typeof setup.options.store.append>[0]) {
    const result = await setup.options.store.append(command);
    const eventType = appendEventSchema.parse(command.event).type;
    if (!lost && eventType === 'mcp.configuration_observed') {
      lost = true;
      throw new Error('Lost receipt reply');
    }
    return result;
  }
  const store = { append, head: setup.options.store.head.bind(setup.options.store),
    readStream: setup.options.store.readStream.bind(setup.options.store),
    readEvent: setup.options.store.readEvent.bind(setup.options.store) };
  const delivery = gatewayDelivery({ ...setup.options, store });
  await delivery.deliver(setup.record);
  await waitForDeliveredWitness(setup);
  expect(await delivery.observe()).toBeNull();
  expect(lost).toBe(true);
  const receipts = await memberReceipts(setup);
  expect(receipts).toHaveLength(1);
  expect(await delivery.observe()).not.toBeNull();
  expect(await memberReceipts(setup)).toEqual(receipts);
}
it('recovers a saved member receipt after its append reply is lost', recoversLostMemberReply);

function validatesMemberReceipt() {
  const schema = getEventDefinition('mcp.configuration_observed')?.dataSchema;
  expect(schema).toBeDefined();
  const valid = { serverId: 'alpha', changeRef: 'publish-alpha', reviewRevision: 3,
    sourceSequence: 4, fragmentDigest: 'a'.repeat(64), generation: 1,
    recordDigest: 'b'.repeat(64), configDigest: 'c'.repeat(64),
    processRef: '00000000-0000-4000-8000-000000000001', observedAt: new Date().toISOString() };
  expect(schema!.safeParse(valid).success).toBe(true);
  const invalid = [{ serverId: '' }, { changeRef: '' }, { reviewRevision: 0 },
    { sourceSequence: -1 }, { generation: 1.5 }, { fragmentDigest: 'bad' },
    { recordDigest: 'z'.repeat(64) }, { configDigest: 'bad' }, { processRef: 'bad' },
    { observedAt: 'yesterday' }, { commandId: 'forbidden' }, { extra: true }];
  for (const fields of invalid) {
    expect(schema!.safeParse({ ...valid, ...fields }).success).toBe(false);
  }
}
it('checks every member receipt field and rejects extra fields', validatesMemberReceipt);

async function rebuildsReceiptsWithoutEffects() {
  const setup = await fixture();
  const storage = await databases();
  async function closeStorage() {
    await storage.close();
  }
  onTestFinished(closeStorage);
  await expect.poll(setup.acknowledged, { timeout: 5000 }).toBeUndefined();
  const logger = createLogger('receipt-replay', { level: 'silent' });
  const runner = new ProjectionRunner(pgDb(storage.queue), setup.nats.reader, logger);
  await runner.initialise(mcpCatalogue);
  await runner.run(mcpCatalogue);
  const before = await storage.queue.query<{ policy: unknown }>('SELECT policy FROM mcp_catalogue');
  const receipts = await memberReceipts(setup);
  expect(before.rows[0]?.['policy']).toMatchObject({
    configurationObservation: receipts[0]!.event.data, published: false });
  const position = await setup.nats.store.head();
  const bytes = await readFile(setup.options.configFile);
  const inode = (await stat(setup.options.configFile)).ino;
  const probe = vi.spyOn(globalThis, 'fetch');
  function restoreProbes() {
    vi.restoreAllMocks();
  }
  onTestFinished(restoreProbes);
  const replay = gatewayDelivery({ ...setup.options, mode: 'replay' });
  await replay.deliver(setup.record);
  expect(await replay.observe()).toBeNull();
  expect(probe).not.toHaveBeenCalled();
  probe.mockRestore();
  const execute = promisify(execFile);
  const env = { ...process.env, ...setup.nats.env('projection'),
    DATABASE_URL: storage.queue.options.connectionString };
  const result = await execute('npm', ['run', 'replay', '--', 'mcp-catalogue', '--verify'],
    { env, timeout: 10_000 });
  expect(result.stdout).toContain('rebuilt state matched the live projection');
  expect((await storage.queue.query<{ policy: unknown }>('SELECT policy FROM mcp_catalogue')).rows).toEqual(before.rows);
  expect(await setup.nats.store.head()).toBe(position);
  expect(await readFile(setup.options.configFile)).toEqual(bytes);
  expect((await stat(setup.options.configFile)).ino).toBe(inode);
}
it('rebuilds member receipts with the replay CLI without delivery or new events',
  rebuildsReceiptsWithoutEffects);

async function changedStateRefusesMemberAppend(change: 'withdrawal' | 'preparation') {
  const setup = await fixture();
  let changed = false;
  async function append(command: Parameters<typeof setup.options.store.append>[0]) {
    const eventType = appendEventSchema.parse(command.event).type;
    if (eventType === 'mcp.configuration_observed') {
      if (change === 'withdrawal') {
        const event = envelope('test', 'mcp-alpha', 'mcp.server_unpublished',
          { serverId: 'alpha', unpublishedBy: 'admin' });
        await setup.nats.seed([event]);
      } else {
        const { recordDigest: _digest, ...previous } = setup.record;
        const saved = { ...previous, generation: 2, changeRef: 'second' };
        const next = { ...saved, recordDigest: publicationDigest(saved) };
        const event = envelope('test', 'gateway-config-test', 'gateway.configuration_requested', next);
        await setup.nats.seed([event]);
      }
      changed = true;
    }
    return setup.options.store.append(command);
  }
  const store = { append, head: setup.options.store.head.bind(setup.options.store),
    readStream: setup.options.store.readStream.bind(setup.options.store),
    readEvent: setup.options.store.readEvent.bind(setup.options.store) };
  const delivery = gatewayDelivery({ ...setup.options, store });
  await delivery.deliver(setup.record);
  await waitForDeliveredWitness(setup);
  expect(await delivery.observe()).toBeNull();
  expect(changed).toBe(true);
  expect(await memberReceipts(setup)).toHaveLength(0);
}
it.each(['withdrawal', 'preparation'] as const)(
  'lets a %s refuse the conditional server receipt append', changedStateRefusesMemberAppend);

async function refusesOldDelivery() {
  const setup = await fixture();
  await expect.poll(setup.acknowledged, { timeout: 5000 }).toBeUndefined();
  const { recordDigest: _digest, ...previous } = setup.record;
  const saved = { ...previous, generation: 2, changeRef: 'next' };
  const next = { ...saved, recordDigest: publicationDigest(saved) };
  await setup.nats.seed([envelope('test', 'gateway-config-test',
    'gateway.configuration_requested', next)]);
  await setup.delivery.deliver(next);
  await expect.poll(setup.acknowledged, { timeout: 5000 }).toBeUndefined();
  const bytes = await readFile(setup.options.configFile);
  const position = await setup.nats.store.head();
  await expect(setup.delivery.deliver(setup.record)).rejects.toThrow('Gateway delivery unavailable');
  expect(await readFile(setup.options.configFile)).toEqual(bytes);
  expect(await setup.delivery.observe()).toBeNull();
  expect(await setup.nats.store.head()).toBe(position);
}
it('refuses an older saved record passed directly to delivery without changing the file',
  refusesOldDelivery);
