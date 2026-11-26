import { readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';

const contentTypes = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.woff2': 'font/woff2',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
};

export async function serveWebBuild(route, buildDirectory) {
  const request = route.request();
  const url = new URL(request.url());
  if (url.pathname === '/api/onboarding/entry' && request.method() === 'GET') {
    // Serve the response for an installation with welcome setup turned off.
    const disabled = { status: 204 };
    await route.fulfill(disabled);
    return;
  }
  let filename = resolve(buildDirectory, `.${url.pathname}`);
  if (!extname(url.pathname)) filename = resolve(buildDirectory, 'index.html');
  if (!filename.startsWith(`${buildDirectory}/`)) {
    await route.abort();
    return;
  }
  const body = await readFile(filename);
  const contentType = contentTypes[extname(filename)] ?? 'application/octet-stream';
  await route.fulfill({ body, contentType });
}
