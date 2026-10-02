"""Fail closed on absent, unrecognised or non-OSI runtime licence expressions."""
import json
import re
import sys
from pathlib import Path

sbom = json.loads(Path(sys.argv[1]).read_text())
osi = {item['licenseId'] for item in json.loads(Path(sys.argv[2]).read_text())['licenses'] if item.get('isOsiApproved')}
# Debian copyright labels and Python metadata spellings of the same licences.
aliases = {'Expat': 'MIT', 'expat': 'MIT', 'MIT License': 'MIT', 'Apache 2.0': 'Apache-2.0',
           'Apache-2': 'Apache-2.0', 'BSD-3-clause': 'BSD-3-Clause', 'BSD-2-clause': 'BSD-2-Clause',
           '3-Clause BSD License': 'BSD-3-Clause', 'PSFL': 'PSF-2.0', 'Python': 'PSF-2.0',
           'zlib': 'Zlib', 'ZLIB': 'Zlib', 'Artistic': 'Artistic-1.0', 'Artistic-2': 'Artistic-2.0'}
for family in ['GPL', 'LGPL']:
    for version in ['1', '2', '2.0', '2.1', '3', '3.0']:
        number = version if '.' in version else version + '.0'
        aliases[f'{family}-{version}'] = f'{family}-{number}-only'
        aliases[f'{family}-{version}+'] = f'{family}-{number}-or-later'


def approved(expression):
    expression = aliases.get(expression, expression)
    if expression in osi:
        return True
    # SPDX expressions: AND binds more tightly than OR; unknown syntax fails.
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
        return aliases.get(token, token) in osi

    def both():
        nonlocal position
        result = term()
        while position < len(tokens) and tokens[position] == 'AND':
            position += 1
            next_result = term()
            result = result and next_result
        return result

    def either():
        nonlocal position
        result = both()
        while position < len(tokens) and tokens[position] == 'OR':
            position += 1
            next_result = both()
            result = result or next_result
        return result

    try:
        result = either()
        return result and position == len(tokens)
    except ValueError:
        return False


if not sbom['artifacts']:
    raise SystemExit('FAIL: SBOM has no packages')

inventory = []
for package in sbom['artifacts']:
    licences = sorted({item['value'] for item in package.get('licenses', [])})
    denied = [licence for licence in licences if not approved(licence)]
    passed = bool(licences) and not denied
    inventory.append({'name': package['name'], 'version': package['version'], 'type': package['type'],
                      'licences': licences, 'result': 'PASS' if passed else 'FAIL',
                      'unresolved': denied or ([] if passed else ['No detected licence'])})
Path(sys.argv[3]).write_text(json.dumps(inventory, indent=2) + '\n')
failures = [item for item in inventory if item['result'] == 'FAIL']
for item in failures:
    print(f"FAIL {item['name']}@{item['version']}: {', '.join(item['unresolved'])}", file=sys.stderr)
print(f"Licence gate: {len(inventory) - len(failures)}/{len(inventory)} packages accepted")
sys.exit(bool(failures))
