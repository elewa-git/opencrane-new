"""Run inside the actual image, with collected evidence on stdin."""
import json
import re
import sys
from email.parser import Parser
from pathlib import Path

notices = json.load(sys.stdin)['notices']
expected = set()
for root in ['/opt', '/app', '/spike', '/usr/local', '/usr/share/kasmvnc']:
    for path in Path(root).rglob('*'):
        if not path.is_file():
            continue
        if re.search(r'licen[cs]e|copying|notice', path.name, re.I):
            expected.add(str(path))
        if path.name == 'METADATA':
            for name in Parser().parsestr(path.read_text()).get_all('License-File', []):
                candidates = [path.parent / name, path.parent / 'licenses' / name]
                installed = [str(p) for p in candidates if p.is_file()]
                assert installed, (path, name)
                expected.update(installed)
assert not expected - notices.keys(), sorted(expected - notices.keys())
for path in expected:
    assert Path(path).read_text(errors='replace') == notices[path], path
print(f'PASS: all {len(expected)} installed notice filenames and metadata-named licence files collected')
