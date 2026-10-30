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

type OfficeBudget = { bytes: number; parts: number };

async function office(
  bytes: Buffer,
  extension: string,
  budget: OfficeBudget = { bytes: 0, parts: 0 },
  depth = 0,
) {
  const mainParts = new Map([
    ['docx', 'word/document.xml'], ['xlsx', 'xl/workbook.xml'], ['pptx', 'ppt/presentation.xml'],
  ]);
  const required = mainParts.get(extension);
  if (!required) throw new Error('Unsupported file type');
  const zip = await new Promise<ZipFile>(openArchive);
  await new Promise<void>(inspectArchive);

  function openArchive(resolve: (zip: ZipFile) => void, reject: (error: Error) => void) {
    function opened(error: Error | null, archive?: ZipFile) {
      if (error || !archive) {
        reject(new Error('Invalid Office document'));
        return;
      }
      resolve(archive);
    }
    const options = { lazyEntries: true };
    fromBuffer(bytes, options, opened);
  }

  function inspectArchive(resolve: () => void, reject: (error: Error) => void) {
    let content = false;
    let types = false;
    function refuse() {
      zip.close();
      reject(new Error('Unsafe Office document'));
    }
    function finished() {
      if (content && types) {
        resolve();
      } else {
        reject(new Error('Invalid Office document'));
      }
    }
    function next() {
      zip.readEntry();
    }
    async function inspect(entry: Entry) {
      checkOfficeEntry(entry, budget, depth);
      content ||= entry.fileName === required;
      types ||= entry.fileName === '[Content_Types].xml';
      if (/embeddings\//iu.test(entry.fileName)) {
        const workbook = await readOfficePart(zip, entry);
        await office(workbook, 'xlsx', budget, depth + 1);
      } else {
        await inspectOfficeXml(zip, entry, required!);
      }
    }
    function received(entry: Entry) {
      const inspection = inspect(entry);
      const advancing = inspection.then(next);
      void advancing.catch(refuse);
    }
    zip.on('error', refuse);
    zip.on('entry', received);
    zip.on('end', finished);
    zip.readEntry();
  }
}

function checkOfficeEntry(entry: Entry, budget: OfficeBudget, depth: number) {
  // Count the embedded ZIP and its unpacked parts against the same upload limits.
  budget.bytes += entry.uncompressedSize;
  budget.parts++;
  const unsafePath = /^\/|(?:^|\/)\.\.(?:\/|$)|\\/u;
  const executable = /\.(?:exe|dll|com|js|vbs|zip|rar|7z)$/iu;
  const activeContent = /vbaProject|macrosheets\/|dialogSheets\/|activeX|oleObject/iu;
  const unsafeName = unsafePath.test(entry.fileName) || executable.test(entry.fileName) ||
    activeContent.test(entry.fileName);
  if (budget.bytes > 80 * 1024 * 1024 || budget.parts > 2000 ||
      (entry.generalPurposeBitFlag & 1) || unsafeName) {
    throw new Error('Unsafe Office document');
  }
  if (/embeddings\//iu.test(entry.fileName) &&
      (depth !== 0 || !/^(?:ppt|word|xl)\/embeddings\/[^/]+\.xlsx$/iu.test(entry.fileName))) {
    throw new Error('Unsafe Office document');
  }
  if (/\.bin$/iu.test(entry.fileName) &&
      !/(?:^|\/)printerSettings\/printerSettings[^/]*\.bin$/iu.test(entry.fileName)) {
    throw new Error('Unsafe Office document');
  }
}

function readOfficePart(zip: ZipFile, entry: Entry): Promise<Buffer> {
  return new Promise(read);
  function read(resolve: (bytes: Buffer) => void, reject: (error: Error) => void) {
    const parts: Buffer[] = [];
    function collect(part: Buffer) {
      parts.push(part);
    }
    function finished() {
      resolve(Buffer.concat(parts));
    }
    function opened(error: Error | null, stream?: NodeJS.ReadableStream) {
      if (error || !stream) {
        reject(new Error('Invalid Office document'));
        return;
      }
      stream.on('error', reject);
      stream.on('data', collect);
      stream.on('end', finished);
    }
    zip.openReadStream(entry, opened);
  }
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
  const isRelationships = entry.fileName.endsWith('.rels');
  const isMetadata = entry.fileName === '[Content_Types].xml' || isRelationships;
  if (!isMetadata && entry.fileName !== main) return;
  if (entry.uncompressedSize > 8 * 1024 * 1024) {
    throw new Error('Unsafe Office document');
  }
  const bytes = await readOfficePart(zip, entry);
  const text = bytes.toString('utf8');
  const forbidden = /macroEnabled|macrosheet|vbaProject|activeX|oleObject/iu;
  if (/<!DOCTYPE|<!ENTITY/iu.test(text) || forbidden.test(text)) {
    throw new Error('Unsafe Office document');
  }
  if (!text.trimStart().startsWith('<') || XMLValidator.validate(text) !== true) {
    throw new Error('Invalid Office document');
  }
  if (!isRelationships && /TargetMode\s*=\s*["']External["']/iu.test(text)) {
    throw new Error('Unsafe Office document');
  }
  if (!isMetadata) return;
  // Parse the small metadata parts so escaped attributes cannot conceal active content.
  const options = { ignoreAttributes: false, parseAttributeValue: false, htmlEntities: true };
  const parser = new XMLParser(options);
  const metadata: unknown = parser.parse(text);
  const decoded = JSON.stringify(metadata);
  if (forbidden.test(decoded)) {
    throw new Error('Unsafe Office document');
  }
  if (isRelationships) {
    inspectRelationships(metadata);
  } else if (/External/iu.test(decoded)) {
    throw new Error('Unsafe Office document');
  }
}

const relationshipSchema = z.strictObject({
  '@_Id': z.string(),
  '@_Type': z.string(),
  '@_Target': z.string(),
  '@_TargetMode': z.enum(['Internal', 'External']).optional(),
});
const relationshipsSchema = z.strictObject({
  '?xml': z.unknown().optional(),
  Relationships: z.union([
    z.literal(''),
    z.strictObject({
      '@_xmlns': z.string().optional(),
      Relationship: z.union([relationshipSchema, z.array(relationshipSchema)]).optional(),
    }),
  ]),
});

function inspectRelationships(metadata: unknown) {
  const result = relationshipsSchema.safeParse(metadata);
  if (!result.success) throw new Error('Unsafe Office document');
  const root = result.data.Relationships;
  if (root === '' || !root.Relationship) return;
  const entries = Array.isArray(root.Relationship) ? root.Relationship : [root.Relationship];
  for (const entry of entries) {
    if (entry['@_TargetMode'] !== 'External') continue;
    const type = entry['@_Type'];
    const transitional = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/';
    const strict = 'http://purl.oclc.org/ooxml/officeDocument/relationships/';
    if ((type !== `${transitional}hyperlink` && type !== `${strict}hyperlink`) ||
        !/^(?:https?:\/\/|mailto:)/iu.test(entry['@_Target'])) {
      throw new Error('Unsafe Office document');
    }
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
