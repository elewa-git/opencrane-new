"""Record installed versions and licence declarations, retaining full notices."""
import importlib.metadata
import json
import pathlib
import re
import shutil
import subprocess

out = pathlib.Path('/opt/computer/licences')
(out / 'debian-copyright').mkdir(parents=True, exist_ok=True)
rows = []
for line in subprocess.check_output(['dpkg-query', '-W', '-f=${Package}\t${Version}\n'], text=True).splitlines():
    name, version = line.split('\t')
    source = pathlib.Path('/usr/share/doc') / name / 'copyright'
    if not source.exists():
        raise RuntimeError('Missing Debian copyright file: ' + name)
    text = source.read_text(errors='replace')
    declarations = sorted(set(re.findall(r'^License:\s*(.+)$', text, re.MULTILINE)))
    # Older Debian copyright files use prose; retain the full text as the licence record.
    licence = ' | '.join(declarations) or 'See debian-copyright/' + name
    shutil.copyfile(source, out / 'debian-copyright' / name)
    rows.append({'name': name, 'version': version, 'licence': licence})
(out / 'debian.json').write_text(json.dumps(rows, indent=2) + '\n')
rows = []
for dist in importlib.metadata.distributions():
    meta = dist.metadata
    licence = meta.get('License-Expression') or meta.get('License')
    classifiers = [x.removeprefix('License :: ') for x in meta.get_all('Classifier', []) if x.startswith('License :: ')]
    rows.append({'name': meta['Name'], 'version': dist.version, 'licence': licence, 'classifiers': classifiers})
(out / 'python.json').write_text(json.dumps(sorted(rows, key=lambda r: r['name'].lower()), indent=2) + '\n')
