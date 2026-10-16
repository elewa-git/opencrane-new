import type { IncomingHttpHeaders } from 'node:http';
import type { EventStore, StoredEvent } from '@opencrane/event-store';
import type { GatewayAcknowledgement } from './gateway-delivery.ts';
import { gatewayMemberCurrent } from './gateway-generation.ts';
import type { toolPolicyFromRows } from './tool-policy.ts';

type ReadAcknowledgement = () => GatewayAcknowledgement | null;
type Binding = Pick<GatewayAcknowledgement, 'generation' | 'recordDigest' | 'position'>;
const headers = ['x-opencrane-gateway-generation', 'x-opencrane-record-digest',
  'x-opencrane-server-id', 'x-opencrane-connection-id', 'x-opencrane-review-revision'];

export function requireGatewayAcknowledgement(binding: Binding,
  acknowledged?: ReadAcknowledgement) {
  const current = acknowledged?.();
  if (!current || current.generation !== binding.generation ||
      current.recordDigest !== binding.recordDigest || current.position !== binding.position) {
    throw new Error('Gateway acknowledgement unavailable');
  }
}

export async function requireGatewayPosition(store: EventStore, silo: string,
  binding: Binding | undefined, acknowledged: ReadAcknowledgement | undefined, deadline: number) {
  if (!binding) return;
  const position = await store.head(`gateway-config-${silo}`, deadline);
  if (position !== binding.position) throw new Error('Gateway configuration changed');
  requireGatewayAcknowledgement(binding, acknowledged);
}

export async function gatewayAdmission(store: EventStore, silo: string, server: string,
  connection: string, rows: StoredEvent[], policy: ReturnType<typeof toolPolicyFromRows>,
  supplied: IncomingHttpHeaders, deadline: number, acknowledged?: ReadAcknowledgement) {
  const intent = policy.publication;
  if (!intent) {
    for (const name of headers) {
      if (supplied[name] !== undefined) throw new Error('Gateway constants refused');
    }
    return undefined;
  }
  const current = acknowledged?.();
  if (!current) throw new Error('Gateway acknowledgement unavailable');
  function matchesServer(member: GatewayAcknowledgement['members'][number]) {
    return member.entry.serverId === server && member.entry.connectionId === connection;
  }
  const member = current.members.find(matchesServer);
  const receipt = policy.configurationObservation;
  if (!member || !receipt || !gatewayMemberCurrent(rows, member) ||
      receipt.changeRef !== member.changeRef || receipt.fragmentDigest !== member.fragmentDigest ||
      receipt.reviewRevision !== member.entry.reviewRevision ||
      receipt.sourceSequence !== member.sourceSequence) {
    throw new Error('Gateway publication unavailable');
  }
  const values = [String(current.generation), current.recordDigest, server, connection,
    String(member.entry.reviewRevision)];
  for (let index = 0; index < headers.length; index++) {
    // Reject missing, repeated and joined values without including them in errors.
    if (supplied[headers[index]!] !== values[index]) throw new Error('Gateway constants refused');
  }
  const binding = { generation: current.generation, recordDigest: current.recordDigest,
    position: current.position };
  await requireGatewayPosition(store, silo, binding, acknowledged, deadline);
  return binding;
}
