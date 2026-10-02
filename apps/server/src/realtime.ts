import { setImmediate as yieldIo } from 'node:timers/promises';
import type { WebSocket } from 'ws';
import type { FastifyBaseLogger } from 'fastify';
import { isIdentityAllowed, type AuthConfig, type SessionData } from '@opencrane/auth';
import { memberAuthorisation, type Binding } from '@opencrane/authz';
import type { connectMemberFeed } from '@opencrane/projections';
import type { RealtimeMessage } from '@opencrane/protocol';

import type { ChatOptions } from './chat/routes.ts';
export interface RealtimeOptions {
  chat?: ChatOptions;
  feed: Awaited<ReturnType<typeof connectMemberFeed>>;
  binding: Binding;
}

// ponytail: one topic per socket. Add multiplexing when a second topic exists.
export function memberSubscription(socket: WebSocket, session: SessionData, config: AuthConfig, logger: FastifyBaseLogger, options?: RealtimeOptions) {
  let position = 0, generation = 0;
  let active = false, running = false, dirty = false, subscribed = false, ready = false;
  const send = (message: RealtimeMessage) => socket.send(JSON.stringify(message));
  const envelope = () => ({ version: 1 as const, topic: 'members' as const, position, generation });
  const authz = options && memberAuthorisation(options.binding);
  async function allowed() {
    if (!options || !authz || !config.expectedOrgId
      || !isIdentityAllowed(config, { issuer: config.issuerUrl, subject: session.sub, orgId: session.orgId })
      || session.exp * 1000 <= Date.now()) return false;
    const id = await options.feed.memberId(options.binding.silo, config.issuerUrl, session.sub);
    return Boolean(id && (await authz.check(id, 'member')).allowed);
  }
  function refuse() {
    active = false;
    if (socket.readyState !== socket.OPEN) return;
    send({ ...envelope(), type: 'refused' });
    socket.close(1008, 'subscription refused');
  }
  function slow() {
    active = false;
    logger.info({ operation: 'members.backpressure', position }, 'member subscriber needs resync');
    // Do not advance past a dropped delta. The durable projection keeps every state.
    send({ ...envelope(), type: 'resync' });
    socket.close(1013, 'resume from last received position');
  }
  function reload(nextGeneration: number) {
    active = false;
    generation = nextGeneration;
    position = 0;
    send({ ...envelope(), type: 'resync' });
    socket.close(1013, 'restart from position 0');
  }
  const connected = () => active && socket.readyState === socket.OPEN;
  async function drain() {
    if (!options || running || !active) return;
    running = true;
    try {
      do {
        dirty = false;
        const currentGeneration = await options.feed.generation();
        if (currentGeneration !== generation) { reload(currentGeneration); return; }
        if (!await allowed()) { refuse(); return; }
        const rows = await options.feed.read(options.binding.silo, position);
        if (!connected()) return;
        for (const row of rows) {
          if (socket.bufferedAmount > 64 * 1024) { slow(); return; }
          send({ ...envelope(), type: 'member', ...row });
          position = row.position;
          await yieldIo();
          if (!connected()) return;
        }
        if (rows.length === 100) dirty = true;
      } while (dirty && active);
      if (active && !ready) { send({ ...envelope(), type: 'ready' }); ready = true; }
    } finally { running = false; }
  }
  function wake() {
    dirty = true;
    void drain().catch(() => {
      active = false;
      logger.error({ operation: 'members.read' }, 'members feed unavailable');
      socket.close(1011, 'members unavailable');
    });
  }
  const unlisten = options?.feed.listen(wake);
  // Also recheck permissions when the OpenFGA projection advances without a SQL wake-up.
  const permissions = setInterval(wake, 1000);
  permissions.unref();
  socket.once('close', () => { active = false; unlisten?.(); clearInterval(permissions); });
  return async (since: number, requestedGeneration?: number) => {
    if (subscribed) { refuse(); return; }
    subscribed = true;
    position = since;
    if (!options) { refuse(); return; }
    generation = await options.feed.generation();
    if (!await allowed()) { refuse(); return; }
    if (since > 0 && requestedGeneration !== generation) { reload(generation); return; }
    if (since > await options.feed.head(options.binding.silo)) { refuse(); return; }
    if (socket.readyState !== socket.OPEN) return;
    active = true;
    wake();
  };
}
