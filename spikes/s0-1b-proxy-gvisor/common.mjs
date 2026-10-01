import { request } from 'node:http';
export const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
export async function body(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 2_000_000) throw new Error('body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
export function json(res, value, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(value));
}
export function call(url, data, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = request(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers } }, async res => {
      try { resolve({ status: res.statusCode, text: (await body(res)).toString() }); } catch (error) { reject(error); }
    });
    req.setTimeout(15000, () => req.destroy(new Error('request timeout')));
    req.on('error', reject);
    req.end(JSON.stringify(data));
  });
}
