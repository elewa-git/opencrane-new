import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';

function checkExposure(values) {
  const exposure = values.exposure;
  if (!exposure || exposure.ingress !== false || exposure.loadBalancer !== false ||
      exposure.funnel !== false) {
    throw new Error('Public ingress, LoadBalancer and Funnel are refused');
  }
  for (const name of Object.keys(exposure)) {
    if (!['ingress', 'loadBalancer', 'funnel', 'public'].includes(name)) {
      throw new Error('Unsupported exposure setting');
    }
  }
  checkPublicAddress(exposure.public);
}

function checkPublicAddress(address) {
  if (address === undefined) {
    return;
  }
  if (!address || typeof address !== 'object' || Array.isArray(address) ||
      typeof address.enabled !== 'boolean') {
    throw new Error('Public address requires an explicit enabled choice');
  }
  for (const name of Object.keys(address)) {
    if (!['enabled', 'host', 'tlsSecret'].includes(name)) {
      throw new Error('Unsupported public address setting');
    }
  }
  if (!address.enabled) {
    return;
  }
  checkHostname(address.host);
  checkTlsSecret(address.tlsSecret);
}

const dnsLabel = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const hostname = new RegExp(`^(?:${dnsLabel}\\.)+${dnsLabel}$`, 'u');
const secretName = new RegExp(`^(?:${dnsLabel}\\.)*${dnsLabel}$`, 'u');

function checkHostname(host) {
  if (typeof host !== 'string' || host.length > 253 ||
      !hostname.test(host) || isIP(host) !== 0) {
    throw new Error('Public address host must be a plain DNS name');
  }
}

function checkTlsSecret(name) {
  if (typeof name !== 'string' || name.length > 253 || !secretName.test(name)) {
    throw new Error('Public address requires a TLS secret name');
  }
}

export function checkPublicSettings(values, settings) {
  checkExposure(values);
  if (values.exposure.public?.enabled !== true) {
    return;
  }
  if (typeof settings.OIDC_EXPECTED_ORG_ID !== 'string' ||
      !settings.OIDC_EXPECTED_ORG_ID.trim()) {
    throw new Error('Public address requires OIDC_EXPECTED_ORG_ID');
  }
  for (const [name, expected] of [['NODE_ENV', 'production'], ['OIDC_COOKIE_SECURE', 'true']]) {
    if (settings[name] !== expected) {
      throw new Error(`Public address requires ${name}=${expected}`);
    }
  }
  const redirect = `https://${values.exposure.public.host}/auth/callback`;
  if (settings.OIDC_REDIRECT_URI !== redirect) {
    throw new Error('Public address requires the exact HTTPS OIDC_REDIRECT_URI');
  }
  for (const name of ['OIDC_EXTRA_IDENTITIES', 'DEV_OWNER_EMAIL']) {
    if (Object.hasOwn(settings, name)) {
      throw new Error(`Public address refuses ${name}`);
    }
  }
}

export function readPublicSettings(values) {
  checkExposure(values);
  if (values.exposure.public?.enabled !== true) {
    return {};
  }
  let settings;
  try {
    settings = JSON.parse(readFileSync(process.env.PACKAGE_PUBLIC_SETTINGS_FILE, 'utf8'));
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
      throw new Error('Expected a settings object');
    }
    for (const value of Object.values(settings)) {
      if (typeof value !== 'string' || /[\r\n]/u.test(value)) {
        throw new Error('Expected single-line text settings');
      }
    }
  } catch (cause) {
    throw new Error('Public sign-in settings file is unavailable or invalid', { cause });
  }
  checkPublicSettings(values, settings);
  return settings;
}
