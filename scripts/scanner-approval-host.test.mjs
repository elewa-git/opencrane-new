import { execFile, execFileSync } from 'node:child_process';
import { createServer } from 'node:https';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from 'vitest';
import { scannerApprovalFixture } from '../infra/clamav/approval-fixture.mjs';

const execute = promisify(execFile);
const repository = 'elewa-git/opencrane-new';
async function maliciousApprovalServer() {
  const directory = await mkdtemp(join(tmpdir(), 'scanner-host-'));
  const image = 'k3d-ocn-registry:5000/opencrane/scanner@sha256:' + 'b'.repeat(64);
  const fixture = await scannerApprovalFixture(directory, { images: { scanner: image } });
  // Keep the real GitHub CLI; fake only the local checkout identity.
  await rm(join(directory, 'gh'));
  for (const [name, bytes] of Object.entries(fixture.files)) {
    await writeFile(join(directory, name), bytes);
  }
  const zipScript = 'import zipfile; z=zipfile.ZipFile("approval.zip","w"); ' +
    '[z.write(p) for p in ["approval.json","signatures.json","release.json"]]; z.close()';
  execFileSync('python3', ['-c', zipScript], { cwd: directory });
  const archive = await readFile(join(directory, 'approval.zip'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', 'server.key', '-out', 'server.crt', '-days', '1', '-subj', '/CN=localhost',
    '-addext', 'subjectAltName=DNS:localhost'], { cwd: directory, stdio: 'ignore' });
  const key = await readFile(join(directory, 'server.key'));
  const cert = await readFile(join(directory, 'server.crt'));
  const requests = [];
  function reply(request, response) {
    requests.push(request.url);
    if (request.url.endsWith('/zip')) {
      response.setHeader('Content-Type', 'application/zip');
      response.end(archive);
      return;
    }
    response.setHeader('Content-Type', 'application/json');
    if (request.url.includes('/artifacts')) {
      const artifact = { id: 7, name: 'scanner-approval', expired: false,
        archive_download_url: `https://localhost:${server.address().port}/api/v3/repos/${repository}/actions/artifacts/7/zip` };
      response.end(JSON.stringify({ total_count: 1, artifacts: [artifact] }));
      return;
    }
    response.end(JSON.stringify({ workflow_runs: [fixture.run] }));
  }
  const server = createServer({ key, cert }, reply);
  function listen(resolveListening) { server.listen(0, '127.0.0.1', resolveListening); }
  await new Promise(listen);
  return { server, directory, requests };
}
async function inheritedHostCannotApprove() {
  const fixture = await maliciousApprovalServer();
  try {
    const host = `localhost:${fixture.server.address().port}`;
    const env = { ...process.env, GH_HOST: host, GH_ENTERPRISE_TOKEN: 'synthetic-enterprise-token',
      GH_TOKEN: '', GITHUB_TOKEN: '', GITHUB_ENTERPRISE_TOKEN: '',
      SSL_CERT_FILE: join(fixture.directory, 'server.crt'),
      PATH: fixture.directory + ':' + process.env.PATH };
    const probe = await execute('gh', ['api', `repos/${repository}/actions/workflows/scanner-package.yml/runs`], { env });
    expect(JSON.parse(probe.stdout).workflow_runs[0].id).toBe(42);
    fixture.requests.length = 0;
    const modulePath = resolve('infra/clamav/approval.mjs');
    const script = `import { fetchScannerApproval } from ${JSON.stringify(modulePath)};\n` +
      'try { await fetchScannerApproval(); console.log("APPROVED"); }\n' +
      'catch { console.log("REFUSED"); }';
    const result = await execute(process.execPath, ['--input-type=module', '-e', script], { env });
    expect(result.stdout).toContain('REFUSED');
    expect(result.stdout).not.toContain('APPROVED');
    expect(fixture.requests).toEqual([]);
  } finally {
    fixture.server.closeAllConnections();
    function close(resolveClosed) { fixture.server.close(resolveClosed); }
    await new Promise(close);
    await rm(fixture.directory, { recursive: true, force: true });
  }
}
test('a controlled inherited GH_HOST serving valid approval cannot grant approval',
  inheritedHostCannotApprove);
