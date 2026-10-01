import { createInterface } from 'node:readline';
import { safeUsageLine } from '../src/usage.js';
for await (const line of createInterface({ input: process.stdin })) {
  const safe = safeUsageLine(line);
  if (safe) process.stdout.write(safe + '\n');
}
