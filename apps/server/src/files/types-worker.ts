import { InspectionRefusal, inspectionReason } from './inspection-refusal.ts';
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
  budget: OfficeBudget,
  depth: number,
) {
  const mainParts = new Map([
    ['docx', 'word/document.xml'], ['xlsx', 'xl/workbook.xml'], ['pptx', 'ppt/presentation.xml'],
  ]);
  const required = mainParts.get(extension);
  if (!required) {
    throw new InspectionRefusal('unsupported_type', 'Unsupported file type');
  }
  const zip = await new Promise<ZipFile>(openArchive);
  await new Promise<void>(inspectArchive);

  function openArchive(resolve: (zip: ZipFile) => void, reject: (error: Error) => void) {
    function opened(error: Error | null, archive?: ZipFile) {
      if (error || !archive) {
        reject(new InspectionRefusal('invalid_file', 'Invalid Office document'));
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
    function refuse(error: unknown) {
      zip.close();
      reject(new InspectionRefusal(inspectionReason(error)));
    }
    function finished() {
      if (content && types) {
        resolve();
      } else {
        reject(new InspectionRefusal('invalid_file', 'Invalid Office document'));
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
        await inspectFile('workbook.xlsx', workbook, budget, depth + 1);
      } else {
        await inspectOfficeXml(zip, entry, required!);
      }
    }
    function received(entry: Entry) {
      const inspection = inspect(entry);
      const advancing = inspection.then(next);
      void advancing.catch(refuse);
    }
    function archiveFailed(error: Error) {
      if (/invalid relative path|absolute path|invalid characters/iu.test(error.message)) {
        refuse(new InspectionRefusal('unsafe_name'));
        return;
      }
      refuse(error);
    }
    zip.on('error', archiveFailed);
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
  if (budget.bytes > 80 * 1024 * 1024) {
    throw new InspectionRefusal('too_large');
  }
  if (budget.parts > 2000) {
    throw new InspectionRefusal('too_many_parts');
  }
  if (entry.generalPurposeBitFlag & 1) {
    throw new InspectionRefusal('encrypted');
  }
  if (unsafePath.test(entry.fileName) || executable.test(entry.fileName)) {
    throw new InspectionRefusal('unsafe_name');
  }
  if (/vbaProject|macrosheets\/|dialogSheets\//iu.test(entry.fileName)) {
    throw new InspectionRefusal('macros');
  }
  if (/activeX|oleObject/iu.test(entry.fileName)) {
    throw new InspectionRefusal('embedded_object');
  }
  if (/embeddings\//iu.test(entry.fileName) &&
      (depth !== 0 || !/^(?:ppt|word|xl)\/embeddings\/[^/]+\.xlsx$/iu.test(entry.fileName))) {
    throw new InspectionRefusal('embedded_object');
  }
  if (/\.bin$/iu.test(entry.fileName) &&
      !/(?:^|\/)printerSettings\/printerSettings[^/]*\.bin$/iu.test(entry.fileName)) {
    throw new InspectionRefusal('embedded_object');
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
        reject(new InspectionRefusal('invalid_file', 'Invalid Office document'));
        return;
      }
      stream.on('error', reject);
      stream.on('data', collect);
      stream.on('end', finished);
    }
    zip.openReadStream(entry, opened);
  }
}

async function inspectFile(
  name: string,
  bytes: Buffer,
  budget: OfficeBudget,
  depth: number,
): Promise<string> {
  const suffix = extname(name);
  const bareExtension = suffix.slice(1);
  const extension = bareExtension.toLowerCase();
  if (!bytes.length) {
    throw new InspectionRefusal('invalid_file', 'Unsupported file type');
  }
  if (!/^[\w][\w .()-]{0,119}$/u.test(name)) {
    throw new InspectionRefusal('unsafe_name', 'Unsupported file type');
  }
  const detected = await fileTypeFromBuffer(bytes);
  if (textTypes.has(extension) && !detected && !bytes.subarray(0, 4).equals(Buffer.from('MZ\0\0'))) {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    function isControlCharacter(character: string) {
      return character.charCodeAt(0) < 32 && !'\t\n\r'.includes(character);
    }
    const hasControlCharacters = [...text].some(isControlCharacter);
    const hasActiveContent = /^\s*(?:#!|<svg|<!doctype html|<html)/iu.test(text);
    if (hasControlCharacters || hasActiveContent) {
      throw new InspectionRefusal('content_mismatch', 'Unsupported file type');
    }
    return 'text/plain';
  }
  const mime = allowed.get(extension);
  if (['doc', 'xls', 'ppt'].includes(extension)) return legacyOffice(bytes, extension, mime!);
  if (!mime) {
    throw new InspectionRefusal('unsupported_type', 'Unsupported file type');
  }
  if (!detected) {
    throw new InspectionRefusal('content_mismatch', 'Unsupported file type');
  }
  const isOfficeZip = detected.ext === 'zip' && ['docx', 'xlsx', 'pptx'].includes(extension);
  if (detected.mime !== mime && !isOfficeZip) {
    throw new InspectionRefusal('content_mismatch', 'Unsupported file type');
  }
  if (['docx', 'xlsx', 'pptx'].includes(extension)) await office(bytes, extension, budget, depth);
  return mime;
}

function legacyOffice(bytes: Buffer, extension: string, mime: string) {
  const signature = Buffer.from('d0cf11e0a1b11ae1', 'hex');
  if (!bytes.subarray(0, 8).equals(signature)) {
    throw new InspectionRefusal('content_mismatch', 'Unsupported file type');
  }
  let container: cfb.CFB$Container;
  try {
    container = cfb.read(bytes, { type: 'buffer' });
  } catch {
    throw new InspectionRefusal('invalid_file', 'Invalid Office document');
  }
  const paths = container.FullPaths;
  const stream = new Map([['doc', 'WordDocument'], ['xls', 'Workbook'], ['ppt', 'PowerPoint Document']]).get(extension)!;
  for (const path of paths) {
    if (/VBA/iu.test(path)) {
      throw new InspectionRefusal('macros');
    }
    if (/ObjectPool/iu.test(path)) {
      throw new InspectionRefusal('embedded_object');
    }
    if (/EncryptedPackage|EncryptionInfo|EncryptedSummary/iu.test(path)) {
      throw new InspectionRefusal('encrypted');
    }
  }
  function isMainStream(path: string) {
    return path.endsWith('/' + stream);
  }
  if (!paths.some(isMainStream)) {
    throw new InspectionRefusal('invalid_file');
  }
  function isMainEntry(entry: cfb.CFB$Entry) {
    return entry.name === stream;
  }
  const entry = container.FileIndex.find(isMainEntry);
  if (!entry) {
    throw new InspectionRefusal('invalid_file', 'Invalid Office document');
  }
  const content = Buffer.from(entry.content);
  if (extension === 'xls') inspectWorkbook(content);
  if (extension === 'doc' && content.length >= 12 && (content.readUInt16LE(10) & 0x8100)) {
    throw new InspectionRefusal('encrypted');
  }
  return mime;
}

async function inspectOfficeXml(zip: ZipFile, entry: Entry, main: string) {
  const isRelationships = entry.fileName.endsWith('.rels');
  const isMetadata = entry.fileName === '[Content_Types].xml' || isRelationships;
  if (!isMetadata && entry.fileName !== main) return;
  if (entry.uncompressedSize > 8 * 1024 * 1024) {
    throw new InspectionRefusal('too_large');
  }
  const bytes = await readOfficePart(zip, entry);
  const text = bytes.toString('utf8');
  if (/<!DOCTYPE|<!ENTITY/iu.test(text)) {
    throw new InspectionRefusal('invalid_file');
  }
  inspectActiveContent(text);
  if (!text.trimStart().startsWith('<') || XMLValidator.validate(text) !== true) {
    throw new InspectionRefusal('invalid_file', 'Invalid Office document');
  }
  if (!isRelationships && /TargetMode\s*=\s*["']External["']/iu.test(text)) {
    throw new InspectionRefusal('external_link');
  }
  if (!isMetadata) return;
  // Parse the small metadata parts so escaped attributes cannot conceal active content.
  const options = { ignoreAttributes: false, parseAttributeValue: false, htmlEntities: true };
  const parser = new XMLParser(options);
  const metadata: unknown = parser.parse(text);
  const decoded = JSON.stringify(metadata);
  inspectActiveContent(decoded);
  if (isRelationships) {
    inspectRelationships(metadata);
  } else if (/External/iu.test(decoded)) {
    throw new InspectionRefusal('external_link');
  }
}

function inspectActiveContent(value: string) {
  if (/macroEnabled|macrosheet|vbaProject/iu.test(value)) {
    throw new InspectionRefusal('macros');
  }
  if (/activeX|oleObject/iu.test(value)) {
    throw new InspectionRefusal('embedded_object');
  }
}

const relationshipSchema = z.strictObject({
  '@_Id': z.string(),
  '@_Type': z.string(),
  '@_Target': z.string(),
  '@_TargetMode': z.enum(['Internal', 'External']).optional(),
});
const xmlObjectSchema = z.record(z.string(), z.unknown());
const relationshipNamespace = 'http://schemas.openxmlformats.org/package/2006/relationships';

function resolveRelationshipElement(
  qualifiedName: string,
  value: unknown,
  expectedName: string,
  inheritedNamespaces: Map<string, string>,
) {
  const content = xmlObjectSchema.parse(value === '' ? {} : value);
  const namespaces = new Map(inheritedNamespaces);
  for (const [name, declaration] of Object.entries(content)) {
    if (name === '@_xmlns') {
      namespaces.set('', z.string().parse(declaration));
      delete content[name];
    } else if (name.startsWith('@_xmlns:')) {
      namespaces.set(name.slice('@_xmlns:'.length), z.string().parse(declaration));
      delete content[name];
    }
  }
  const names = qualifiedName.split(':');
  const localName = names.pop();
  const prefix = names.pop() ?? '';
  const namespace = namespaces.get(prefix);
  // Resolve each declaration where it applies; stripping prefixes would hide wrong namespaces.
  const unqualified = !prefix && namespace === undefined;
  const emptyPrefix = qualifiedName.startsWith(':');
  if (emptyPrefix || names.length || localName !== expectedName ||
      (!unqualified && namespace !== relationshipNamespace)) {
    throw new InspectionRefusal('invalid_file');
  }
  return { content, namespaces };
}

function readRelationships(metadata: unknown) {
  const document = xmlObjectSchema.parse(metadata);
  delete document['?xml'];
  const roots = Object.entries(document);
  if (roots.length !== 1) {
    throw new InspectionRefusal('invalid_file');
  }
  const [rootName, rootValue] = roots[0]!;
  const root = resolveRelationshipElement(rootName, rootValue, 'Relationships', new Map());
  const entries: z.infer<typeof relationshipSchema>[] = [];
  for (const [name, value] of Object.entries(root.content)) {
    const children = Array.isArray(value) ? value : [value];
    for (const child of children) {
      const resolved = resolveRelationshipElement(name, child, 'Relationship', root.namespaces);
      entries.push(relationshipSchema.parse(resolved.content));
    }
  }
  return entries;
}

function inspectRelationships(metadata: unknown) {
  const entries = readRelationships(metadata);
  for (const entry of entries) {
    if (entry['@_TargetMode'] !== 'External') continue;
    const type = entry['@_Type'];
    const transitional = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/';
    const strict = 'http://purl.oclc.org/ooxml/officeDocument/relationships/';
    if ((type !== `${transitional}hyperlink` && type !== `${strict}hyperlink`) ||
        !/^(?:https?:\/\/|mailto:)/iu.test(entry['@_Target'])) {
      throw new InspectionRefusal('external_link');
    }
  }
}

function inspectWorkbook(bytes: Buffer) {
  for (let offset = 0; offset + 4 <= bytes.length;) {
    const record = bytes.readUInt16LE(offset);
    const length = bytes.readUInt16LE(offset + 2);
    if (offset + 4 + length > bytes.length) {
      throw new InspectionRefusal('invalid_file', 'Invalid Office document');
    }
    if (record === 0x002f) {
      throw new InspectionRefusal('encrypted');
    }
    if (record === 0x0085 && length >= 6 && ![0, 2].includes(bytes[offset+9]!)) {
      throw new InspectionRefusal('macros');
    }
    offset += 4 + length;
  }
}

parentPort!.postMessage('ready');
const input = z.object({ name: z.string(), bytes: z.instanceof(Uint8Array) }).parse(workerData as unknown);
const budget: OfficeBudget = { bytes: 0, parts: 0 };
void inspectFile(input.name, Buffer.from(input.bytes), budget, 0).then(
  mime => parentPort!.postMessage(mime),
  reportRefusal,
);

function reportRefusal(error: unknown) {
  if (error instanceof InspectionRefusal) {
    parentPort!.postMessage(error);
    return;
  }
  const refusal = new InspectionRefusal(inspectionReason(error));
  parentPort!.postMessage(refusal);
}
