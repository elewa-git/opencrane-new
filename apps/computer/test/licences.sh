#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
state=$(mktemp -d)
trap 'rm -rf "$state"' EXIT HUP INT TERM
mkdir -p "$state/root/node_modules/licence-probe"
printf '%s\n' '{"name":"licence-probe","version":"1.0.0","license":"MIT"}' > "$state/root/node_modules/licence-probe/package.json"
.state/syft scan --select-catalogers +javascript-package-cataloger "dir:$state/root" -o "syft-json=$state/allowed.json"
if python3 check-licences.py "$state/allowed.json" .state/osi.json "$state/inventory.json" > "$state/result" 2>&1; then
  echo 'FAIL: unreviewed MIT package accepted' >&2
  exit 1
fi
rg -q 'Missing application notice review' "$state/result"
printf '%s\n' '{"name":"licence-probe","version":"1.0.0","license":"BUSL-1.1"}' > "$state/root/node_modules/licence-probe/package.json"
.state/syft scan --select-catalogers +javascript-package-cataloger "dir:$state/root" -o "syft-json=$state/denied.json"
if python3 check-licences.py "$state/denied.json" .state/osi.json "$state/inventory.json" > "$state/result" 2>&1; then
  echo 'FAIL: non-OSI package accepted' >&2
  exit 1
fi
rg -q 'BUSL-1.1' "$state/result"
echo 'PASS: real SBOM requires MIT notice review and rejects injected BUSL-1.1 package'
printf '%s\n' '{"name":"licence-probe","version":"1.0.0","license":"CC0-1.0"}' > "$state/root/node_modules/licence-probe/package.json"
.state/syft scan --select-catalogers +javascript-package-cataloger "dir:$state/root" -o "syft-json=$state/cc0.json"
if python3 check-licences.py "$state/cc0.json" .state/osi.json "$state/inventory.json" > "$state/result" 2>&1; then
  echo 'FAIL: application CC0 accepted' >&2
  exit 1
fi
rg -q 'CC0-1.0' "$state/result"
python3 test/licences.py
# Exercise collection against installed files, including a metadata-named custom filename.
docker run --rm -i -v "$PWD/collect-licences.py:/tmp/collect.py:ro" \
  -v "$PWD/check-licences.py:/tmp/check.py:ro" \
  -v "$PWD/reviewed-licences.json:/tmp/reviewed.json:ro" \
  -v "$PWD/.state/osi.json:/tmp/osi.json:ro" --entrypoint python3 ocn-computer-runtime - <<'PYTHON'
import importlib.util
import json
from pathlib import Path
spec = importlib.util.spec_from_file_location('collector', '/tmp/collect.py')
collector = importlib.util.module_from_spec(spec)
spec.loader.exec_module(collector)
root = Path('/app/node_modules/licence-probe')
root.mkdir()
(root / 'package.json').write_text(json.dumps({'name': 'licence-probe', 'version': '1', 'license': 'SEE LICENSE IN terms.txt'}))
names = ['terms.txt', 'NOTICE', 'NOTICE.md', 'ThirdPartyNotices.txt', 'COPYING.extra', 'LICENCE.extra', 'LICENSE.extra']
for name in names:
    (root / name).write_text('redistribution forbidden unless separately agreed')
notices, owners = collector.notices()
assert all(str(root / name) in notices for name in names)
assert all(str(root / name) in owners[str(root / 'package.json')] for name in names)
(root / 'terms.txt').unlink()
try:
    collector.notices()
except ValueError as error:
    assert 'Missing metadata-named notice' in str(error)
else:
    raise AssertionError('missing metadata-named file accepted')
print('PASS: real image collector includes every notice name and custom metadata file; missing named file fails')

spec = importlib.util.spec_from_file_location('checker', '/tmp/check.py')
checker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(checker)
reviewed = json.loads(Path('/tmp/reviewed.json').read_text())
osi = {p['licenseId'] for p in json.loads(Path('/tmp/osi.json').read_text())['licenses'] if p.get('isOsiApproved')}
package = {'name': 'lxml', 'version': '6.1.3', 'type': 'python', 'licenses': [{'value': 'BSD-3-Clause'}]}
evidence = {'notices': notices, 'installedFiles': collector.installed_files()}
def result():
    return checker.check({'artifacts': [package]}, osi, evidence, reviewed)[0]['result']
assert result() == 'PASS'
for name in ['RNG2Schtrn.xsl', 'XSD2Schtrn.xsl']:
    path = Path('/opt/python/lib/python3.11/site-packages/lxml/isoschematron/resources/xsl') / name
    assert not path.exists()
    path.write_text('unlicensed stylesheet restored')
    evidence['installedFiles'] = collector.installed_files()
    assert result() == 'FAIL', 'a restored stylesheet must block release'
    path.unlink()
    path.symlink_to('/absent-target')
    evidence['installedFiles'] = collector.installed_files()
    assert result() == 'FAIL', 'a dangling stylesheet link is not absence'
    path.unlink()
evidence['installedFiles'] = collector.installed_files()
assert result() == 'PASS'
print('PASS: actual image has no unlicensed stylesheets; restoring either file or a dangling link fails the gate')
PYTHON
