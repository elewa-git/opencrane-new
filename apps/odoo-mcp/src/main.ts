import { createAdapter } from './server.ts';

const adapter = createAdapter();
await adapter.listen({ host: '127.0.0.1', port: Number(process.env['PORT'] ?? 3000) });
