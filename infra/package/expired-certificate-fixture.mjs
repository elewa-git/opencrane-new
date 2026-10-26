import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';

const execute = promisify(execFile);

export async function expireCertificate(directory) {
  const config = `[ca]
default_ca = issuer
[issuer]
database = index.txt
serial = serial.txt
new_certs_dir = .
certificate = ca.crt
private_key = ca.key
default_md = sha256
policy = subject
[subject]
commonName = supplied
`;
  await writeFile(`${directory}/expired.conf`, config);
  await writeFile(`${directory}/index.txt`, '');
  await writeFile(`${directory}/serial.txt`, '01\n');
  // Use an ordered interval in the past; negative days fail on some OpenSSL versions.
  await execute('openssl', ['ca', '-batch', '-notext', '-config', 'expired.conf',
    '-in', 'peer-0.csr', '-out', 'peer-0.crt', '-extfile', 'peer-0.ext',
    '-startdate', '20200101000000Z', '-enddate', '20200102000000Z'], { cwd: directory });
  const expired = new X509Certificate(await readFile(`${directory}/peer-0.crt`));
  assert.ok(Date.parse(expired.validFrom) < Date.parse(expired.validTo),
    'The expired identity must have an ordered validity interval');
  assert.ok(Date.parse(expired.validTo) < Date.now(),
    'The identity must have expired before the installer runs');
}
