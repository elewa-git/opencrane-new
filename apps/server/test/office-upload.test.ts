import * as cfb from 'cfb';
import { z } from 'zod';
import { expect, it } from 'vitest';
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
  for (const [name, content] of Object.entries(parts)) {
    cfb.utils.cfb_add(container, name, Buffer.from(content));
  }
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
