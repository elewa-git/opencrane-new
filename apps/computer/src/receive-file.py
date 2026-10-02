"""Write a bridge upload and convert PDFs inside the tools user's existing sandbox."""
import hashlib
import io
import json
import os
import re
import sys
import uuid
from markitdown import MarkItDown

os.umask(0o077)
meta = json.loads(sys.argv[1])
for key in ('conversationId', 'fileId'):
    assert re.fullmatch(r'[\w-]{1,200}', meta[key], flags=re.ASCII)
assert re.fullmatch(r'[\w][\w .()-]{0,119}', meta['name'], flags=re.ASCII)
assert isinstance(meta['size'], int) and 0 < meta['size'] <= 20 * 1024 * 1024
content = sys.stdin.buffer.read(meta['size'])
assert len(content) == meta['size'] and hashlib.sha256(content).hexdigest() == meta['sha256']

# Hold each directory open; user-created symlinks must never redirect an upload.
fd = os.open('/workspace', os.O_RDONLY | os.O_DIRECTORY)
for part in ('uploads', meta['conversationId'], meta['fileId']):
    try:
        os.mkdir(part, 0o700, dir_fd=fd)
    except FileExistsError:
        pass
    child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
    os.close(fd)
    fd = child


def save(name, value):
    try:
        existing = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
        with os.fdopen(existing, 'rb') as current:
            if current.read(len(value) + 1) == value:
                return
    except FileNotFoundError:
        pass
    temporary = '.' + uuid.uuid4().hex
    target = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=fd)
    with os.fdopen(target, 'wb') as out:
        out.write(value)
        out.flush()
        os.fsync(out.fileno())
    os.replace(temporary, name, src_dir_fd=fd, dst_dir_fd=fd)
    os.fsync(fd)


if meta['name'].lower().endswith('.pdf'):
    # Convert before publishing the original; failed conversions never acknowledge delivery.
    text = MarkItDown().convert_stream(io.BytesIO(content), file_extension='.pdf').text_content
    save(meta['name'] + '.md', text.encode())
save(meta['name'], content)
os.close(fd)
