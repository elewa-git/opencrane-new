"""Fail closed: signed Debian main packages or OSI-approved application licences."""
import hashlib
import json
import re
import sys
from collections import Counter
from pathlib import Path

# Boost (BSL-1.0) is not the Business Source Licence (BUSL-1.1).
FORBIDDEN = re.compile(r'\b(?:BUSL(?:-\S+)?|SSPL(?:-\S+)?|Elastic(?:\s+License|-\d)|KLv?1|'
                       r'Commons[ -]Clause|Business Source Licen[cs]e|Server Side Public Licen[cs]e|'
                       r'Kurrent\s+(?:Software\s+)?Licen[cs]e|Fair[ -]Source|PolyForm(?:-\S+)?|'
                       r'Confluent Community|Sustainable Use License|FSL-\S+|CC-BY-NC(?:-\S+)?)\b', re.I)


def digest(text):
    return 'sha256:' + hashlib.sha256(text.encode()).hexdigest()


def approved(expression, allowed):
    """Parse SPDX AND/OR; unknown terms fail even in an OR branch."""
    tokens = re.findall(r'\(|\)|[^\s()]+', expression)
    position = 0

    def term():
        nonlocal position
        if position >= len(tokens):
            raise ValueError('Missing licence')
        token = tokens[position]
        position += 1
        if token == '(':
            result = either()
            if position >= len(tokens) or tokens[position] != ')':
                raise ValueError('Missing bracket')
            position += 1
            return result
        if token not in allowed:
            raise ValueError('Unapproved licence')
        return True

    def both():
        nonlocal position
        result = term()
        while position < len(tokens) and tokens[position] == 'AND':
            position += 1
            result = term() and result
        return result

    def either():
        nonlocal position
        result = both()
        while position < len(tokens) and tokens[position] == 'OR':
            position += 1
            result = both() or result
        return result

    try:
        return either() and position == len(tokens)
    except ValueError:
        return False


def check(sbom, osi, evidence, reviewed):
    inventory = []
    archives = {(p['name'], p['version'], p['architecture']): p['archives'] for p in evidence.get('apt', [])}
    notices = evidence.get('notices', {})
    for package in [*sbom['artifacts'], *evidence.get('artifacts', [])]:
        name, version, kind = (package[key] for key in ['name', 'version', 'type'])
        licences = sorted({item['value'] for item in package.get('licenses', [])})
        errors, resolved = [], []
        key = f'{kind}:{name}@{version}'
        application = reviewed.get('applications', {}).get(key)
        origins = archives.get((name, version, package.get('metadata', {}).get('architecture')), [])
        debian = kind == 'deb' and not (application and application.get('localDeb'))
        category = 'debian-main' if debian else 'application-osi'
        if kind == 'deb' and any(o['component'] != 'main' for o in origins):
            errors.append('Forbidden Debian archive component')
        if debian:
            if not origins or any(o['component'] != 'main' or o['origin'] != 'Debian' or not o['trusted']
                                  or not re.match(r'pool/(?:updates/)?main/', o['filename']) for o in origins):
                errors.append('No exact signed Debian main archive match')
        paths = {loc['path'] for licence in package.get('licenses', []) for loc in licence.get('locations', [])}
        if kind == 'deb':
            paths.add(f'/usr/share/doc/{name}/copyright')
        if kind in {'npm', 'python'}:
            for location in package.get('locations', []):
                prefix = str(Path(location['path']).parent) + '/'
                paths.update(path for path in notices if path.startswith(prefix))
        if application:
            paths.update(application['files'])
        texts = {path: notices[path] for path in paths if path in notices}
        for text in [*licences, *texts.values()]:
            if FORBIDDEN.search(text):
                errors.append('Source-available licence: ' + FORBIDDEN.search(text)[0])
        if application:
            for path, expected in application['files'].items():
                if path not in texts or digest(texts[path]) != expected:
                    errors.append('Missing or changed reviewed notice: ' + path)
            # An override only resolves the exact scanner output that was examined.
            if licences != sorted(application['detected']):
                errors.append('Changed application licence metadata')
            resolved = application['spdx']
            errors.extend(value for value in resolved if not approved(value, osi))
        else:
            for licence in licences:
                value = reviewed['aliases'].get(licence, licence)
                if approved(value, osi):
                    resolved.append(value)
                elif debian and licence in reviewed['debianLabels']:
                    resolved.append('Debian-main notice: ' + licence)
                elif debian and any(licence in reviewed['texts'].get(digest(text), {}).get('labels', [])
                                    for text in texts.values()):
                    resolved.append('Debian-main reviewed notice: ' + licence)
                elif licence.startswith('sha256:') and licence in reviewed['texts']:
                    mapping = reviewed['texts'][licence]
                    if licence not in {digest(text) for text in texts.values()}:
                        errors.append('Missing or changed licence text: ' + licence)
                    elif mapping['category'] == 'debian-main' and debian:
                        resolved.append('Debian-main notice: ' + mapping['reason'])
                    elif mapping['category'] == 'spdx' and approved(mapping['spdx'], osi):
                        resolved.append(mapping['spdx'])
                    else:
                        errors.append(licence)
                else:
                    errors.append(licence)
        if not resolved:
            errors.append('No approved licence')
        inventory.append({'name': name, 'version': version, 'type': kind, 'category': category,
                          'licences': licences, 'resolved': resolved, 'archives': origins,
                          'result': 'FAIL' if errors else 'PASS', 'unresolved': sorted(set(errors))})
    return inventory


if __name__ == '__main__':
    sbom = json.loads(Path(sys.argv[1]).read_text())
    osi = {item['licenseId'] for item in json.loads(Path(sys.argv[2]).read_text())['licenses'] if item.get('isOsiApproved')}
    evidence = json.loads(Path(sys.argv[4]).read_text()) if len(sys.argv) > 4 else {}
    reviewed = json.loads(Path(__file__).with_name('reviewed-licences.json').read_text())
    if not sbom['artifacts']:
        raise SystemExit('FAIL: SBOM has no packages')
    inventory = check(sbom, osi, evidence, reviewed)
    Path(sys.argv[3]).write_text(json.dumps(inventory, indent=2) + '\n')
    failures = [item for item in inventory if item['result'] == 'FAIL']
    for item in failures:
        print(f"FAIL {item['name']}@{item['version']}: {', '.join(item['unresolved'])}", file=sys.stderr)
    print(f"Licence gate: {len(inventory) - len(failures)}/{len(inventory)} packages accepted; "
          f"{dict(Counter(item['category'] + ':' + item['result'] for item in inventory))}")
    sys.exit(bool(failures))
