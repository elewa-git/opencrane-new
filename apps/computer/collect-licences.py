"""Collect signed apt index matches at build time and installed licence evidence."""
import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path


def paragraphs(text):
    for block in text.strip().split('\n\n'):
        yield dict(line.split(': ', 1) for line in block.splitlines() if ': ' in line and not line.startswith(' '))


def run(*args):
    return subprocess.check_output(args, text=True)


def apt_packages():
    installed = {tuple(line.split('\t')): [] for line in run(
        'dpkg-query', '-W', '-f=${Package}\t${Version}\t${Architecture}\n').splitlines()}
    for index in paragraphs(run('apt-get', 'indextargets')):
        if index.get('Identifier') != 'Packages':
            continue
        if index.get('Trusted') != 'yes' or index.get('Origin') != 'Debian':
            raise ValueError('Untrusted or non-Debian apt index')
        if not re.fullmatch(r'http://snapshot.debian.org/archive/debian(?:-security)?/2026100[12]T000000Z/', index['Repo-URI']):
            raise ValueError('Unpinned apt index')
        contents = run('/usr/lib/apt/apt-helper', 'cat-file', index['Filename'])
        for package in paragraphs(contents):
            key = tuple(package.get(field) for field in ['Package', 'Version', 'Architecture'])
            if key in installed:
                installed[key].append({
                    'component': index['Component'], 'index': index['URI'],
                    'indexSha256': hashlib.sha256(contents.encode()).hexdigest(),
                    'filename': package['Filename'], 'sha256': package['SHA256'],
                    'origin': index['Origin'], 'trusted': True,
                })
    return [dict(zip(['name', 'version', 'architecture'], key), archives=value)
            for key, value in sorted(installed.items())]


def notices():
    paths = set(Path('/usr/share/doc').glob('*/copyright'))
    for root in ['/opt/python/lib/python3.11/site-packages', '/spike/node_modules/@openai', '/app/node_modules']:
        for path in Path(root).rglob('*'):
            if path.is_file() and (any(word in path.name.lower() for word in ['license', 'licence', 'copying'])
                                   or 'licenses' in path.parts or path.name in ['METADATA', 'package.json']):
                paths.add(path)
    paths.update([Path('/usr/local/LICENSE'), Path('/app/LICENSE')])
    return {str(path): path.read_text(errors='replace') for path in sorted(paths) if path.is_file()}


if __name__ == '__main__':
    if sys.argv[1] == 'apt':
        print(json.dumps(apt_packages(), indent=2))
    else:
        print(json.dumps({'apt': json.loads(Path('/usr/share/opencrane/apt-packages.json').read_text()),
                          'notices': notices(),
                          'artifacts': [{'name': 'opencrane-computer', 'version': 'p2-1', 'type': 'application',
                                         'licenses': [{'value': re.search(r'SPDX-License-Identifier: (\S+)', Path('/app/LICENSE').read_text())[1],
                                                       'locations': [{'path': '/app/LICENSE'}]}]}]}))
