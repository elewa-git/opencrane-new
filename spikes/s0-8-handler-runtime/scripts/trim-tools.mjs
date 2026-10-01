// Keep only this host's SDK binary. npm ci restores the published package.
import { readdirSync, rmSync } from 'node:fs';
const platform = { darwin: 'apple-darwin', linux: 'unknown-linux-gnu', win32: 'pc-windows-msvc' }[process.platform];
const arch = { arm64: 'aarch64', x64: 'x86_64' }[process.arch];
if (!platform || !arch) throw Error('Unsupported host');
const root = 'node_modules/@temporalio/core-bridge/releases';
for (const name of readdirSync(root)) {
  if (name !== `${arch}-${platform}`) rmSync(`${root}/${name}`, { recursive: true, force: true });
}
console.log(`Kept SDK native binary for ${arch}-${platform}`);
