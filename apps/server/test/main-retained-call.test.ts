import { afterEach, expect, it, vi } from 'vitest';
import type { ChatOptions } from '../src/chat/routes.ts';
import type { BuildServerOptions } from '../src/server.ts';

const wiring = vi.hoisted(() => {
  const read = vi.fn(async () => undefined);
  let serverOptions: BuildServerOptions | undefined;
  return {
    read,
    get serverOptions() { return serverOptions; },
    set serverOptions(value: BuildServerOptions | undefined) { serverOptions = value; },
  };
});

vi.mock('@opencrane/auth', () => ({ loadAuthConfig: () => ({ expectedOrgId: 'org' }) }));
vi.mock('@opencrane/models', () => ({ seedOwnership: vi.fn(), providerSecrets: vi.fn() }));
vi.mock('@opencrane/observability', () => ({
  startTelemetry: vi.fn(), createLogger: () => ({ info: vi.fn() }),
}));
vi.mock('@opencrane/event-store', () => ({
  connectEventStore: async () => ({ store: {}, close: vi.fn() }),
}));
vi.mock('@opencrane/projections', () => ({
  connectMemberFeed: async () => ({ close: vi.fn() }),
  connectMcpCatalogue: () => ({ close: vi.fn() }),
  connectComputers: () => ({ close: vi.fn() }),
  connectProjectionDb: () => ({ db: {}, close: vi.fn() }),
}));
vi.mock('../src/chat/keys.ts', () => ({ conversationKeys: () => ({}) }));
vi.mock('../src/chat/participation.ts', () => ({ requireLegacyClosesProjected: vi.fn() }));
vi.mock('../src/chat/child-recovery.ts', () => ({ startChildRecovery: vi.fn() }));
vi.mock('../src/computers/desktop.ts', () => ({ desktopConnection: vi.fn() }));
vi.mock('../src/chat/start.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/chat/start.ts')>();
  async function startBridges(options: ChatOptions) {
    options.retainedCall = wiring.read;
    return vi.fn();
  }
  return { ...original, startBridges };
});
vi.mock('../src/server.ts', () => ({
  buildProductionServer: (_config: unknown, options: BuildServerOptions) => {
    wiring.serverOptions = options;
    return { listen: async () => 'http://127.0.0.1:1234', server: {}, log: { info: vi.fn() } };
  },
}));
vi.mock('../src/websocket.ts', () => ({
  attachWebSocketServer: vi.fn(), WEBSOCKET_PATH: '/ws',
}));
vi.mock('../src/shutdown.ts', () => ({ installShutdown: vi.fn() }));

const originalEnvironment = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnvironment };
  wiring.serverOptions = undefined;
  vi.resetModules();
});

async function installsBridgeReaderOnProductionRoutes() {
  process.env = {
    ...originalEnvironment,
    NATS_URL: 'nats://fixture',
    SILO_ID: 'test',
    DATABASE_URL: 'postgres://fixture',
    OPENFGA_API_URL: 'http://fixture',
    OPENFGA_STORE_ID: 'store',
    OPENFGA_MODEL_ID: 'model',
    CONVERSATION_KEYS_DIR: '/tmp/test-keys',
    NODE_ENV: 'test',
    MINIO_CREDENTIALS_FILE: '',
    MEMORY_KEY_DIRECTORY: '',
  };

  await import('../src/main.ts');

  expect(wiring.serverOptions?.chat?.retainedCall).toBe(wiring.read);
}

it('passes the installed bridge reader to production chat routes',
  installsBridgeReaderOnProductionRoutes);
