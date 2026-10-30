import * as cfb from 'cfb';
import { z } from 'zod';

export function refusedFile(reason: string) {
  let name = 'sample.pptx';
  let bytes: Buffer;
  const parts: Record<string, string | Buffer> = {
    '[Content_Types].xml': '<Types/>',
    'ppt/presentation.xml': '<presentation/>',
  };
  switch (reason) {
    case 'unsupported_type':
      return { name: 'sample.xyz', bytes: Buffer.from('Sample') };
    case 'content_mismatch':
      return { name: 'sample.pdf', bytes: Buffer.from('Sample') };
    case 'unsafe_name':
      return { name: '../sample.txt', bytes: Buffer.from('Sample') };
    case 'macros':
      parts['ppt/vbaProject.bin'] = 'Sample';
      break;
    case 'embedded_object':
      parts['ppt/embeddings/object.bin'] = 'Sample';
      break;
    case 'external_link':
      parts['ppt/_rels/presentation.xml.rels'] = '<Relationships>' +
        '<Relationship Id="r1" Type="image" Target="https://example.test/sample" ' +
        'TargetMode="External"/></Relationships>';
      break;
    case 'too_large':
      parts['ppt/media/padding.dat'] = Buffer.alloc(81 * 1024 * 1024);
      break;
    case 'too_many_parts':
      for (let index = 0; index < 2001; index++) parts[`media/${index}.dat`] = 'Sample';
      break;
    case 'invalid_file':
      parts['ppt/presentation.xml'] = '<presentation>';
      break;
  }
  const container = cfb.utils.cfb_new();
  const addOptions = { unsafe: true };
  for (const [part, content] of Object.entries(parts)) {
    cfb.utils.cfb_add(container, part, Buffer.from(content), addOptions);
  }
  cfb.utils.cfb_gc(container);
  const options = { type: 'buffer', fileType: 'zip', compression: true } as const;
  bytes = z.instanceof(Buffer).parse(cfb.write(container, options));
  if (reason === 'encrypted') {
    name = 'sample.pptx';
    for (let offset = 0; offset < bytes.length - 10; offset++) {
      const signature = bytes.readUInt32LE(offset);
      if (signature === 0x04034b50) bytes.writeUInt16LE(1, offset + 6);
      if (signature === 0x02014b50) bytes.writeUInt16LE(1, offset + 8);
    }
  }
  return { name, bytes };
}

export const refusalReasons = [
  'unsupported_type', 'content_mismatch', 'macros', 'embedded_object', 'external_link',
  'encrypted', 'too_large', 'too_many_parts', 'invalid_file', 'unsafe_name',
];
