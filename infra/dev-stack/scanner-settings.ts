import { readFile } from 'node:fs/promises';

const refusal = 'Authenticated scanner settings are required before startup';

export async function scannerSettings(environment: NodeJS.ProcessEnv) {
  const url = environment['DEV_SCANNER_URL'];
  const caFile = environment['DEV_SCANNER_CA_FILE'];
  if (!url || !caFile) throw new Error(refusal);

  try {
    const endpoint = new URL(url);
    if (endpoint.protocol !== 'https:' || endpoint.pathname !== '/scan/upload' ||
        endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
      throw new Error(refusal);
    }
    const certificate = await readFile(caFile);
    if (!certificate.length) throw new Error(refusal);
  } catch {
    // Keep private paths and TLS parser details out of startup output.
    throw new Error(refusal);
  }

  return { SCANNER_URL: url, SCANNER_CA_FILE: caFile };
}
