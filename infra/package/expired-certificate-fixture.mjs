import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';

const execute = promisify(execFile);

export async function expireCertificate(directory) {
  await dateCertificate(directory, 'peer-0', 'expired');
}

export async function dateCertificate(directory, name, period) {
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
  const start = period === 'future' ? '20990101000000Z' : '20200101000000Z';
  const end = period === 'future' ? '20990102000000Z' : '20200102000000Z';
  await execute('openssl', ['ca', '-batch', '-notext', '-config', 'expired.conf',
    '-in', `${name}.csr`, '-out', `${name}.crt`, '-extfile', `${name}.ext`,
    '-startdate', start, '-enddate', end], { cwd: directory });
  const expired = new X509Certificate(await readFile(`${directory}/${name}.crt`));
  assert.ok(Date.parse(expired.validFrom) < Date.parse(expired.validTo),
    'The expired identity must have an ordered validity interval');
  if (period === 'future') {
    assert.ok(Date.parse(expired.validFrom) > Date.now());
  } else {
    assert.ok(Date.parse(expired.validTo) < Date.now(),
      'The identity must have expired before the installer runs');
  }
}
