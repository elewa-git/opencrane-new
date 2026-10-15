import { gatewayConfigurationSchema } from '@opencrane/events';
import { history } from './actor.ts';
import { gatewayConfigurationCurrent } from './gateway-generation.ts';
import { gatewayDelivery } from './gateway-delivery.ts';

type Options = Parameters<typeof gatewayDelivery>[0] & { requireLeader: () => Promise<void> };

export function gatewayConfigurationWorker(options: Options) {
  let stopped = false;
  let active: Promise<void> | undefined;
  let deliveredDigest: string | undefined;
  async function requireLeader() {
    if (stopped) throw new Error('Gateway worker stopped');
    await options.requireLeader();
    if (stopped) throw new Error('Gateway worker stopped');
  }
  const deliveryOptions = { ...options, requireLeader };
  const delivery = gatewayDelivery(deliveryOptions);
  async function reconcile() {
    if (options.mode === 'replay') return;
    await requireLeader();
    const rows = await history(options.store, `gateway-config-${options.silo}`, options.silo);
    function requested(row: typeof rows[number]) {
      return row.event.type === 'gateway.configuration_requested';
    }
    const requests = rows.filter(requested);
    const latest = requests.at(-1);
    if (!latest) return;
    const record = gatewayConfigurationSchema.parse(latest.event.data);
    if (!await gatewayConfigurationCurrent(options.store, options.silo, record)) return;
    if (record.recordDigest !== deliveredDigest) {
      await delivery.deliver(record);
      deliveredDigest = record.recordDigest;
    }
    await delivery.observe();
  }
  function finished() {
    active = undefined;
  }
  function check() {
    active ??= reconcile().finally(finished);
    return active;
  }
  function tick(onError: (error: unknown) => void) {
    if (!stopped && !active) void check().catch(onError);
  }
  async function close() {
    stopped = true;
    await active?.catch(finished);
  }
  return { check, tick, close };
}
