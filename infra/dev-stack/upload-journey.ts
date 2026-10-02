import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { uploadPdf } from '../../apps/server/test/support/upload-pdf.ts';

/** The same small HTTP seam used by the future attach menu. */
export async function uploadJourney(server: string, headers: { origin: string; cookie: string }, conversationId: string) {
  const url = `${server}/api/conversations/${conversationId}/files`;
  const upload = (name: string, bytes: Buffer) => fetch(url, { method: 'POST', headers: { ...headers, 'content-type': 'application/octet-stream',
    'x-file-name': name, 'idempotency-key': randomUUID() }, body: new Uint8Array(bytes) });
  const clean = await upload('project.pdf', uploadPdf()); assert.equal(clean.status, 201);
  const { fileId } = await clean.json() as { fileId: string };
  const infected = await upload('eicar.txt', Buffer.from('X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*'));
  assert.equal(infected.status, 422); assert((await infected.text()).includes('malware detected'));
  const deadline = Date.now()+120_000;
  let textPath = '';
  while (!textPath) {
    const list = await fetch(url, { headers }); assert.equal(list.status, 200);
    const { rows } = await list.json() as { rows: Array<{ fileId: string; status: string; textPath?: string }> };
    assert.equal(rows.length, 1, 'Infected bytes never appear in the list');
    textPath = rows.find(file => file.fileId === fileId && file.status === 'delivered')?.textPath ?? '';
    assert(Date.now() < deadline, 'Upload delivery timed out'); if (!textPath) await delay(100);
  }
  const id = randomUUID();
  const response = await fetch(`${server}/api/conversations/${conversationId}/messages`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ id, text: `UPLOAD_PDF_PROOF Read /workspace/${textPath} and tell me the project code.` }) });
  assert.equal(response.status, 200);
  while (true) {
    const result = await fetch(`${server}/api/conversations/${conversationId}/messages`, { headers });
    const { rows } = await result.json() as { rows: Array<{ type: string; data: { turnId?: string; text?: string } }> };
    if (rows.some(row => row.type === 'agent.turn_completed' && row.data.turnId === id)) {
      assert(rows.some(row => row.type === 'agent.message_completed' && row.data.turnId === id && row.data.text?.includes('Willow-47')));
      break;
    }
    assert(Date.now() < deadline, 'PDF answer timed out'); await delay(100);
  }
  return { path: `/workspace/uploads/${conversationId}/${fileId}/project.pdf`, textPath: `/workspace/${textPath}` };
}
