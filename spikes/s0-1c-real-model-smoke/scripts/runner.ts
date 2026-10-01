import { writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { startHarness, tablePath } from '../src/harness.js';
import { loadPriceTable, priceFor } from '../src/price-table.js';
const action = process.argv[2];
const model = process.env.MODEL ?? '';
if (action === 'preflight') {
  const price = priceFor(loadPriceTable(tablePath), model);
  if (!/^[a-zA-Z0-9._-]+$/.test(model) || model === 'stub-model' || !price?.confirmed) process.exit(1);
} else {
  const dir = resolve(process.argv[3]!);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const h = await startHarness(dir, action === 'real' ? 'real' : 'stub', action === 'real' ? model : 'stub-model');
  let stopping = false;
  const stop = async (code: number) => { if (stopping) return; stopping = true; await h.close(); process.exit(code); };
  process.on('SIGTERM', () => { void stop(143); }); process.on('SIGINT', () => { void stop(130); });
  const watchdog = setTimeout(() => { void stop(1); }, 120000);
  try {
    if (action === 'real') {
      writeFileSync(join(dir, 'prepared'), 'ready');
      let ready = false;
      for (let i = 0; i < 300; i++) {
        try { const r = await fetch(`http://127.0.0.1:${h.readyPort}/healthz/ready`); if (r.ok) { ready = true; break; } } catch { /* Gateway has not started yet. */ }
        await new Promise(r => setTimeout(r, 100));
      }
      if (!ready) throw new Error('gateway not ready');
      // The operator can list through this running gateway without learning a token.
      writeFileSync(join(dir, 'proxy-url'), h.proxy.url);
      const response = await fetch(h.proxy.url + '/v1/models');
      if (!response.ok) throw new Error('model listing refused');
      const catalogue = await response.json() as { data: { id: string }[] };
      if (!catalogue.data.some(item => item.id === model)) throw new Error('chosen model unavailable');
    }
    if (action === 'list') {
      const response = await fetch(h.proxy.url + '/v1/models');
      if (!response.ok) throw new Error('model list refused');
      const data = await response.json() as { data: { id: string }[] };
      for (const item of data.data) if (/^[a-zA-Z0-9._-]+$/.test(item.id)) console.log(item.id);
    } else {
      await h.turn();
      await new Promise(r => setTimeout(r, 250));
      const usage = h.usage(); writeFileSync(join(dir, 'settlement.json'), JSON.stringify(usage, null, 2));
      console.log(JSON.stringify({ turn: 'completed', requests: h.decision.allowedCount(), usage }));
      if (!usage.length || usage.some(row => row.status !== 'CAPTURED')) process.exitCode = 1;
    }
  } catch { console.error('Smoke run failed; real model output and raw errors are suppressed.'); process.exitCode = 1; }
  finally { clearTimeout(watchdog); await h.close(); }
}
