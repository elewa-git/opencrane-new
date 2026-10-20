import { readFile, writeFile } from 'node:fs/promises';

// Keep Minio 8.0.7 working with the first stream-json release that fixes the advisories.
// Remove this patch and the override when Minio supports the new parser itself.
const minioDirectory = new URL('../../node_modules/minio/', import.meta.url);
const manifestPath = new URL('package.json', minioDirectory);
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
if (manifest.version !== '8.0.7') {
  throw new Error('Review the stream-json compatibility patch before changing Minio.');
}

async function patchNotification(relativePath, oldFactory, newFactory) {
  const path = new URL(relativePath, minioDirectory);
  const source = await readFile(path, 'utf8');
  const oldImport = 'stream-json/jsonl/Parser.js';
  const newImport = 'stream-json/jsonl/parser.js';
  let updatedSource = source;
  const alreadyPatched = source.includes(newImport) && source.includes(newFactory);
  if (!alreadyPatched) {
    if (!source.includes(oldImport) || !source.includes(oldFactory)) {
      throw new Error(`Minio notification code changed: ${relativePath}`);
    }
    const updatedImport = source.replace(oldImport, newImport);
    updatedSource = updatedImport.replace(oldFactory, newFactory);
  }
  // Identify each changed file, as Minio's Apache-2.0 licence requires.
  const changeNotice = '// Changed by OpenCrane to use stream-json 3.6.0.\n';
  if (!updatedSource.startsWith(changeNotice)) {
    updatedSource = `${changeNotice}${updatedSource}`;
  }
  if (updatedSource !== source) {
    await writeFile(path, updatedSource);
  }
}

await patchNotification('dist/esm/notification.mjs',
  'jsonLineParser.make()', 'jsonLineParser.asStream()');
await patchNotification('dist/main/notification.js',
  '_Parser.make()', '_Parser.default.asStream()');
