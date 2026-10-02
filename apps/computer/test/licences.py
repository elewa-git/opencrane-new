"""Small policy checks; the shell test also exercises the real Syft scanner."""
import copy
import importlib.util
import json
import sys
from pathlib import Path

sys.dont_write_bytecode = True
root = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('licences', root / 'check-licences.py')
checker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(checker)
reviewed = json.loads((root / 'reviewed-licences.json').read_text())
osi = {item['licenseId'] for item in json.loads((root / '.state/osi.json').read_text())['licenses'] if item.get('isOsiApproved')}
package = {'name': 'probe', 'version': '1', 'type': 'deb', 'metadata': {'architecture': 'all'},
           'licenses': [{'value': 'public-domain'}]}
origin = {'component': 'main', 'filename': 'pool/main/p/probe/probe_1_all.deb',
          'origin': 'Debian', 'trusted': True}
evidence = {'apt': [{'name': 'probe', 'version': '1', 'architecture': 'all', 'archives': [origin]}]}


def result(p=package, e=evidence):
    return checker.check({'artifacts': [p]}, osi, e, reviewed)[0]['result']


assert result() == 'PASS', 'public-domain Debian main package'
for component in ['contrib', 'non-free', 'non-free-firmware']:
    changed = copy.deepcopy(evidence)
    changed['apt'][0]['archives'][0]['component'] = component
    assert result(e=changed) == 'FAIL', component
assert result(e={}) == 'FAIL', 'package name alone is not archive evidence'
changed = copy.deepcopy(evidence)
changed['apt'][0]['version'] = '2'
assert result(e=changed) == 'FAIL', 'archive version must match'
changed['apt'][0]['version'] = '1'
changed['apt'][0]['architecture'] = 'amd64'
assert result(e=changed) == 'FAIL', 'archive architecture must match'
for kind in ['npm', 'python', 'binary']:
    changed = dict(package, type=kind, licenses=[{'value': 'CC0-1.0'}])
    assert result(changed) == 'FAIL', f'CC0 application: {kind}'
for licence in ['BUSL-1.1', 'SSPL-1.0', 'Elastic-2.0', 'KLv1', 'Commons Clause',
                'MIT OR BUSL-1.1', 'sha256:' + '0' * 64, 'made-up-notice']:
    assert result(dict(package, licenses=[{'value': licence}])) == 'FAIL', licence
assert result(dict(package, licenses=[{'value': 'BSL-1.0'}])) == 'PASS', 'Boost is not BUSL'
# A new forbidden notice must not hide behind a recognised SPDX label.
changed = dict(package, licenses=[{'value': 'MIT', 'locations': [{'path': '/notice'}]}])
assert result(changed, dict(evidence, notices={'/notice': 'Commons Clause'})) == 'FAIL'
assert not checker.approved('MIT OR mystery', osi)
assert checker.approved('(MIT OR Apache-2.0) AND BSD-3-Clause', osi)
# Reviewed hashes cannot be reused after the installed text changes.
known_hash, mapping = next((key, value) for key, value in reviewed['texts'].items()
                          if value['category'] == 'debian-main' and key in value['labels'])
changed = dict(package, licenses=[{'value': known_hash, 'locations': [{'path': '/notice'}]}])
assert result(changed, dict(evidence, notices={'/notice': 'new, unreviewed text'})) == 'FAIL'
print('PASS: Debian components, public domain, app CC0, unknown text, version/architecture and source-available rejection')
