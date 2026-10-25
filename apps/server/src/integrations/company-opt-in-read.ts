import type { FastifyReply, FastifyRequest } from 'fastify';
import type { EventStore, StoredEvent } from '@opencrane/event-store';
import type { Binding } from '@opencrane/authz';
import { foldCompanyOptIn, history, readActiveMember, toolPolicyFromRows }
  from '@opencrane/models';
import { z } from 'zod';

const id = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/u);
const parameters = z.strictObject({ serverId: id });
const emptyQuery = z.strictObject({});
function registered(row: StoredEvent) {
  return row.event.type === 'mcp.server_registered';
}

export async function readCompanyOptIn(request: FastifyRequest, reply: FastifyReply,
  options: { silo: string; store?: EventStore; binding: Binding }, memberId: string) {
  const { serverId } = parameters.parse(request.params);
  emptyQuery.parse(request.query);
  const length = request.headers['content-length'];
  if (request.body !== undefined || request.headers['transfer-encoding'] !== undefined ||
      (length !== undefined && length !== '0')) {
    return reply.code(400).send({ status: 'invalid_request' });
  }
  if (!options.store) {
    return reply.code(503).send({ status: 'unavailable' });
  }
  const store = options.store;
  async function prepare() {
    try {
      const deadline = performance.now() + 10_000;
      const serverRows = await history(store, `mcp-${serverId}`, options.silo, deadline);
      const rows = await history(store, `connection-company-${serverId}`, options.silo, deadline);
      const registration = serverRows.findLast(registered);
      const policy = toolPolicyFromRows(serverRows);
      return { rows, registration, policy };
    } catch {
      // Keep private dependency details out of replies and logs.
      return null;
    }
  }
  const prepared = await prepare();
  // Check current membership once, after loading, even when history is unavailable.
  await readActiveMember(store, options.binding, memberId, 'admin');
  if (!prepared) {
    return reply.code(503).send({ status: 'unavailable' });
  }
  const { rows, registration, policy } = prepared;
  if (!registration) {
    return reply.code(404).send({ status: 'not_found' });
  }
  const registrationRevision = registration.sequence;
  const installation = { silo: options.silo, serverId,
    connectionId: policy.connectionId ?? '', registrationRevision };
  const state = foldCompanyOptIn(rows, installation);
  return reply.send({ ...state, connectionId: policy.connectionId, registrationRevision });
}
