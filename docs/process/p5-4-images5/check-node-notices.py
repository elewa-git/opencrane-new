"""Check recorded Node declarations without approving the candidate image."""

import hashlib
import importlib.util
import json
import sys
from collections import Counter
from pathlib import Path

RECORD = Path(__file__).with_name("node-notices.json")
previous = RECORD.parent.parent / "p5-4-images4/check-candidate.py"
specification = importlib.util.spec_from_file_location("candidate", previous)
candidate = importlib.util.module_from_spec(specification)
specification.loader.exec_module(candidate)

# Limit these bundled terms to the reviewed ICU bytes and the named component.
# Keep the application and general bundled licence rules unchanged.
ICU_SECTION = "1dcebd6ab53b3562845796912ab65afb45186883808e692d8d38a87631ed9d48"
BUNDLED_TERMS = {
    (ICU_SECTION, "ICU IPADIC and ICOT dictionary"): {"NAIST-2003"},
    (ICU_SECTION, "ICU install-sh"): {"HPND-sell-variant"},
}
# Bind each recorded grant to the reviewed notice bytes, not just its entry count.
NODE_NOTICE = 'c738ae413cf561f174e34f6961f8ca458aae2369a73640dda6234c629b98bcc4'
EXPECTED_GRANTS = {
    'c738ae413cf561f174e34f6961f8ca458aae2369a73640dda6234c629b98bcc4': [
        ('Node.js contributors', ('MIT',)),
        ('Node.js Joyent portions', ('MIT',)),
    ],
    'f450db307b369d9c8dec54e73aba64fc118368339abafa1295c273d5df9838e4': [
        ('Acorn', ('MIT',)),
    ],
    '9f9f46cc5cafff2a8787695016826ae700bcf5480358271f4b19a6e2b188f140': [
        ('c-ares', ('MIT',)),
    ],
    'b75dd307e28e49af66fff72e697d53f1421efc718dd671504ef012fc21859eb7': [
        ('cjs-module-lexer', ('MIT',)),
    ],
    '554acb02510019f8de13c39fa3642c8b19b0878f3f978a8100034ae4994b7931': [
        ('ittapi', ('BSD-3-Clause',)),
    ],
    '5c0fbbf576681fabcfe33e09323a0b284e13269eb85d33387d773fe7f8626d97': [
        ('amaro', ('MIT',)),
    ],
    '407584f8622b528db99b12ffca23929991c90494cbe6f602a0cd9763bb55ee14': [
        ('swc', ('Apache-2.0',)),
    ],
    '1dcebd6ab53b3562845796912ab65afb45186883808e692d8d38a87631ed9d48': [
        ('ICU', ('Unicode-3.0',)),
        ('ICU legacy 1.8.1 to 57.1', ('ICU',)),
        ('ICU cjdict Google word list', ('BSD-3-Clause',)),
        ('ICU libtabe TaBE Project and Pai-Hsiang Hsiao', ('BSD-3-Clause',)),
        ('ICU libtabe Academia Sinica', ('BSD-3-Clause',)),
        ('ICU IPADIC and ICOT dictionary', ('NAIST-2003',)),
        ('ICU Lao Unicode and IBM notice', ('ICU', 'Unicode-3.0')),
        ('ICU Lao Wilson and Campbell dictionary', ('BSD-2-Clause',)),
        ('ICU Burmese IBM notice', ('ICU',)),
        ('ICU Burmese LeRoy Benjamin Sharon dictionary', ('BSD-3-Clause',)),
        ('ICU time zone database', ('LicenseRef-Public-Domain',)),
        ('ICU Google double-conversion', ('BSD-3-Clause',)),
        ('ICU nlohmann/json', ('MIT',)),
        ('ICU aclocal.m4 pkg.m4', ('GPL-2.0-or-later',)),
        ('ICU config.guess', ('GPL-3.0-or-later',)),
        ('ICU install-sh', ('HPND-sell-variant',)),
        ('ICU4J sorttable.js', ('MIT-0',)),
    ],
    '6c08071181ee450f8e662712690466ed17a41f1c3e7fc384fc5c63914894b7bf': [
        ('libuv', ('MIT',)),
        ('libuv Joyent portions', ('MIT',)),
        ('libuv FreeBSD tree.h', ('BSD-2-Clause',)),
        ('libuv inet_pton and inet_ntop', ('ISC',)),
    ],
    'f35205cd55dda169372e3b8f8c947d11559f18bbed2cfab29adfb29e3689cd37': [
        ('llhttp', ('MIT',)),
    ],
    'b4b9cd50b7273b6df53db54c35ae4f4aa78edf9ffee89efb17fbea0caa98e21a': [
        ('corepack', ('MIT',)),
    ],
    '19af144436151452a03185fdb4aa30fc5bbf1597d4a16b59fda6898a09cec2b6': [
        ('undici', ('MIT',)),
    ],
    'd2dcfa7ad443209d83e2b999c5a70e039e161a21989f48d797b4caea6d5b4365': [
        ('postject', ('MIT',)),
        ('Postject LIEF', ('Apache-2.0',)),
    ],
    'c7d8114e5eedd040105876ac4a4ebb26d77be63f798209e2c0e6ae8b55a962fd': [
        ('OpenSSL', ('Apache-2.0',)),
    ],
    'f42dacb38773d598413dfdf1d77478fcc1c0be48ac96b80c881b8ce93d590cc8': [
        ('Punycode.js', ('MIT',)),
    ],
    '105920c94ff5a834680e7e6d4ed5b666df185d6dc04ce7d7992b947b9916299f': [
        ('V8', ('BSD-3-Clause',)),
        ('V8 WebKit layout tests', ('BSD-3-Clause',)),
        ('V8 Strongtalk assembler', ('BSD-3-Clause',)),
    ],
    '9ef24eb957886240edd7e07572314de122f6b150cffabcda218906880112e62a': [
        ('SipHash', ('LicenseRef-Public-Domain',)),
    ],
    'cc7dbacc765234a4c4671d9f0c1fdf97581df100a5814ef37886b2da409b1e24': [
        ('zlib', ('Zlib',)),
    ],
    '25e070f387d4e7563977b49f830380d147266569d189c1204feea514c76776b6': [
        ('simdjson', ('Apache-2.0',)),
    ],
    '5802fa4a075902d8dfebe1e1e7a604ef4d522a8760c1568dd159fb773bb5b919': [
        ('simdutf', ('MIT',)),
    ],
    'c2a8a3cc177d50c9d17641655e3e0383a6a45701c40f6252e367d201c987c361': [
        ('ada', ('MIT',)),
    ],
    '3cf470e673bdf7e3fce8d0874991b91fa3b3169a49db4073b486839ce2fad3c8': [
        ('minimatch', ('BlueOak-1.0.0',)),
    ],
    '3b6f5654a4834f406d2c374a2cafffe9de5d45cdb28cdc808e6c7e73ffc0700d': [
        ('npm', ('Artistic-2.0',)),
    ],
    '14964b42797f4b3141be5c07197b8e705a45b2678489e5cd8c4da5bb1f1ec06a': [
        ('GYP', ('BSD-3-Clause',)),
    ],
    '44c96610ce075356c167db58100e2e2ebbc7873403240a5b9d255c94cd5fed96': [
        ('inspector_protocol', ('BSD-3-Clause',)),
    ],
    '96f2faa737fc17c237172df255964c842ada17e4ca9932e254dbf664281d9c2a': [
        ('jinja2', ('BSD-3-Clause',)),
    ],
    'a297771f4702bd7472c7300fb9b3aa845aead52e52d8f8502cc1f9fcbbe30560': [
        ('markupsafe', ('BSD-3-Clause',)),
    ],
    'fa3c4bd4baf04cef56fc373d3adf3546f62d6b26fe4d4517699e56235c31c6c6': [
        ('cpplint.py', ('BSD-3-Clause',)),
    ],
    'b3a92fef01934924e0346ce98f69f50f562d1e608c35ccda51479ca40d0cd7d5': [
        ('gypi_to_gn.py', ('BSD-3-Clause',)),
    ],
    '66d76edc549caf4b12ff3e511dbd2d22490a5b06e0d4a592b44ca3c66c50333c': [
        ('gtest', ('BSD-3-Clause',)),
    ],
    'de5d94dfba86eeea1b9269a64607a410520407536c837ee399a6aaa62dc2c9e7': [
        ('nghttp2', ('MIT',)),
    ],
    '26ca634af3f195bb1b87944108636948617a6ed430e72cb00abbc2489a13e109': [
        ('large_pages', ('MIT',)),
    ],
    '0aa2a69d9104ae2882631ec0a8f871a1349cb99ebe8139f09abb011fef6b8726': [
        ('caja', ('Apache-2.0',)),
    ],
    'eccb964d0bc2aeb4106ea2a7582ee8ec40e79e4b7c974288c744262f59fd27ba': [
        ('brotli', ('MIT',)),
    ],
    'be61d48919a4bcafa4b0a75054cc48dece1f9f13706b7712d800bba0088ba8f3': [
        ('zstd', ('BSD-3-Clause',)),
    ],
    '9b6b741731e3416ab59cc7b963707dc22f791e4521e9130db7e0d3154a9db57a': [
        ('HdrHistogram', ('BSD-2-Clause',)),
    ],
    '174b99cbc86fddc9ee70abaaf5796dc990879b4a49a4a4a145daa089f32a51a4': [
        ('node-heapdump', ('ISC',)),
        ('node-heapdump compat.h and compat-inl.h', ('ISC',)),
    ],
    '84c3034ee9c3038981eaab5cf1306930a7082a0cf057c624f36fc9f86b980ff8': [
        ('rimraf', ('ISC',)),
    ],
    'ff034819bc1f32c8bd2d0ee1cd2e3956140f6fd4a2d3dfafc2587457a107e332': [
        ('uvwasi', ('MIT',)),
    ],
    'c1c36eee17c21729dba3aaf6976f4537b24e1ea2543dbb10754e096d80fcd254': [
        ('ngtcp2', ('MIT',)),
    ],
    'e9a6f2185bc089126659a30267860e1c125e3f454b020501b91b65aeec742b20': [
        ('nghttp3', ('MIT',)),
    ],
    '8822f5b0fce3d4ee3a983b520ef2dbfdebb540a81c9a1ecc65d5c44a472900a4': [
        ('node-fs-extra', ('MIT',)),
    ],
    'bab282545179adaae81e43e4af606badda918a8e278bb6a907dead69a8f539e7': [
        ('on-exit-leak-free', ('MIT',)),
    ],
    '02545de96b9ba48e4fb2dbbf0d10fee7fc9ab439aea356482dc8e8efdad91e85': [
        ('sonic-boom', ('MIT',)),
    ],
}
# Keep every unresolved reference once under its reviewed section.
EXPECTED_REFERENCES = [
    ('1dcebd6ab53b3562845796912ab65afb45186883808e692d8d38a87631ed9d48',
     'libtabe Chih-Hao Tsai attribution'),
    ('105920c94ff5a834680e7e6d4ed5b666df185d6dc04ce7d7992b947b9916299f',
     'V8 PCRE test suite'),
    ('105920c94ff5a834680e7e6d4ed5b666df185d6dc04ce7d7992b947b9916299f',
     'V8 Valgrind client API'),
    ('105920c94ff5a834680e7e6d4ed5b666df185d6dc04ce7d7992b947b9916299f',
     'V8 Wasm C/C++ API'),
    ('105920c94ff5a834680e7e6d4ed5b666df185d6dc04ce7d7992b947b9916299f',
     'V8 other subdirectory licences'),
    ('3b6f5654a4834f406d2c374a2cafffe9de5d45cdb28cdc808e6c7e73ffc0700d',
     'npm package dependencies'),
    ('3b6f5654a4834f406d2c374a2cafffe9de5d45cdb28cdc808e6c7e73ffc0700d',
     'npm registry and website terms'),
    ('3b6f5654a4834f406d2c374a2cafffe9de5d45cdb28cdc808e6c7e73ffc0700d',
     'npm logo'),
    ('3b6f5654a4834f406d2c374a2cafffe9de5d45cdb28cdc808e6c7e73ffc0700d',
     'Gubblebum Blocky typeface'),
    ('3b6f5654a4834f406d2c374a2cafffe9de5d45cdb28cdc808e6c7e73ffc0700d',
     'Node.js trademark and project references'),
]
FIELDS = {"status", "scope", "candidateSha256", "sourceRevision", "configurationDigest",
          "localIndexDigest", "nodeNoticeSha256", "node", "sections", "blockedReferences"}


def check_declarations(declarations, section_hash):
    if not isinstance(declarations, list) or not declarations:
        raise ValueError("Node declarations are missing")
    names = set()
    recorded = []
    for declaration in declarations:
        if not isinstance(declaration, list) or len(declaration) != 4:
            raise ValueError("Node declaration must identify its terms and reason")
        name, licences, location, reason = declaration
        for value in (name, location, reason):
            if not isinstance(value, str) or not value.strip():
                raise ValueError("Node declaration needs an individual reason")
        if name in names or location != "/usr/local/LICENSE":
            raise ValueError("Node declaration is duplicated or has a different source")
        names.add(name)
        if not isinstance(licences, list) or not licences:
            raise ValueError("Node declaration needs licence identifiers")
        for licence in licences:
            if not isinstance(licence, str) or not licence.strip():
                raise ValueError("Node licence identifier is missing")
        accepted = candidate.OSI | BUNDLED_TERMS.get((section_hash, name), set())
        candidate.checker.check_bundled_notice(declaration, accepted)
        recorded.append((name, tuple(sorted(licences))))
    expected = EXPECTED_GRANTS.get(section_hash)
    if expected is None or Counter(recorded) != Counter(expected):
        raise ValueError("Node component and licence pairs differ from the reviewed notice")


def check_sections(sections, original):
    if not isinstance(sections, list) or not sections:
        raise ValueError("Node sections are missing")
    listed = []
    for row in sections:
        if not isinstance(row, list) or len(row) != 3:
            raise ValueError("Node section review is incomplete")
        heading, section_hash, declarations = row
        listed.append((heading, section_hash))
        check_declarations(declarations, section_hash)
    expected = []
    for heading, section_hash, _ in original["nodeSections"]:
        expected.append((heading, section_hash))
    if Counter(listed) != Counter(expected):
        raise ValueError("Node sections are missing, duplicated or changed")


def check_blocked_references(references, sections):
    if not isinstance(references, list) or not references:
        raise ValueError("Unresolved Node references must remain blocked")
    section_hashes = set()
    for section in sections:
        section_hashes.add(section[1])
    recorded = []
    for row in references:
        if not isinstance(row, list) or len(row) != 4:
            raise ValueError("Unresolved Node reference is incomplete")
        section_hash, name, reason, status = row
        if section_hash not in section_hashes or status != "BLOCKED":
            raise ValueError("Unresolved Node references cannot grant approval")
        for value in (name, reason):
            if not isinstance(value, str) or not value.strip():
                raise ValueError("Unresolved Node reference needs its reason")
        recorded.append((section_hash, name))
    if Counter(recorded) != Counter(EXPECTED_REFERENCES):
        raise ValueError("Unresolved Node references are missing, duplicated or changed")


def check_review(review, contents):
    if set(review) != FIELDS:
        raise ValueError("Node review fields are incomplete or imply wider approval")
    if review["status"] != "PARTIAL" or review["scope"] != "Node notice declarations only":
        raise ValueError("Node notice evidence cannot approve the complete image")
    record_bytes = candidate.checked_bytes(candidate.RECORD, review["candidateSha256"])
    record = json.loads(record_bytes)
    for field in ("sourceRevision", "configurationDigest", "localIndexDigest"):
        if review[field] != record[field]:
            raise ValueError("Node review identifies a different candidate")
    checksum = hashlib.sha256(contents).hexdigest()
    if (checksum != NODE_NOTICE or checksum != record["files"]["node-LICENSE"]
            or checksum != review["nodeNoticeSha256"]):
        raise ValueError("Node full notice changed")
    original_bytes = candidate.checked_bytes(
        candidate.RECORD.with_name("notices.json"), record["noticesSha256"])
    original = json.loads(original_bytes)
    candidate.check_node_sections(original, contents)
    check_declarations(review["node"], checksum)
    check_sections(review["sections"], original)
    check_blocked_references(review["blockedReferences"], review["sections"])
    return len(review["sections"])


if __name__ == "__main__":
    try:
        if len(sys.argv) != 2:
            raise ValueError("Pass the candidate evidence directory")
        directory = Path(sys.argv[1]).resolve()
        candidate.check_evidence(candidate.checker.read_json(candidate.RECORD), directory)
        contents = (directory / "node-LICENSE").read_bytes()
        count = check_review(candidate.checker.read_json(RECORD), contents)
        print(f"PASS Node declaration record: {count} sections; unresolved references stay blocked")
        print("PARTIAL image review; other bundled declarations and source-bound R3 remain required")
    except (KeyError, ValueError, OSError, TypeError, IndexError, AttributeError,
            candidate.lzma.LZMAError, candidate.tarfile.TarError):
        # Withhold local paths, notice contents and dependency output on refusal.
        print("FAIL Node notice evidence is missing, changed or unsupported", file=sys.stderr)
        sys.exit(1)
