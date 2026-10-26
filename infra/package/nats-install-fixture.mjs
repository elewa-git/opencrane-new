import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { certificates, issueCertificate, sharedCertificates } from '../../libs/event-store/test/certificates.ts';
import { dateCertificate } from './expired-certificate-fixture.mjs';

function encoded(value) {
  return Buffer.from(value).toString('base64');
}

function extensions(role) {
  if (role === 'server') {
    return 'subjectAltName=DNS:nats,DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth\n';
  }
  return 'extendedKeyUsage=clientAuth\n';
}

async function changeIdentity(directory, role, fault) {
  let subject = role;
  if (role === 'server') subject = 'nats';
  let usage = extensions(role);
  if (fault === 'name') subject = 'foreign';
  if (fault === 'SAN') {
    if (role === 'server') usage = usage.replace('DNS:nats', 'DNS:foreign');
    else usage += 'subjectAltName=DNS:foreign\n';
  }
  if (fault === 'usage') {
    usage = usage.replace('serverAuth', 'clientAuth');
    if (role !== 'server') usage = usage.replace('clientAuth', 'serverAuth');
  }
  if (fault === 'extra usage') usage = usage.replace('Auth\n', 'Auth,codeSigning\n');
  if (fault === 'CA identity') usage += 'basicConstraints=critical,CA:TRUE\n';
  await issueCertificate(directory, role, `/CN=${subject}`, usage);
  if (fault === 'expired' || fault === 'future') {
    await dateCertificate(directory, role, fault);
  }
  if (fault === 'issuer') {
    const foreign = `${directory}/foreign`;
    await mkdir(foreign);
    await certificates(foreign);
    await issueCertificate(foreign, role, `/CN=${subject}`, usage);
    for (const suffix of ['crt', 'key']) {
      await writeFile(`${directory}/${role}.${suffix}`, await readFile(`${foreign}/${role}.${suffix}`));
    }
  }
  if (fault === 'key') {
    await writeFile(`${directory}/${role}.key`, await readFile(`${directory}/unknown.key`));
  }
}

export async function prepareNatsFixture(fixture, directory) {
  await sharedCertificates(directory);
  await issueCertificate(directory, 'server', '/CN=nats', extensions('server'));
  if (fixture.identityFault) {
    await changeIdentity(directory, ...fixture.identityFault);
  }
  const server = fixture.secrets.nats.data;
  const files = fixture.secrets.runtimefiles.data;
  for (const name of ['ca.crt', 'server.crt', 'server.key']) {
    server[name] = encoded(await readFile(`${directory}/${name}`));
  }
  files['ca.crt'] = server['ca.crt'];
  for (const role of ['command', 'projection', 'dispatcher']) {
    for (const suffix of ['crt', 'key', 'seed']) {
      files[`${role}.${suffix}`] = encoded(await readFile(`${directory}/${role}.${suffix}`));
    }
  }
  for (const role of ['command', 'projection', 'dispatcher', 'computer', 'gateway']) {
    server[`NATS_${role.toUpperCase()}_NKEY`] = encoded(await readFile(`${directory}/${role}.pub`));
  }
  const settings = { NATS_LISTEN: '0.0.0.0:4222', NATS_STORE_DIR: '/data',
    NATS_CA_FILE: '/tls/ca.crt', NATS_CERT_FILE: '/tls/server.crt', NATS_KEY_FILE: '/tls/server.key' };
  for (const [name, value] of Object.entries(settings)) server[name] = encoded(value);
  const runtime = { NATS_URL: 'tls://nats:4222', NATS_CA_FILE: '/run/opencrane/files/ca.crt',
    NATS_CERT_FILE: '/run/opencrane/files/command.crt',
    NATS_KEY_FILE: '/run/opencrane/files/command.key',
    NATS_NKEY_SEED_FILE: '/run/opencrane/files/command.seed', NATS_INBOX_PREFIX: '_INBOX.command' };
  for (const [name, value] of Object.entries(runtime)) {
    fixture.secrets.runtime.data[name] = encoded(value);
    fixture.secrets.runtime.data[`COMMAND_${name}`] = encoded(value);
  }
  let config = await readFile('infra/nats/nats.conf', 'utf8');
  if (fixture.configFault) config = config.replace(...fixture.configFault);
  server['nats.conf'] = encoded(config);
  if (fixture.settingFault) {
    const [secret, name, value] = fixture.settingFault;
    fixture.secrets[secret].data[name] = encoded(value);
  }
  if (fixture.nkeyFault) {
    const [role, fault] = fixture.nkeyFault;
    const name = `NATS_${role.toUpperCase()}_NKEY`;
    if (fault === 'invalid') server[name] = encoded('invalid');
    if (fault === 'duplicate') server[name] = server.NATS_GATEWAY_NKEY;
    if (fault === 'seed') files[`${role}.seed`] = encoded(await readFile(`${directory}/unknown.seed`));
  }
  if (fixture.caFault === 'runtime') files['ca.crt'] = files['command.crt'];
}
