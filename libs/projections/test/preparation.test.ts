import { expect, it, vi } from 'vitest';
import * as observability from '@opencrane/observability';
import { event } from '@opencrane/event-store/testing';
import { ProjectionRunner, memoryProjection, memoryKeys, memoryScopeId } from '../src/index.ts';
import type { EventSource } from '../src/index.ts';
import { mkdtemp, readFile, rename, rm } from 'node:fs/promises';
import { database } from './database.ts';

it('logs key-store failure inside the handler span without text or key bytes',
  async function preparationFailure() {
    const storage = await database('pglite');
    const directory = await mkdtemp('/tmp/memory-handler-');
    const keys = memoryKeys(directory);
    const identity = { silo: 'test', scopeId: memoryScopeId('test', 'person', 'alice'),
      scopeKind: 'person' as const, ownerId: 'alice', memoryId: 'first', revision: 1 };
    const keyId = keys.provision(identity);
    const bytes = await readFile(`${directory}/${keyId.slice(4)}`);
    const encrypted = keys.encrypt(identity, 'Private delivery instructions');
    const { silo: _silo, ...fields } = identity;
    const data = { ...fields, ...encrypted, schemaVersion: 1, kind: 'fact', pinned: false,
      expiresAt: null, sources: [], dependsOn: [] };
    const envelope = { ...event('first'), type: 'memory.written',
      subject: `scope-${identity.scopeId}`, data };
    const source: EventSource = {
      head: () => Promise.resolve(1),
      async *subscribe() {
        yield { event: envelope, sequence: 1 };
      },
    };
    const logs: string[] = [];
    function write(line: string) {
      logs.push(line);
    }
    const logger = observability.createLogger('memory-handler-test', {
      level: 'info', destination: { write },
    });
    // Observe the callback that runHandler executes inside its span.
    const original = observability.runHandler;
    let insideHandler = false;
    let preparedInsideHandler = false;
    const handlerSpy = vi.spyOn(observability, 'runHandler');
    async function traced<Result>(...args: Parameters<typeof original<Result>>) {
      const [handlerLogger, run, work] = args;
      async function withinSpan() {
        insideHandler = true;
        try {
          return await work();
        } finally {
          insideHandler = false;
        }
      }
      return original(handlerLogger, run, withinSpan);
    }
    handlerSpy.mockImplementation(traced);
    function decrypt(...args: Parameters<typeof keys.decrypt>) {
      preparedInsideHandler = insideHandler;
      return keys.decrypt(...args);
    }
    const projection = memoryProjection({ decrypt });
    const runner = new ProjectionRunner(storage.db, source, logger);
    try {
      await runner.initialise(projection);
      await rename(directory, `${directory}-away`);
      await expect(runner.run(projection)).rejects.toThrow('Memory key store unavailable');
      expect(preparedInsideHandler).toBe(true);
      expect(handlerSpy).toHaveBeenCalledOnce();
      function parseLog(line: string): unknown {
        return JSON.parse(line);
      }
      const records = logs.map(parseLog);
      expect(records).toContainEqual(expect.objectContaining({
        msg: 'handler.failed', handler: 'memory', event_id: 'first',
        event_type: 'memory.written', stream: envelope.subject, attempt: 1,
      }));
      const output = logs.join('\n');
      expect(output).not.toContain('Private delivery instructions');
      expect(output).not.toContain(bytes.toString('hex'));
      expect(output).not.toContain(bytes.toString('base64'));
      expect(await runner.checkpoint(projection)).toBe(0);
    } finally {
      handlerSpy.mockRestore();
      await storage.close();
      await rm(directory, { recursive: true, force: true });
      await rm(`${directory}-away`, { recursive: true, force: true });
    }
  });
