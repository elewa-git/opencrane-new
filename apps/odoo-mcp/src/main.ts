import { createAdapter } from './server.ts';

const origin = process.env['ODOO_ORIGIN'];
const database = process.env['ODOO_DATABASE'];
let upstream;
if (origin !== undefined || database !== undefined) {
  if (!origin || !database) {
    throw new Error('Set both ODOO_ORIGIN and ODOO_DATABASE.');
  }
  upstream = { origin, database };
}
const adapter = createAdapter(upstream);
await adapter.listen({ host: '127.0.0.1', port: Number(process.env['PORT'] ?? 3000) });
