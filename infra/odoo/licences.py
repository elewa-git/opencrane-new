"""Compare actual shipped packages/notices with the operator-reviewed inventory."""
import ast
import gzip
import hashlib
import json
from pathlib import Path
import subprocess
import sys


def inventory():
    packages = json.loads(Path('/usr/share/opencrane/apt-packages.json').read_text())
    installed = subprocess.check_output(
        ['dpkg-query', '-W', '-f=${Package}\t${Version}\t${Architecture}\n'], text=True)
    expected = {(p['name'], p['version'], p['architecture']) for p in packages}
    if {tuple(line.split('\t')) for line in installed.splitlines()} != expected:
        raise SystemExit('FAIL installed package inventory changed')
    for package in packages:
        if not package['archives'] or not all(a['component'] == 'main' and a['trusted']
                                              for a in package['archives']):
            raise SystemExit('FAIL unreviewed archive: ' + package['name'])
        path = Path('/usr/share/doc') / package['name'] / 'copyright'
        assert path.is_file(), f'Missing notice: {path}'
        package['copyrightSha256'] = hashlib.sha256(path.read_bytes()).hexdigest()
        package['copyright'] = path.read_text()
    source = Path('/opt/odoo')
    notices = {}
    for path in source.rglob('*'):
        if path.is_file() and any(word in path.name.lower() for word in
                                  ['license', 'licence', 'copying', 'copyright', 'notice']):
            notices[str(path.relative_to(source))] = hashlib.sha256(path.read_bytes()).hexdigest()
    modules = {}
    for manifest in source.rglob('__manifest__.py'):
        data = ast.literal_eval(manifest.read_text())
        modules[str(manifest.relative_to(source))] = data.get('license', 'LGPL-3')
    return {'packages': packages, 'odooNotices': notices, 'moduleLicences': modules}


if __name__ == '__main__':
    actual = inventory()
    if sys.argv[1] == 'collect':
        print(json.dumps(actual, sort_keys=True))
    else:
        review = json.loads(gzip.decompress(Path('/fixture/runtime-licences.json.gz').read_bytes()))
        name = sys.argv[2]
        if actual != review[name]['inventory']:
            raise SystemExit('FAIL runtime inventory differs from licence review')
        print(f'PASS {name}: {len(actual["packages"])} Debian main packages; reviewed notices unchanged')
