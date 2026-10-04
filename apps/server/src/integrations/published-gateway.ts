import { z } from 'zod';
import type { EventStore } from '@opencrane/event-store';
import { acknowledgeMcp, currentPublication, startGateway } from '@opencrane/models';

/** Reconcile desired generations; a lost acknowledgement only rereads the running gateway. */
export async function publishedGateway(store: EventStore, silo: string, upstream: string, options: Parameters<typeof startGateway>[0]) {
  let gateway: Awaited<ReturnType<typeof startGateway>> | undefined;
  let loaded = '', head = -1;
  async function reconcile() {
    const nextHead = await store.head('mcp-*');
    if (nextHead === head) return;
    const ids = new Set<string>();
    for await (const { event } of store.readStream('mcp-*')) if (event.silo === silo && event.type === 'mcp.server_registered') ids.add(z.object({ serverId: z.string() }).parse(event.data).serverId);
    const publications = (await Promise.all([...ids].sort().map(id => currentPublication(store, silo, id)))).filter(p => p !== undefined);
    const generation = JSON.stringify(publications.map(p => [p.serverId, p.changeRef, p.digest]));
    if (!gateway || loaded !== generation) {
      // ponytail: restart the single fenced gateway for one atomic generation; hot reload when availability requires it.
      await gateway?.stop();
      gateway = await startGateway({ ...options, mcpRoutes: publications.map(publication => ({ serverId: publication.serverId,
        connectionId: publication.desired.connectionId, upstream, publication })) });
      loaded = generation;
    }
    for (const ack of await gateway.acknowledgements()) {
      if (!await acknowledgeMcp(store, silo, ack.serverId, ack.changeRef, ack.digest)) throw new Error('Publication changed during acknowledgement');
    }
    head = nextHead;
  }
  await reconcile();
  return { reconcile, healthy: () => gateway?.healthy() === true, stop: async () => { await gateway?.stop(); } };
}
