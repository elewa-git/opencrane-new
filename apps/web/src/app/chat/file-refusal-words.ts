const fileRefusals = new Map([
  ['unsupported_type',
    'This file type is not supported. Try a supported document, image or text file.'],
  ['content_mismatch',
    'This file does not match its file type. Save it in the correct format and try again.'],
  ['macros',
    "This file contains macros, which we don't accept. Save it without macros and try again."],
  ['embedded_object',
    'This file contains an embedded object we cannot accept. Remove it and try again.'],
  ['external_link',
    'This file has a link that loads outside content. Remove that link and try again.'],
  ['encrypted',
    'This file is encrypted or password protected. Save an unencrypted copy and try again.'],
  ['too_large',
    'This file exceeds the document inspection limits. Try a smaller or simpler file.'],
  ['too_many_parts',
    'This file contains too many document parts. Try a simpler file.'],
  ['invalid_file',
    'This file could not be read safely. Save a fresh copy and try again.'],
  ['unsafe_name',
    'This file has an unsafe name or document part name. Rename it or save a fresh copy.'],
]);
export function fileRefusalWords(reason: string, fallback = 'This file could not be published.') {
  if (reason === 'infected') return 'File refused: malware detected.';
  return fileRefusals.get(reason) ?? fallback;
}
