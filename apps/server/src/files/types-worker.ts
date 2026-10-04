import { parentPort, workerData } from 'node:worker_threads';
import { z } from 'zod';
import * as cfb from 'cfb';
import { extname } from 'node:path';
import { fileTypeFromBuffer } from 'file-type';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { fromBuffer, type ZipFile, type Entry } from 'yauzl';

const allowed = new Map([
  ['doc', 'application/msword'], ['xls', 'application/vnd.ms-excel'], ['ppt', 'application/vnd.ms-powerpoint'],
  ['pdf', 'application/pdf'], ['png', 'image/png'], ['jpg', 'image/jpeg'], ['jpeg', 'image/jpeg'],
  ['gif', 'image/gif'], ['webp', 'image/webp'], ['bmp', 'image/bmp'], ['tif', 'image/tiff'], ['tiff', 'image/tiff'],
  ['docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ['xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  ['pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
]);
const textTypes = new Set(['txt', 'md', 'csv', 'json']);

async function office(bytes: Buffer, extension: string) {
  const required = new Map([['docx', 'word/document.xml'], ['xlsx', 'xl/workbook.xml'], ['pptx', 'ppt/presentation.xml']]).get(extension);
  if (!required) throw new Error('Unsupported file type');
  await new Promise<void>((resolve, reject) => fromBuffer(bytes, { lazyEntries: true }, (error, zip) => {
    if (error || !zip) { reject(new Error('Invalid Office document')); return; }
    let total = 0, count = 0, content = false, types = false;
    zip.on('error', reject);
    zip.on('entry', (entry: Entry) => {
      total += entry.uncompressedSize; count++;
      if (total > 80 * 1024 * 1024 || count > 2000 || (entry.generalPurposeBitFlag & 1) ||
          /^\/|(?:^|\/)\.\.(?:\/|$)|\\|\.(?:exe|dll|com|js|vbs|zip|rar|7z)$|vbaProject|macrosheets\/|dialogSheets\/|embeddings\/|\.bin$/iu.test(entry.fileName)) {
        zip.close(); reject(new Error('Unsafe Office document')); return;
      }
      content ||= entry.fileName === required; types ||= entry.fileName === '[Content_Types].xml';
      void inspectOfficeXml(zip, entry, required).then(() => zip.readEntry()).catch(() => { zip.close(); reject(new Error('Unsafe Office document')); });
    });
    zip.on('end', () => content && types ? resolve() : reject(new Error('Invalid Office document')));
    zip.readEntry();
  }));
}

async function inspectFile(name: string, bytes: Buffer): Promise<string> {
  const extension = extname(name).slice(1).toLowerCase();
  if (!bytes.length || !/^[\w][\w .()-]{0,119}$/u.test(name)) throw new Error('Unsupported file type');
  const detected = await fileTypeFromBuffer(bytes);
  if (textTypes.has(extension) && !detected && !bytes.subarray(0, 4).equals(Buffer.from('MZ\0\0'))) {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if ([...text].some(char => char.charCodeAt(0) < 32 && !'\t\n\r'.includes(char)) || /^\s*(?:#!|<svg|<!doctype html|<html)/iu.test(text)) throw new Error('Unsupported file type');
    return 'text/plain';
  }
  const mime = allowed.get(extension);
  if (['doc', 'xls', 'ppt'].includes(extension)) return legacyOffice(bytes, extension, mime!);
  if (!mime || !detected || (detected.mime !== mime && !(detected.ext === 'zip' && ['docx', 'xlsx', 'pptx'].includes(extension)))) throw new Error('Unsupported file type');
  if (['docx', 'xlsx', 'pptx'].includes(extension)) await office(bytes, extension);
  return mime;
}

function legacyOffice(bytes: Buffer, extension: string, mime: string) {
  if (!bytes.subarray(0, 8).equals(Buffer.from('d0cf11e0a1b11ae1', 'hex'))) throw new Error('Unsupported file type');
  let container: cfb.CFB$Container;
  try { container = cfb.read(bytes, { type: 'buffer' }); } catch { throw new Error('Invalid Office document'); }
  const paths = container.FullPaths;
  const stream = new Map([['doc', 'WordDocument'], ['xls', 'Workbook'], ['ppt', 'PowerPoint Document']]).get(extension)!;
  if (!paths.some(path => path.endsWith('/' + stream)) || paths.some(path => /VBA|ObjectPool|EncryptedPackage|EncryptionInfo|EncryptedSummary/iu.test(path))) throw new Error('Unsafe Office document');
  const entry = container.FileIndex.find(entry => entry.name === stream);
  if (!entry) throw new Error('Invalid Office document');
  const content = Buffer.from(entry.content);
  if (extension === 'xls') inspectWorkbook(content);
  if (extension === 'doc' && content.length >= 12 && (content.readUInt16LE(10) & 0x8100)) throw new Error('Unsafe Office document');
  return mime;
}

async function inspectOfficeXml(zip: ZipFile, entry: Entry, main: string) {
  if (entry.fileName !== '[Content_Types].xml' && entry.fileName !== main && !entry.fileName.endsWith('.rels')) return;
  if (entry.uncompressedSize > 8 * 1024 * 1024) throw new Error('Unsafe Office document');
  const text = await new Promise<string>((resolve, reject) => zip.openReadStream(entry, (error, stream) => {
    if (error || !stream) { reject(new Error('Invalid Office document')); return; }
    const parts: Buffer[] = [];
    stream.on('error', reject); stream.on('data', (part: Buffer) => parts.push(part));
    stream.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
  }));
  if (/<!DOCTYPE|<!ENTITY|macroEnabled|macrosheet|vbaProject|activeX|oleObject|TargetMode\s*=\s*["']External["']/iu.test(text)) throw new Error('Unsafe Office document');
  if (!text.trimStart().startsWith('<') || XMLValidator.validate(text) !== true) throw new Error('Invalid Office document');
  // Parse the small metadata parts so escaped attributes cannot conceal active content.
  if (entry.fileName !== main) {
    const metadata: unknown = new XMLParser({ ignoreAttributes: false, parseAttributeValue: false, htmlEntities: true }).parse(text);
    if (/macroEnabled|macrosheet|vbaProject|activeX|oleObject|External/iu.test(JSON.stringify(metadata))) throw new Error('Unsafe Office document');
  }
}
function inspectWorkbook(bytes: Buffer) {
  for (let offset = 0; offset + 4 <= bytes.length;) {
    const record = bytes.readUInt16LE(offset), length = bytes.readUInt16LE(offset+2);
    if (offset + 4 + length > bytes.length) throw new Error('Invalid Office document');
    if (record === 0x002f || (record === 0x0085 && length >= 6 && ![0, 2].includes(bytes[offset+9]!))) throw new Error('Unsafe Office document');
    offset += 4 + length;
  }
}

parentPort!.postMessage('ready');
const input = z.object({ name: z.string(), bytes: z.instanceof(Uint8Array) }).parse(workerData as unknown);
void inspectFile(input.name, Buffer.from(input.bytes)).then(
  mime => parentPort!.postMessage(mime),
  (error: unknown) => parentPort!.postMessage(error instanceof Error ? error : new Error('File inspection failed')),
);
