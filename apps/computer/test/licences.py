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

model_package = {'name': '@opencrane/models', 'version': '0.1.0', 'type': 'npm',
                 'licenses': [{'value': 'AGPL-3.0-or-later'}]}
model_evidence = {'notices': {'/app/libs/models/LICENSE': (root.parent.parent / 'LICENSE').read_text()}}
assert result(model_package, model_evidence) == 'PASS', 'bundled model routing has a reviewed repository licence'
model_evidence['notices']['/app/libs/models/LICENSE'] = 'changed licence'
assert result(model_package, model_evidence) == 'FAIL', 'changed routing licence requires review'

tool_package = {'name': '@opencrane/events', 'version': '0.1.0', 'type': 'npm',
                'licenses': [{'value': 'AGPL-3.0-or-later'}]}
tool_evidence = {'notices': {'/app/libs/events/LICENSE': (root.parent.parent / 'LICENSE').read_text()}}
assert result(tool_package, tool_evidence) == 'PASS', 'tool report check uses the repository licence'
tool_evidence['notices']['/app/libs/events/LICENSE'] = 'changed licence'
assert result(tool_package, tool_evidence) == 'FAIL', 'changed tool check licence requires review'

# Package metadata declares MIT; a separately identified bundled part uses CC0.
metadata = '/node_modules/probe/package.json'
licence_file = '/node_modules/probe/LICENSE'
part_file = '/node_modules/probe/vendor/part/LICENSE'
app = dict(package, type='npm', licenses=[{'value': 'MIT'}, {'value': 'CC0-1.0'}],
           locations=[{'path': metadata}])
app_evidence = {'notices': {metadata: '{"name":"probe","version":"1","license":"MIT"}',
                           licence_file: 'Probe: MIT', part_file: 'Bundled part: CC0-1.0'}}
app_review = copy.deepcopy(reviewed)
record = {'detected': ['MIT', 'CC0-1.0'],
          'files': {path: checker.digest(text) for path, text in app_evidence['notices'].items()},
          'primary': {'spdx': ['MIT'], 'source': metadata, 'sources': [licence_file], 'reason': 'package.json declares MIT.'},
          'bundled': [{'component': 'vendor/part', 'spdx': ['CC0-1.0'], 'source': part_file,
                       'reason': 'Separate vendored part dedicates its rights to the public domain.'}]}
app_review['applications']['npm:probe@1'] = record


def app_result():
    return checker.check({'artifacts': [app]}, osi, app_evidence, app_review)[0]


assert app_result()['result'] == 'PASS', 'OSI primary with reviewed CC0 part'
assert app_result()['category'] == 'application-osi-with-bundled-free'
saved = copy.deepcopy(record)
record['primary']['spdx'] = ['CC0-1.0']
assert app_result()['result'] == 'FAIL', 'review cannot allow CC0 as primary'
record['primary'] = saved['primary']
for forbidden in ['BUSL-1.1', 'SSPL-1.0', 'CC-BY-NC-4.0', 'CC-BY-ND-4.0', 'unknown-licence']:
    # Even an updated review hash cannot permit a forbidden/unknown identifier.
    record['bundled'][0]['spdx'] = [forbidden]
    app_evidence['notices'][part_file] = 'Bundled part: ' + forbidden
    record['files'][part_file] = checker.digest(app_evidence['notices'][part_file])
    assert app_result()['result'] == 'FAIL', forbidden
record['bundled'] = saved['bundled']
app_evidence['notices'][part_file] = 'Bundled part: BUSL-1.1'
record['files'][part_file] = checker.digest(app_evidence['notices'][part_file])
assert app_result()['result'] == 'FAIL', 'a misleading CC0 mapping cannot hide BUSL text'
# Restore the reviewed text hash; changed text must fail independently of labels.
record['files'] = saved['files']
app_evidence['notices'][part_file] = 'unexamined terms'
assert app_result()['result'] == 'FAIL', 'changed bundled text'
app_evidence['notices'][part_file] = 'Bundled part: CC0-1.0'
assert app_result()['result'] == 'PASS'
app_evidence['notices']['/node_modules/probe/vendor/new/LICENSE'] = 'unexamined terms'
assert app_result()['result'] == 'FAIL', 'new unreviewed bundled file'
for licence in ['PSF-2.0', 'Python-2.0', 'Python-2.0.1', 'MIT-CMU', 'HPND-sell-variant']:
    assert checker.approved(licence, osi | checker.APPLICATION_OSI | set(reviewed['hpndVariants'])), licence
print('PASS: OSI primary, reviewed CC0 bundle, forbidden/unknown bundles and complete notice pins')

# Ordinary OSI-labelled packages cannot bypass the bundle review.
ordinary = dict(app, licenses=[{'value': 'MIT'}])
for path, text in [('/node_modules/probe/NOTICE', 'redistribution forbidden unless separately agreed'),
                   ('/node_modules/probe/NOTICE.md', 'unlisted notice'),
                   ('/node_modules/probe/ThirdPartyNotices.txt', 'MIT')]:
    extra = {'notices': {metadata: app_evidence['notices'][metadata], path: text}}
    assert checker.check({'artifacts': [ordinary]}, osi, extra, reviewed)[0]['result'] == 'FAIL'
# A primary licence plus a pinned but unclassified notice still fails.
app_evidence['notices'].pop('/node_modules/probe/vendor/new/LICENSE')
app_evidence['notices']['/node_modules/probe/NOTICE'] = 'unlisted notice'
record['files']['/node_modules/probe/NOTICE'] = checker.digest('unlisted notice')
assert app_result()['result'] == 'FAIL'
print('PASS: ordinary MIT package restrictive/unlisted notices, and pinned but unclassified notice refused')

# An omnibus notice can name an absent component, but its proof must still
# match every installed byte. A present component never gets this exclusion.
app_evidence['notices'].pop('/node_modules/probe/NOTICE')
record['files'].pop('/node_modules/probe/NOTICE')
app_evidence['notices'][part_file] = 'MIT bundle\nIntel Simplified Software License\nMIT tail\n'
record['files'][part_file] = checker.digest(app_evidence['notices'][part_file])
record['bundled'] = [dict(saved['bundled'][0], spdx=['LicenseRef-Intel-Restricted'],
                          absent='no-mkl', lines=[2, 2])]
installed = {'/node_modules/probe/vendor/runtime.so': checker.digest('inspected ELF')}
app_evidence['installedFiles'] = installed
proof = {'roots': ['/node_modules/probe/vendor'], 'checks': ['Inspected ELF symbols and dependencies; no MKL.'],
         'absentPatterns': [r'/libmkl[^/]*$'],
         'inventorySha256': checker.digest(json.dumps(installed, sort_keys=True, separators=(',', ':')))}
record['absenceProofs'] = {'no-mkl': proof}
assert app_result()['result'] == 'PASS', 'exact reviewed absent component'
for path in ['/node_modules/probe/vendor/libmkl.so', '/elsewhere/libmkl.so']:
    installed[path] = checker.digest('Intel component actually installed')
    assert app_result()['result'] == 'FAIL', 'present component cannot use an absent notice review'
    installed.pop(path)
installed['/node_modules/probe/vendor/runtime.so'] = checker.digest('changed native code')
assert app_result()['result'] == 'FAIL', 'changed library invalidates symbol inspection'
installed['/node_modules/probe/vendor/runtime.so'] = checker.digest('inspected ELF')
installed['/node_modules/probe/vendor/extra.so'] = checker.digest('unreviewed code')
assert app_result()['result'] == 'FAIL', 'added library invalidates reviewed inventory'
installed.pop('/node_modules/probe/vendor/extra.so')
app_evidence.pop('installedFiles')
assert app_result()['result'] == 'FAIL', 'missing collection is not evidence of absence'
app_evidence['installedFiles'] = installed
record['absenceProofs'] = {}
assert app_result()['result'] == 'FAIL', 'component name alone is not a proof'
record['absenceProofs'] = {'no-mkl': proof}
app_evidence['notices'][part_file] += 'redistribution forbidden\n'
record['files'][part_file] = checker.digest(app_evidence['notices'][part_file])
assert app_result()['result'] == 'FAIL', 'other sections of an omnibus notice remain checked'
print('PASS: absent component needs exact file proof; present, changed, added and missing evidence rejected; other notice sections still checked')
