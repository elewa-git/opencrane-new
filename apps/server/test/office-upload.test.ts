import * as cfb from 'cfb';
import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { inspectFile } from '../src/files/types.ts';

const relationshipNamespace = 'http://schemas.openxmlformats.org/package/2006/relationships';
const officeNamespace = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const contentNamespace = 'http://schemas.openxmlformats.org/package/2006/content-types';
const spreadsheetNamespace = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const presentationNamespace = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const drawingNamespace = 'http://schemas.openxmlformats.org/drawingml/2006';
const workbookMime = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const deckMime = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
const documentMime = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
type Parts = Record<string, string | Buffer>;

function relationship(type: string, target: string, mode = '') {
  return `<Relationship Id="rId1" Type="${officeNamespace}/${type}" ` +
    `Target="${target}"${mode ? ` TargetMode="${mode}"` : ''}/>`;
}

function relationships(...entries: string[]) {
  return `<Relationships xmlns="${relationshipNamespace}">${entries.join('')}</Relationships>`;
}

function archive(parts: Parts) {
  const container = cfb.utils.cfb_new();
  // Build the directory once so limit fixtures do not repeatedly sort thousands of parts.
  const addOptions = { unsafe: true };
  for (const [name, content] of Object.entries(parts)) {
    cfb.utils.cfb_add(container, name, Buffer.from(content), addOptions);
  }
  cfb.utils.cfb_gc(container);
  const options = { type: 'buffer', fileType: 'zip', compression: true } as const;
  return z.instanceof(Buffer).parse(cfb.write(container, options));
}

function documentParts(kind: 'ppt' | 'xl' | 'word'): Parts {
  let main = 'word/document.xml';
  let mime = documentMime;
  let content = '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/' +
    '2006/main"><w:body><w:p><w:r><w:t>Sample</w:t></w:r></w:p></w:body></w:document>';
  if (kind === 'ppt') {
    main = 'ppt/presentation.xml';
    mime = deckMime;
    content = `<p:presentation xmlns:p="${presentationNamespace}" ` +
      `xmlns:r="${officeNamespace}"><p:sldIdLst><p:sldId id="256" ` +
      'r:id="rId1"/></p:sldIdLst></p:presentation>';
  } else if (kind === 'xl') {
    main = 'xl/workbook.xml';
    mime = workbookMime;
    content = `<workbook xmlns="${spreadsheetNamespace}" xmlns:r="${officeNamespace}">` +
      '<sheets><sheet name="Sample" sheetId="1" r:id="rId1"/></sheets></workbook>';
  }
  const parts: Parts = {
    '[Content_Types].xml': `<Types xmlns="${contentNamespace}">` +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      `<Default Extension="xml" ContentType="application/xml"/>` +
      `<Default Extension="xlsx" ContentType="${workbookMime}"/>` +
      '<Default Extension="bin" ContentType="application/vnd.openxmlformats-officedocument.' +
      'presentationml.printerSettings"/>' +
      `<Override PartName="/${main}" ContentType="${mime}.main+xml"/></Types>`,
    '_rels/.rels': relationships(relationship('officeDocument', main)),
    [main]: content,
  };
  if (kind === 'ppt') {
    parts['ppt/_rels/presentation.xml.rels'] = relationships(relationship('slide', 'slides/slide1.xml'));
    parts['ppt/slides/slide1.xml'] = `<p:sld xmlns:p="${presentationNamespace}" ` +
      `xmlns:c="${drawingNamespace}/chart" xmlns:r="${officeNamespace}">` +
      '<p:cSld><p:spTree><p:graphicFrame><c:chart r:id="rId1"/>' +
      '</p:graphicFrame></p:spTree></p:cSld></p:sld>';
  } else if (kind === 'xl') {
    parts['xl/_rels/workbook.xml.rels'] = relationships(relationship('worksheet', 'worksheets/sheet1.xml'));
    parts['xl/worksheets/sheet1.xml'] = `<worksheet xmlns="${spreadsheetNamespace}">` +
      '<sheetData><row r="1"><c r="A1"><v>42</v></c></row></sheetData></worksheet>';
  }
  return parts;
}

function addChart(parts: Parts, kind: 'ppt' | 'xl' | 'word', workbook: Buffer) {
  parts[`${kind}/embeddings/chart.xlsx`] = workbook;
  parts[`${kind}/charts/chart1.xml`] = `<c:chartSpace xmlns:c="${drawingNamespace}/chart" ` +
    `xmlns:r="${officeNamespace}"><c:chart><c:plotArea><c:barChart/></c:plotArea>` +
    '</c:chart><c:externalData r:id="rId1"/></c:chartSpace>';
  parts[`${kind}/charts/_rels/chart1.xml.rels`] =
    relationships(relationship('package', '../embeddings/chart.xlsx'));
  if (kind === 'ppt') {
    parts['ppt/slides/_rels/slide1.xml.rels'] =
      relationships(relationship('chart', '../charts/chart1.xml'));
  } else if (kind === 'xl') {
    parts['xl/worksheets/_rels/sheet1.xml.rels'] =
      relationships(relationship('drawing', '../drawings/drawing1.xml'));
    parts['xl/drawings/drawing1.xml'] = `<xdr:wsDr xmlns:xdr="${drawingNamespace}/spreadsheetDrawing" ` +
      `xmlns:c="${drawingNamespace}/chart" xmlns:r="${officeNamespace}">` +
      '<xdr:twoCellAnchor><xdr:graphicFrame><c:chart r:id="rId1"/>' +
      '</xdr:graphicFrame></xdr:twoCellAnchor></xdr:wsDr>';
    parts['xl/drawings/_rels/drawing1.xml.rels'] =
      relationships(relationship('chart', '../charts/chart1.xml'));
  }
}

async function acceptsDeckChart() {
  const parts = documentParts('ppt');
  addChart(parts, 'ppt', archive(documentParts('xl')));
  await expect(inspectFile('sample.pptx', archive(parts))).resolves.toBe(deckMime);
}
it('accepts a deck with an embedded chart workbook', acceptsDeckChart);

async function acceptsDocumentHyperlink() {
  const parts = documentParts('word');
  parts['word/_rels/document.xml.rels'] =
    relationships(relationship('hyperlink', 'https://example.org/sample', 'External'));
  parts['word/document.xml'] = '<w:document xmlns:w="http://schemas.openxmlformats.org/' +
    `wordprocessingml/2006/main" xmlns:r="${officeNamespace}"><w:body><w:p>` +
    '<w:hyperlink r:id="rId1"><w:r><w:t>Sample link</w:t></w:r></w:hyperlink>' +
    '</w:p></w:body></w:document>';
  await expect(inspectFile('sample.docx', archive(parts))).resolves.toBe(documentMime);
}
it('accepts a document with an external hyperlink', acceptsDocumentHyperlink);

async function acceptsPrinterSettings() {
  const parts = documentParts('ppt');
  parts['ppt/printerSettings/printerSettings1.bin'] = Buffer.alloc(220);
  parts['ppt/_rels/presentation.xml.rels'] = relationships(
    relationship('slide', 'slides/slide1.xml'),
    relationship('printerSettings', 'printerSettings/printerSettings1.bin').replace('rId1', 'rId2'),
  );
  await expect(inspectFile('sample.pptx', archive(parts))).resolves.toBe(deckMime);
}
it('accepts a deck with printer settings', acceptsPrinterSettings);

async function acceptsWorkbookChart() {
  const parts = documentParts('xl');
  addChart(parts, 'xl', archive(documentParts('xl')));
  await expect(inspectFile('sample.xlsx', archive(parts))).resolves.toBe(workbookMime);
}
it('accepts a workbook with an embedded chart workbook', acceptsWorkbookChart);

async function acceptsWordChart() {
  const parts = documentParts('word');
  addChart(parts, 'word', archive(documentParts('xl')));
  await expect(inspectFile('sample.docx', archive(parts))).resolves.toBe(documentMime);
}
it('accepts a Word chart workbook', acceptsWordChart);

async function refusesPart(name: string) {
  const parts = documentParts('ppt');
  parts[name] = archive(documentParts('xl'));
  await expect(inspectFile('sample.pptx', archive(parts))).rejects.toThrow('Unsafe Office document');
}
it.each([
  'ppt/embeddings/chart.xlsm', 'ppt/embeddings/chart.docm', 'ppt/embeddings/chart.pptm',
  'ppt/embeddings/oleObject1.bin', 'ppt/embeddings/package.zip', 'ppt/embeddings/image.png',
  'ppt/embeddings/nested/chart.xlsx', 'other/embeddings/chart.xlsx', 'ppt/other.bin',
  'ppt/printerSettings/other.bin', 'ppt/vbaProject.bin', 'ppt/activeX/control.xml',
])('refuses unsafe Office part %s', refusesPart);

async function refusesEmbeddedMacro() {
  const workbook = documentParts('xl');
  workbook['xl/vbaProject.bin'] = Buffer.from('synthetic macro marker');
  const parts = documentParts('ppt');
  addChart(parts, 'ppt', archive(workbook));
  await expect(inspectFile('sample.pptx', archive(parts))).rejects.toThrow('Unsafe Office document');
}
it('refuses a macro inside an embedded workbook', refusesEmbeddedMacro);

async function refusesNestedWorkbook() {
  const workbook = documentParts('xl');
  addChart(workbook, 'xl', archive(documentParts('xl')));
  const parts = documentParts('ppt');
  addChart(parts, 'ppt', archive(workbook));
  await expect(inspectFile('sample.pptx', archive(parts))).rejects.toThrow('Unsafe Office document');
}
it('refuses an embedded workbook with another embedded workbook', refusesNestedWorkbook);

function addParts(parts: Parts, count: number) {
  for (let index = 0; index < count; index++) {
    parts[`media/sample${index}.dat`] = 'sample';
  }
}

async function refusesCombinedParts() {
  const workbook = documentParts('xl');
  addParts(workbook, 1000);
  const parts = documentParts('ppt');
  addChart(parts, 'ppt', archive(workbook));
  parts['ppt/embeddings/second.xlsx'] = archive(workbook);
  await expect(inspectFile('sample.pptx', archive(parts))).rejects.toThrow('Unsafe Office document');
}
it('counts all embedded workbooks towards the 2,000 part limit', refusesCombinedParts);

async function refusesLargeWorkbook() {
  const workbook = documentParts('xl');
  workbook['xl/media/padding.dat'] = Buffer.alloc(81 * 1024 * 1024);
  const parts = documentParts('ppt');
  addChart(parts, 'ppt', archive(workbook));
  await expect(inspectFile('sample.pptx', archive(parts))).rejects.toThrow('Unsafe Office document');
}
it('refuses an embedded workbook over the 80 MiB unpacked limit', refusesLargeWorkbook);

async function refusesCombinedSize() {
  const workbook = documentParts('xl');
  workbook['xl/media/padding.dat'] = Buffer.alloc(41 * 1024 * 1024);
  const parts = documentParts('ppt');
  addChart(parts, 'ppt', archive(workbook));
  parts['ppt/media/padding.dat'] = Buffer.alloc(40 * 1024 * 1024);
  await expect(inspectFile('sample.pptx', archive(parts))).rejects.toThrow('Unsafe Office document');
}
it('counts parent and workbook bytes towards the same limit', refusesCombinedSize);

async function refusesExternalRelationship(type: string) {
  const parts = documentParts('word');
  const external = relationship(type, 'https://example.org/sample', 'Ext&#101;rnal');
  const hyperlink = relationship('hyperlink', 'https://example.org/link', 'External');
  parts['word/_rels/document.xml.rels'] = relationships(hyperlink, external.replace('rId1', 'rId2'));
  await expect(inspectFile('sample.docx', archive(parts))).rejects.toThrow('Unsafe Office document');
}
it.each(['image', 'attachedTemplate', 'oleObject', 'connection', 'frame', 'package'])(
  'refuses an external %s relationship even alongside a hyperlink', refusesExternalRelationship,
);

async function refusesHyperlinkTarget(target: string) {
  const parts = documentParts('word');
  parts['word/_rels/document.xml.rels'] = relationships(relationship('hyperlink', target, 'External'));
  await expect(inspectFile('sample.docx', archive(parts))).rejects.toThrow('Unsafe Office document');
}
it.each(['file:///sample', 'javascript:alert(1)', 'data:text/plain,sample', '//example.org/sample'])(
  'refuses unsafe hyperlink target %s', refusesHyperlinkTarget,
);

async function acceptsHyperlinkTarget(target: string) {
  const parts = documentParts('word');
  parts['word/_rels/document.xml.rels'] =
    relationships(relationship('hyperlink', target, 'Ext&#101;rnal'));
  await expect(inspectFile('sample.docx', archive(parts))).resolves.toBe(documentMime);
}
it.each(['http://example.org/sample', 'https://example.org/sample', 'mailto:sample@example.org'])(
  'accepts a decoded external hyperlink to %s', acceptsHyperlinkTarget,
);

async function refusesUnsafeXml(content: string) {
  const parts = documentParts('xl');
  parts['[Content_Types].xml'] = content;
  await expect(inspectFile('sample.xlsx', archive(parts))).rejects.toThrow('Unsafe Office document');
}
it.each([
  '<!DOCTYPE Types><Types/>', '<!ENTITY sample "sample"><Types/>',
  '<Types><Override ContentType="application/vnd.ms-excel.macro&#69;nabled.main+xml"/></Types>',
])('refuses unsafe XML %s', refusesUnsafeXml);

async function refusesInvalidEmbeddedWorkbook() {
  const parts = documentParts('ppt');
  addChart(parts, 'ppt', archive(documentParts('word')));
  await expect(inspectFile('sample.pptx', archive(parts))).rejects.toThrow('Unsafe Office document');
}
it('refuses another document disguised as an embedded workbook', refusesInvalidEmbeddedWorkbook);

async function refusesDisguisedWorkbookWithDecoy() {
  const hybrid = documentParts('word');
  hybrid['xl/workbook.xml'] = `<workbook xmlns="${spreadsheetNamespace}"/>`;
  const bytes = archive(hybrid);
  await expect(inspectFile('hybrid.xlsx', bytes)).rejects.toThrow('Unsupported file type');

  const parts = documentParts('ppt');
  addChart(parts, 'ppt', bytes);
  await expect(inspectFile('sample.pptx', archive(parts))).rejects.toThrow('Unsafe Office document');
}
it('refuses a Word package with a decoy workbook both directly and embedded',
  refusesDisguisedWorkbookWithDecoy);

function spellRelationships(xml: string, prefix: string) {
  const tags = xml.replace(/(<\/?)(Relationships?)(?=[\s>])/gu, `$1${prefix}$2`);
  if (!prefix) return tags;
  return tags.replace('xmlns=', `xmlns:${prefix.slice(0, -1)}=`);
}

function checksRelationshipSpelling(prefix: string) {
  function workbookWithRelationship(type: string, target: string, mode = '') {
    const parts = documentParts('xl');
    const xml = relationships(relationship(type, target, mode));
    parts['xl/_rels/workbook.xml.rels'] = spellRelationships(xml, prefix);
    return archive(parts);
  }

  async function acceptsInternalWorksheet() {
    const bytes = workbookWithRelationship('worksheet', 'worksheets/sheet1.xml');
    await expect(inspectFile('sample.xlsx', bytes)).resolves.toBe(workbookMime);
  }
  it('accepts an internal worksheet relationship', acceptsInternalWorksheet);

  async function acceptsSafeHyperlink(target: string) {
    const bytes = workbookWithRelationship('hyperlink', target, 'Ext&#101;rnal');
    await expect(inspectFile('sample.xlsx', bytes)).resolves.toBe(workbookMime);
  }
  it.each(['http://example.org/sample', 'https://example.org/sample', 'mailto:a@example.org'])(
    'accepts an external hyperlink to %s', acceptsSafeHyperlink,
  );

  async function refusesExternalContent(type: string) {
    const bytes = workbookWithRelationship(type, 'https://example.org/sample', 'Ext&#101;rnal');
    await expect(inspectFile('sample.xlsx', bytes)).rejects.toThrow('Unsafe Office document');
  }
  it.each(['image', 'attachedTemplate', 'oleObject', 'connection', 'frame', 'package'])(
    'refuses an external %s relationship', refusesExternalContent,
  );

  async function refusesUnsafeTarget(target: string) {
    const bytes = workbookWithRelationship('hyperlink', target, 'External');
    await expect(inspectFile('sample.xlsx', bytes)).rejects.toThrow('Unsafe Office document');
  }
  it.each(['file:///sample', 'javascript:alert(1)', 'data:text/plain,sample', '//example.org/sample'])(
    'refuses an external hyperlink to %s', refusesUnsafeTarget,
  );
}
describe.each(['', 'r:'])('relationship prefix "%s"', checksRelationshipSpelling);

async function acceptsLocalRelationshipNamespace() {
  const parts = documentParts('xl');
  const entry = relationship('worksheet', 'worksheets/sheet1.xml');
  const prefixed = entry.replace('<Relationship ',
    `<r:Relationship xmlns:r="${relationshipNamespace}" `);
  parts['xl/_rels/workbook.xml.rels'] = relationships(prefixed);
  await expect(inspectFile('sample.xlsx', archive(parts))).resolves.toBe(workbookMime);
}
it('accepts a relationship with its namespace declared on the child',
  acceptsLocalRelationshipNamespace);

async function refusesUnknownRelationshipNamespace(declaration: string) {
  const parts = documentParts('xl');
  const entry = relationship('worksheet', 'worksheets/sheet1.xml');
  const prefixed = entry.replace('<Relationship ', `<r:Relationship ${declaration} `);
  parts['xl/_rels/workbook.xml.rels'] = relationships(prefixed);
  await expect(inspectFile('sample.xlsx', archive(parts))).rejects.toThrow('Unsafe Office document');
}
it.each(['', 'xmlns:r="https://example.org/other"'])(
  'refuses an unbound or wrong relationship namespace: %s', refusesUnknownRelationshipNamespace,
);

async function refusesEmptyNamespacePrefix(element: string) {
  const parts = documentParts('xl');
  const xml = relationships(relationship('worksheet', 'worksheets/sheet1.xml'));
  const tags = new RegExp(`(<\\/?)(${element})(?=[\\s>])`, 'gu');
  parts['xl/_rels/workbook.xml.rels'] = xml.replace(tags, '$1:$2');
  await expect(inspectFile('sample.xlsx', archive(parts))).rejects.toThrow('Unsafe Office document');
}
it.each(['Relationships', 'Relationship'])(
  'refuses an empty namespace prefix on %s', refusesEmptyNamespacePrefix,
);

async function refusesEmbeddedPartCount() {
  const workbook = documentParts('xl');
  addParts(workbook, 2001);
  const parts = documentParts('ppt');
  addChart(parts, 'ppt', archive(workbook));
  await expect(inspectFile('sample.pptx', archive(parts))).rejects.toThrow('Unsafe Office document');
}
it('refuses an embedded workbook over the part limit', refusesEmbeddedPartCount);

async function refusesEncryptedEntry() {
  const bytes = archive(documentParts('ppt'));
  for (let offset = 0; offset < bytes.length - 10; offset++) {
    const signature = bytes.readUInt32LE(offset);
    if (signature === 0x04034b50) bytes.writeUInt16LE(1, offset + 6);
    if (signature === 0x02014b50) bytes.writeUInt16LE(1, offset + 8);
  }
  await expect(inspectFile('sample.pptx', bytes)).rejects.toThrow('Unsafe Office document');
}
it('still refuses encrypted ZIP entries', refusesEncryptedEntry);

async function refusesTraversal() {
  const parts = documentParts('ppt');
  parts['ppt/xx/part.xml'] = '<sample/>';
  const bytes = archive(parts);
  const original = Buffer.from('ppt/xx/part.xml');
  const replacement = Buffer.from('ppt/../part.xml');
  let offset = bytes.indexOf(original);
  while (offset !== -1) {
    replacement.copy(bytes, offset);
    offset = bytes.indexOf(original, offset + original.length);
  }
  await expect(inspectFile('sample.pptx', bytes)).rejects.toThrow('Unsafe Office document');
}
it('still refuses ZIP path traversal', refusesTraversal);
