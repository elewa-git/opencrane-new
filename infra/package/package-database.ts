import { Pool } from 'pg';

export function packageDatabaseRoles() {
  const definitions = [
    ['projection', 'PROJECTION_PASSWORD'], ['server', 'SERVER_PASSWORD'],
    ['dispatcher', 'DISPATCHER_PASSWORD'], ['openfga', 'OPENFGA_PASSWORD'],
  ] as const;
  const roles: { name: string; password: string }[] = [];
  for (const [name, setting] of definitions) {
    const password = process.env[setting];
    if (!password || !/^[a-f0-9]{64}$/u.test(password)) {
      throw new Error('Package database credentials unavailable');
    }
    roles.push({ name, password });
  }
  return roles;
}

export async function grantPackageReads(connectionString: string) {
  const projection = new Pool({ connectionString, connectionTimeoutMillis: 2000,
    query_timeout: 5000 });
  try {
    await projection.query('GRANT USAGE ON SCHEMA public TO server');
    await projection.query('GRANT SELECT ON ALL TABLES IN SCHEMA public TO server');
    await projection.query('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO server');
  } finally {
    await projection.end();
  }
}
