import { readFileSync, readdirSync, lstatSync, realpathSync, openSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';
// Read in bounded chunks so binaries and SQLite files are scanned too.
let key;
try { key = Buffer.from(readFileSync(3).toString('utf8').trim()); } catch { console.log('LEAK: scan-incomplete'); process.exit(1); }
if (!key.length || key.includes(10) || key.includes(13)) { console.log('LEAK: invalid-pattern'); process.exit(1); }
let failed = false;
const visited = new Set();
const roots = process.argv.slice(2);
const report = path => { failed = true; console.log('LEAK: ' + JSON.stringify(path.split(key.toString()).join('[redacted]'))); };
function scan(path, optional = false) {
  let stat;
  try { stat = lstatSync(path); } catch (error) { if (!(optional && error.code === 'ENOENT')) report('scan-incomplete'); return; }
  // Do not follow links outside the scan roots (especially credential links).
  if (stat.isSymbolicLink()) {
    try { const target = realpathSync(path); if (roots.some(root => target === root || target.startsWith(root + '/'))) scan(target); else report(path + ' (unscanned external symlink)'); } catch { report('scan-incomplete'); }
    return;
  }
  if (visited.has(path)) return; visited.add(path);
  if (stat.isDirectory()) { try { for (const name of readdirSync(path)) scan(join(path, name)); } catch { report('scan-incomplete'); } return; }
  if (!stat.isFile()) return;
  let fd;
  try {
    fd = openSync(path, 'r'); const buffer = Buffer.alloc(65536); let tail = Buffer.alloc(0), count;
    while ((count = readSync(fd, buffer)) > 0) {
      const piece = Buffer.concat([tail, buffer.subarray(0, count)]);
      if (piece.includes(key)) { report(path); break; }
      tail = Buffer.from(piece.subarray(Math.max(0, piece.length - key.length + 1)));
    }
  } catch { report('scan-incomplete'); } finally { if (fd !== undefined) closeSync(fd); }
}
for (const [index, path] of process.argv.slice(2).entries()) scan(path, index > 0);
if (!failed) console.log('CLEAN');
process.exitCode = failed ? 1 : 0;
