import { once } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tokenIssuer } from '@opencrane/auth';
import { natsFixture } from '@opencrane/event-store/testing';
import { envelope, history } from '@opencrane/models';
import { sharedCertificates } from '../../libs/event-store/test/certificates.ts';
import { launchScanner } from '../../infra/clamav/launch.mjs';
import { createScannerService } from '../../infra/clamav/service.mjs';
import { scanFile } from '../../apps/server/src/files/scanner.ts';
import { uploadFile } from '../../apps/server/src/files/routes.ts';

const silos = ['silo-one', 'silo-two'];
const cleanName = 'notes.txt';

function identity(silo) {
  const suffix = silo === 'silo-one' ? 'one' : 'two';
  return { member: `member-${suffix}`, assistant: `assistant-${suffix}`,
    conversation: `conversation-${suffix}` };
}

async function seedSilo(store, silo) {
  const names = identity(silo);
  const fixtureEmail = [silo, 'example.test'].join('@');
  const events = [
    { subject: `member-${names.member}`, type: 'member.invited',
      data: { memberId: names.member, invitationId: `invitation-${silo}`,
        email: fixtureEmail, role: 'member', invitedBy: 'owner',
        invitedIdentity: { issuer: 'https://fixture.invalid', sub: names.member } } },
    { subject: `member-${names.member}`, type: 'member.joined',
      data: { memberId: names.member, invitationId: `invitation-${silo}`,
        email: fixtureEmail, role: 'member', displayName: 'Fixture member' } },
    { subject: `assistant-${names.assistant}`, type: 'assistant.created',
      data: { assistantId: names.assistant, ownerId: names.member, kind: 'personal' } },
    { subject: `conversation-${names.conversation}`, type: 'conversation.created',
      data: { conversationId: names.conversation, assistantId: names.assistant,
        createdBy: names.member, mode: 'agent_session' } },
  ];
  for (const item of events) {
    const event = envelope(silo, item.subject, item.type, item.data);
    event.principal = { kind: 'human', id: names.member };
    const expectedSequence = await store.head(item.subject);
    await store.append({ event, expectedSequence });
  }
}

async function scannerTrust(directory) {
  const trust = [];
  const settings = new Map();
  for (const silo of silos) {
    const issuer = `https://${silo}.scanner.invalid`;
    const privateKeyPath = join(directory, 'server.key');
    const scannerIdentity = { service: 'server', silo };
    const tokens = await tokenIssuer({ privateKeyPath, issuer, scannerIdentity });
    trust.push({ issuer, jwks: tokens.jwks, services: { server: silo } });
    settings.set(silo, { silo, issuer, privateKeyPath,
      caFile: join(directory, 'ca.crt') });
  }
  return { trust, settings };
}

function storeWithoutLostReply(store, state) {
  async function append(input) {
    const result = await store.append(input);
    if (state.loseAcknowledgement && input.event.type === 'file.uploaded') {
      state.loseAcknowledgement = false;
      return { status: 'unavailable' };
    }
    return result;
  }
  return { readStream: store.readStream.bind(store), append };
}

export async function startRealUploadFixture(inputs) {
  const directory = await mkdtemp(join(tmpdir(), 'real-upload-scan-'));
  let scanner;
  let service;
  let nats;
  const savedFiles = [];
  const transportIds = [];
  let lastProof;
  const state = { loseAcknowledgement: false };
  const clock = { offset: 0 };
  function currentTime() {
    return Date.now() + clock.offset;
  }

  async function closeService() {
    if (!service) return;
    service.closeAllConnections();
    if (service.listening) {
      service.close();
      await once(service, 'close');
    }
    service = undefined;
  }

  async function stopScanner() {
    await closeService();
    if (scanner) {
      await scanner.stop();
      scanner = undefined;
    }
  }

  async function stop() {
    await stopScanner();
    await nats?.close();
    await rm(directory, { recursive: true, force: true });
  }

  try {
    await sharedCertificates(directory);
    const credentials = await scannerTrust(directory);
    nats = await natsFixture();
    for (const silo of silos) {
      await seedSilo(nats.store, silo);
    }
    const store = storeWithoutLostReply(nats.store, state);
    const tls = { key: await readFile(join(directory, 'server.key')),
      cert: await readFile(join(directory, 'server.crt')) };

    async function startScanner(reviewedInputs) {
      const ownership = join(directory, `scanner-${randomUUID()}`);
      const launchOptions = { ...reviewedInputs, ownership, clock: currentTime };
      scanner = await launchScanner(launchOptions);
      const serviceOptions = { scanner, tls, trust: credentials.trust, clock: currentTime };
      service = createScannerService(serviceOptions);
      function recordTransport(request) {
        const requestId = request.headers['x-scan-request-id'];
        if (typeof requestId === 'string') transportIds.push(requestId);
      }
      function captureProof(_request, response) {
        const originalEnd = response.end;
        function finish(chunk, ...argumentsAfterChunk) {
          if (response.statusCode === 200 && Buffer.isBuffer(chunk)) {
            lastProof = JSON.parse(chunk.toString('utf8'));
          }
          return originalEnd.call(response, chunk, ...argumentsAfterChunk);
        }
        response.end = finish;
      }
      service.prependListener('checkContinue', recordTransport);
      service.prependListener('checkContinue', captureProof);
      const listenOptions = { port: 0, host: '127.0.0.1' };
      service.listen(listenOptions);
      await once(service, 'listening');
      const address = service.address();
      if (!address || typeof address === 'string') throw new Error('Scanner fixture refused');
      const url = `https://127.0.0.1:${address.port}/scan/upload`;
      for (const settings of credentials.settings.values()) {
        settings.url = url;
        settings.manifestDigest = `sha256:${reviewedInputs.approvedSha}`;
      }
    }

    await startScanner(inputs);

    function optionsFor(silo) {
      const names = identity(silo);
      const settings = credentials.settings.get(silo);
      if (!settings) throw new Error('Unknown fixture silo');
      async function scan(bytes, binding) {
        return scanFile(settings, bytes, binding);
      }
      async function putObject(_bucket, key, _bytes, size) {
        // Keep only file identity and size; the fixture never saves customer bytes.
        savedFiles.push({ silo, key, size });
      }
      const objects = { putObject };
      return { silo, store, scan, objects, names, settings };
    }

    const options = new Map();
    for (const silo of silos) options.set(silo, optionsFor(silo));

    async function upload(silo, key, bytes, fresh) {
      if (bytes.length > 1024) throw new Error('Fixture file too large');
      const selected = options.get(silo);
      if (!selected) throw new Error('Unknown fixture silo');
      const originalNow = Date.now;
      function fixtureNow() {
        return currentTime();
      }
      Date.now = fixtureNow;
      try {
        return await uploadFile(selected, selected.names.member, selected.names.conversation,
          key, cleanName, bytes, undefined, fresh);
      } finally {
        Date.now = originalNow;
      }
    }

    async function savedEvents(silo, type) {
      const names = identity(silo);
      const rows = await history(nats.store, `conversation-${names.conversation}`, silo);
      function hasType(row) {
        return row.event.type === type;
      }
      return rows.filter(hasType);
    }

    function filesFor(silo) {
      function belongsToSilo(file) {
        return file.silo === silo;
      }
      return savedFiles.filter(belongsToSilo);
    }

    function loseNextAcknowledgement() {
      state.loseAcknowledgement = true;
    }

    function expireDatabase() {
      const expiry = Date.parse(scanner.databaseUpdatedAt) + 86_400_000;
      clock.offset = expiry - Date.now();
    }

    async function restart(reviewedInputs) {
      await stopScanner();
      await startScanner(reviewedInputs);
    }

    async function replayProof(proof, silo, key, bytes, changedField) {
      const selected = credentials.settings.get(silo);
      if (!selected) throw new Error('Unknown fixture silo');
      const originalUrl = selected.url;
      const replay = createServer(tls);
      function alteredProof(request) {
        if (!changedField) return proof;
        const digest = createHash('sha256');
        digest.update(bytes);
        const candidate = { ...proof, purpose: 'upload', silo,
          requestId: request.headers['x-scan-request-id'],
          fileId: request.headers['x-scan-file-id'], sha256: digest.digest('hex'),
          byteCount: bytes.length };
        if (changedField === 'silo') candidate.silo = proof.silo;
        if (changedField === 'request') candidate.requestId = proof.requestId;
        if (changedField === 'bytes') candidate.sha256 = proof.sha256;
        if (changedField === 'file') candidate.fileId = proof.fileId;
        if (changedField === 'purpose') candidate.purpose = 'image';
        if (changedField === 'generation') {
          candidate.manifestDigest = `sha256:${'f'.repeat(64)}`;
        }
        if (changedField === 'expiry') {
          candidate.expiresAt = '2020-01-01T00:00:00.000Z';
        }
        return candidate;
      }
      function answer(request, response) {
        response.writeContinue();
        request.resume();
        function finish() {
          response.setHeader('content-type', 'application/json');
          response.end(JSON.stringify(alteredProof(request)));
        }
        request.once('end', finish);
      }
      replay.on('checkContinue', answer);
      const listenOptions = { port: 0, host: '127.0.0.1' };
      replay.listen(listenOptions);
      await once(replay, 'listening');
      const address = replay.address();
      if (!address || typeof address === 'string') throw new Error('Replay fixture refused');
      selected.url = `https://127.0.0.1:${address.port}/scan/upload`;
      try {
        return await upload(silo, key, bytes);
      } finally {
        selected.url = originalUrl;
        replay.closeAllConnections();
        replay.close();
        await once(replay, 'close');
      }
    }

    function lastCleanProof() {
      if (lastProof?.verdict !== 'clean') throw new Error('No clean proof');
      return structuredClone(lastProof);
    }

    return { upload, savedFiles: filesFor, savedEvents, stop, stopScanner, restart,
      expireDatabase, loseNextAcknowledgement, settings: credentials.settings,
      transportIds, lastCleanProof, replayProof };
  } catch {
    await stop();
    throw new Error('Scanner fixture refused');
  }
}
