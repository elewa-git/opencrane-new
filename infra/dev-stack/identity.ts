// ponytail: two fixed secondary slots bound resource use on the eight-core dev box.
export const stackId = process.env['DEV_STACK_ID'] ?? 'owner';
if (!['owner', '1', '2'].includes(stackId)) throw new Error('DEV_STACK_ID must be owner, 1 or 2');
export const secondary = stackId !== 'owner';
export const project = `opencrane-dev${secondary ? `-${stackId}` : ''}`;
export const namespace = `opencrane-dev${secondary ? `-${stackId}` : ''}`;
export const ownerPorts = { PG_PORT: '55433', NATS_PORT: '44222', FGA_PORT: '48080',
  MINIO_PORT: '49000', MINIO_CONSOLE_PORT: '49001', SERVER_PORT: '48000', WEB_PORT: '44200',
  MODEL_GATEWAY_PORT: '43000', MODEL_DECISION_PORT: '43001', MODEL_READINESS_PORT: '43002', MODEL_STUB_PORT: '43003', CLAMD_PORT: '43310', MCP_FIXTURE_PORT: '43004' };
export const ports = Object.fromEntries(Object.entries(ownerPorts).map(([name, fallback], index) => {
  const port = secondary ? String(25000 + Number(stackId) * 100 + index) : (index < 7 || name === 'CLAMD_PORT' ? process.env[name] : undefined) ?? fallback;
  if (!/^\d+$/u.test(port) || Number(port) < 1024 || Number(port) > 65535) throw new Error(`Invalid ${name}`);
  if (secondary && process.env[name] && process.env[name] !== port) throw new Error(`Secondary ${name} is fixed`);
  return [name, port];
}));
export const localOrigin = `http://127.0.0.1:${ports['WEB_PORT']}`;
