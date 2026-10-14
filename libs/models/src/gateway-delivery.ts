import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { rename, rm, writeFile } from 'node:fs/promises';
import { gatewayConfigurationSchema } from '@opencrane/events';
import type { EventStore } from '@opencrane/event-store';
import { z } from 'zod';
import { envelope, history } from './actor.ts';
import { gatewayConfigurationCurrent } from './gateway-generation.ts';
import { renderGatewayConfiguration, type GatewayRenderSettings } from './gateway-renderer.ts';

type Configuration = ReturnType<typeof gatewayConfigurationSchema.parse>;
const configuration = z.looseObject({
  gateways: z.record(z.string(), z.unknown()), routes: z.array(z.unknown()),
});

async function replaceConfiguration(file: string, config: unknown) {
  const sibling = `${file}.${randomUUID()}.next`;
  try {
    await writeFile(sibling, JSON.stringify(config), { mode: 0o600, flag: 'wx' });
    await rename(sibling, file);
  } finally {
    await rm(sibling, { force: true });
  }
}

export function gatewayDelivery(options: {
  store: Pick<EventStore, 'append' | 'head' | 'readEvent' | 'readStream'>;
  silo: string; child: ChildProcess; configFile: string; controlPort: number;
  settings: GatewayRenderSettings; mode: 'live' | 'replay';
}) {
  const processRef = randomUUID();
  const subject = `gateway-config-${options.silo}`;
  let active: { record: Configuration; configDigest: string; response: string; path: string } | null = null;
  let writing = false;

  function alive() {
    return options.child.pid !== undefined && options.child.exitCode === null &&
      options.child.signalCode === null && !options.child.killed;
  }

  async function deliver(input: Configuration) {
    if (options.mode === 'replay') return;
    if (writing || !alive()) throw new Error('Gateway delivery unavailable');
    writing = true;
    active = null;
    try {
      const record = gatewayConfigurationSchema.parse(input);
      const rendered = renderGatewayConfiguration(record, options.settings);
      const parsed: unknown = JSON.parse(rendered.configBytes.toString('utf8'));
      const config = configuration.parse(parsed);
      const identity = { generation: record.generation, recordDigest: record.recordDigest,
        configDigest: rendered.configDigest, processRef };
      const response = JSON.stringify(identity);
      const path = `/configuration/${record.generation}/${processRef}`;
      // Keep process identity outside the repeatable configuration digest.
      config.gateways['control'] = { port: z.int().min(1).max(65535).parse(options.controlPort) };
      const controlRoute = { name: 'configuration', gateways: 'control',
        matches: [{ path: { exact: path }, method: 'GET' }],
        policies: { authorization: { rules: ['source.address == "127.0.0.1"'] },
          directResponse: { status: 200, body: response } } };
      config.routes.push(controlRoute);
      await replaceConfiguration(options.configFile, config);
      active = { record, configDigest: rendered.configDigest, response, path };
    } catch {
      throw new Error('Gateway delivery unavailable');
    } finally {
      writing = false;
    }
  }

  function usable(delivered: typeof active) {
    return options.mode === 'live' && delivered !== null && active === delivered &&
      !writing && alive();
  }

  async function observe() {
    const delivered = active;
    if (!delivered || !usable(delivered)) return null;
    try {
      const url = `http://127.0.0.1:${options.controlPort}${delivered.path}`;
      const response = await fetch(url, { signal: AbortSignal.timeout(1000), redirect: 'error' });
      if (response.status !== 200 || await response.text() !== delivered.response) return null;
      const rows = await history(options.store, subject, options.silo);
      if (!await gatewayConfigurationCurrent(options.store, options.silo, delivered.record)) return null;
      if (!usable(delivered)) return null;
      const id = `gateway-observed:${delivered.record.recordDigest}:` +
        `${delivered.configDigest}:${processRef}`;
      for (const row of rows) {
        if (row.event.id === id) return row;
      }
      const data = { generation: delivered.record.generation,
        recordDigest: delivered.record.recordDigest, configDigest: delivered.configDigest,
        processRef, outcome: 'loaded', observedAt: new Date().toISOString() };
      const event = envelope(options.silo, subject, 'gateway.configuration_observed', data, id);
      const command = { event, expectedSequence: rows.at(-1)?.sequence ?? 0 };
      const result = await options.store.append(command);
      if (result.status !== 'appended' || !usable(delivered)) return null;
      return await options.store.readEvent(result.sequence);
    } catch {
      // Leave an uncertain append for the next exact probe to recover from saved history.
      return null;
    }
  }
  return { deliver, observe };
}
