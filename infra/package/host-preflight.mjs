import { readFileSync, statSync } from 'node:fs';

const swapFix = 'F1: disable swap, or use plain dm-crypt swap with a fresh random key at each boot ' +
  '(/etc/crypttab: NAME DEVICE /dev/urandom plain,swap,cipher=aes-xts-plain64,size=256); ' +
  'activate only that mapped swap device and reboot to verify the boot configuration.';
const dumpFix = 'F2: disable host crash reporters (including apport and systemd-coredump); ' +
  'persist kernel.core_pattern= and kernel.core_uses_pid=0 in /etc/sysctl.d/99-no-core.conf, ' +
  'apply those settings and verify they remain after reboot.';

function bootEncrypted(name, crypttab) {
  const entries = [];
  for (const line of crypttab.split('\n')) {
    const commentParts = line.split('#');
    const commentFreeText = commentParts[0];
    const content = commentFreeText.trim();
    if (!content) {
      continue;
    }
    const fields = content.split(/\s+/u);
    if (fields[0] === name) {
      entries.push(fields);
    }
  }
  if (entries.length !== 1) {
    return false;
  }
  const fields = entries[0];
  const optionText = fields[3] ?? '';
  const options = optionText.split(',');
  return fields.length === 4 && fields[2] === '/dev/urandom' &&
    options.length === 4 && options.includes('plain') && options.includes('swap') &&
    options.includes('cipher=aes-xts-plain64') && options.includes('size=256') &&
    !options.includes('noauto') && !options.includes('luks');
}

function encryptedSwap(path, state) {
  for (const mapping of state.mappings) {
    if (mapping.path === path && mapping.uuid === `CRYPT-PLAIN-${mapping.name}` &&
        bootEncrypted(mapping.name, state.crypttab)) {
      return true;
    }
  }
  return false;
}

function safeSwap(state) {
  const lines = state.swaps.split('\n');
  const header = lines.shift();
  if (!/^Filename\s+Type\s+Size\s+Used\s+Priority$/u.test(header ?? '')) {
    return false;
  }
  for (const line of lines) {
    if (line === '') {
      continue;
    }
    const trimmedRow = line.trim();
    const fields = trimmedRow.split(/\s+/u);
    if (fields.length !== 5 || fields[1] !== 'partition' ||
        !encryptedSwap(fields[0], state)) {
      return false;
    }
  }
  return true;
}

export function hostFailures(state) {
  const failures = [];
  if (!safeSwap(state)) {
    failures.push(swapFix);
  }
  // Refuse a PID suffix too: an empty pattern can still produce hidden .PID files.
  if (state.corePattern !== '\n' || state.coreUsesPid !== '0\n') {
    failures.push(dumpFix);
  }
  return failures;
}

function readOptional(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      return '';
    }
    throw error;
  }
}

export function collectHost(prefix = '') {
  const swaps = readFileSync(`${prefix}/proc/swaps`, 'utf8');
  const state = {
    swaps,
    corePattern: readFileSync(`${prefix}/proc/sys/kernel/core_pattern`, 'utf8'),
    coreUsesPid: readFileSync(`${prefix}/proc/sys/kernel/core_uses_pid`, 'utf8'),
    crypttab: readOptional(`${prefix}/etc/crypttab`),
    mappings: [],
  };
  const lines = swaps.split('\n');
  lines.shift();
  for (const line of lines) {
    const fields = line.split(/\s+/u);
    const path = fields[0];
    if (!path || !/^\/dev\/(dm-\d+|mapper\/[a-zA-Z0-9_-]+)$/u.test(path)) {
      continue;
    }
    const device = statSync(`${prefix}${path}`);
    if (!device.isBlockDevice()) {
      continue;
    }
    // Decode Linux dev_t without reading a device or exposing its encryption key.
    const major = ((device.rdev >>> 8) & 0xfff) | ((device.rdev / 2 ** 32) & 0xfffff000);
    const minor = (device.rdev & 0xff) | ((device.rdev >>> 12) & 0xffffff00);
    const base = `${prefix}/sys/dev/block/${major}:${minor}/dm`;
    const nameValue = readOptional(`${base}/name`);
    const name = nameValue.trim();
    const uuidValue = readOptional(`${base}/uuid`);
    const uuid = uuidValue.trim();
    const mapping = { path, name, uuid };
    state.mappings.push(mapping);
  }
  return state;
}
