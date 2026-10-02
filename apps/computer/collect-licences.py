"""Collect signed apt index matches at build time and installed licence evidence."""
import csv
from email.parser import Parser
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


def notice_file(path):
    return (any(word in path.name.lower() for word in ['license', 'licence', 'copying', 'notice'])
            or (path.suffix not in {'.py', '.pyc', '.so'}
                and any(part.lower() in {'licenses', 'licences', 'notices'} for part in path.parts)))


def notices():
    paths = set(Path('/usr/share/doc').glob('*/copyright'))
    owners = {}
    for root in ['/opt', '/app', '/spike', '/usr/local', '/usr/share/kasmvnc']:
        paths.update(p for p in Path(root).rglob('*') if p.is_file() and notice_file(p))
    for root in ['/opt/python/lib/python3.11/site-packages', '/spike/node_modules',
                 '/app/node_modules', '/usr/local/lib/node_modules']:
        files = [p for p in Path(root).rglob('*') if p.is_file()]
        paths.update(p for p in files if notice_file(p))
        for metadata in [p for p in files if p.name in {'METADATA', 'package.json'}]:
            paths.add(metadata)
            owned = {metadata}
            if metadata.name == 'METADATA':
                record = metadata.with_name('RECORD')
                if not record.is_file():
                    raise ValueError('Missing installed file inventory: ' + str(record))
                owned.update((metadata.parent.parent / row[0]).resolve()
                             for row in csv.reader(record.read_text().splitlines())
                             if notice_file(Path(row[0])))
                for name in Parser().parsestr(metadata.read_text()).get_all('License-File', []):
                    candidates = [metadata.parent / name, metadata.parent / 'licenses' / name]
                    found = [p for p in candidates if p.is_file()]
                    if not found:
                        raise ValueError('Missing metadata-named notice: ' + name)
                    owned.update(found)
            else:
                owned.update(p for p in files if p.is_relative_to(metadata.parent) and notice_file(p))
                data = json.loads(metadata.read_text())
                for field in ['license', 'licence', 'licenses', 'licenseFile', 'licenseFiles']:
                    value = data.get(field, [])
                    values = value if isinstance(value, list) else [value]
                    for value in values:
                        if isinstance(value, dict):
                            value = value.get('file', '')
                        if not isinstance(value, str):
                            continue
                        match = re.match(r'SEE LICEN[CS]E IN (.+)', value, re.I)
                        name = match[1] if match else value
                        candidate = metadata.parent / name
                        if candidate.is_file():
                            owned.add(candidate)
                        elif match or field in {'licenseFile', 'licenseFiles'}:
                            raise ValueError('Missing metadata-named notice: ' + str(candidate))
            if any(not p.is_file() for p in owned):
                raise ValueError('Missing installed notice: ' + str(metadata))
            paths.update(owned)
            owners[str(metadata)] = sorted(str(p) for p in owned)
    paths.update([Path('/usr/local/LICENSE'), Path('/app/LICENSE')])
    return ({str(path): path.read_text(errors='replace') for path in sorted(paths) if path.is_file()}, owners)


if __name__ == '__main__':
    if sys.argv[1] == 'apt':
        print(json.dumps(apt_packages(), indent=2))
    else:
        texts, owners = notices()
        print(json.dumps({'apt': json.loads(Path('/usr/share/opencrane/apt-packages.json').read_text()),
                          'notices': texts, 'owners': owners,
                          'artifacts': [{'name': 'opencrane-computer', 'version': 'p2-1', 'type': 'application',
                                         'licenses': [{'value': re.search(r'SPDX-License-Identifier: (\S+)', Path('/app/LICENSE').read_text())[1],
                                                       'locations': [{'path': '/app/LICENSE'}]}]}]}))
