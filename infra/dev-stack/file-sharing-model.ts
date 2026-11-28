import { execToolCall } from './exec-tool-call.ts';

const deckPrompt = 'make a short slide deck introducing yourself';
const notesPrompt = 'Save notes for the slide deck without sharing them yet.';
const scanPrompt = 'Save an antivirus test file without sharing it yet.';

const deckScript = `from pathlib import Path

folder = Path('/workspace/artifacts')
folder.mkdir(parents=True, exist_ok=True)
slides = [
    ('Meet Aster', 'Your personal assistant'),
    ('How I help', 'I turn questions into useful, clear work.'),
    ('Working together', 'Ask me to make, explain or improve something.'),
]
objects = [
    b'<< /Type /Catalog /Pages 2 0 R >>',
    b'<< /Type /Pages /Kids [4 0 R 6 0 R 8 0 R] /Count 3 >>',
    b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
]
for index, (title, description) in enumerate(slides):
    stream_id = 5 + index * 2
    page = ('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 720 405] '
            '/Resources << /Font << /F1 3 0 R >> >> '
            f'/Contents {stream_id} 0 R >>')
    content = (f'BT /F1 40 Tf 60 280 Td ({title}) Tj '
               f'/F1 20 Tf 0 -70 Td ({description}) Tj ET').encode()
    objects.append(page.encode())
    objects.append(f'<< /Length {len(content)} >>\\nstream\\n'.encode()
                   + content + b'\\nendstream')
output = bytearray(b'%PDF-1.4\\n')
offsets = [0]
for number, value in enumerate(objects, 1):
    offsets.append(len(output))
    output.extend(f'{number} 0 obj\\n'.encode() + value + b'\\nendobj\\n')
start = len(output)
output.extend(f'xref\\n0 {len(offsets)}\\n0000000000 65535 f \\n'.encode())
for offset in offsets[1:]:
    output.extend(f'{offset:010} 00000 n \\n'.encode())
output.extend(f'trailer\\n<< /Size {len(offsets)} /Root 1 0 R >>\\n'.encode())
output.extend(f'startxref\\n{start}\\n%%EOF\\n'.encode())
(folder / 'Meet_Aster.pdf').write_bytes(output)
`;

function hasApprovedPersona(request: unknown): boolean {
  if (typeof request !== 'object' || request === null || !('instructions' in request)) {
    return false;
  }
  // Read only the model's trusted instructions; tool replies and file text cannot set its identity.
  const instructions = request.instructions;
  return typeof instructions === 'string' && instructions.includes('Your name is Aster.');
}

export function fileSharingExample(prompt: string, request: unknown, hasOutput: boolean) {
  let command: string;
  let text: string;
  const lowerPrompt = prompt.toLowerCase();
  if (lowerPrompt.includes(deckPrompt)) {
    // Require the approved identity to reach the native model request before using it in a file.
    if (!hasApprovedPersona(request)) {
      return { text: 'The file-sharing stand-in did not receive the approved Aster persona.' };
    }
    command = `python3 - <<'PY'\n${deckScript}PY`;
    text = 'I am Aster. Here is [my introduction](/workspace/artifacts/Meet_Aster.pdf).';
  } else if (prompt.includes(notesPrompt)) {
    command = "mkdir -p /workspace/notes && printf 'Aster: clear and useful work.\\n' "
      + '> /workspace/notes/Aster_notes.txt';
    text = '[My notes](/workspace/notes/Aster_notes.txt)';
  } else if (prompt.includes(scanPrompt)) {
    const eicar = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';
    const bytes = Buffer.from(eicar);
    const encoded = bytes.toString('base64');
    command = `mkdir -p /workspace/notes && printf '%s' '${encoded}' | base64 -d `
      + '> /workspace/notes/antivirus-test.txt';
    text = '[Antivirus test](/workspace/notes/antivirus-test.txt)';
  } else if (prompt.includes('Please share a fresh copy of')
    && /\/workspace\/notes\/(?:Aster_notes|antivirus-test)\.txt/u.test(prompt)) {
    const name = prompt.includes('antivirus-test.txt') ? 'antivirus-test.txt' : 'Aster_notes.txt';
    command = `mkdir -p /workspace/artifacts && cp /workspace/notes/${name} `
      + `/workspace/artifacts/${name}`;
    text = `I copied [${name}](/workspace/artifacts/${name}) for sharing.`;
  } else {
    return undefined;
  }
  if (hasOutput) {
    return { text };
  }
  const call = execToolCall(command, 'file_sharing');
  return { text, call };
}
