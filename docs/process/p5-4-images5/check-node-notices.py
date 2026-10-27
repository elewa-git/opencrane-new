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
# Require the separately printed grants, even when the containing section matches.
GRANT_COUNTS = {"ICU": 17, "libuv": 4, "postject": 2, "V8": 3, "node-heapdump": 2}
FIELDS = {"status", "scope", "candidateSha256", "sourceRevision", "configurationDigest",
          "localIndexDigest", "nodeNoticeSha256", "node", "sections", "blockedReferences"}


def check_declarations(declarations, section_hash):
    if not isinstance(declarations, list) or not declarations:
        raise ValueError("Node declarations are missing")
    names = set()
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
        component = heading.split(", located at ", 1)[0]
        if declarations[0][0] != component or len(declarations) != GRANT_COUNTS.get(component, 1):
            raise ValueError("Node grants cannot be replaced with blanket approval")
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
    for row in references:
        if not isinstance(row, list) or len(row) != 4:
            raise ValueError("Unresolved Node reference is incomplete")
        section_hash, name, reason, status = row
        if section_hash not in section_hashes or status != "BLOCKED":
            raise ValueError("Unresolved Node references cannot grant approval")
        for value in (name, reason):
            if not isinstance(value, str) or not value.strip():
                raise ValueError("Unresolved Node reference needs its reason")


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
    if checksum != record["files"]["node-LICENSE"] or checksum != review["nodeNoticeSha256"]:
        raise ValueError("Node full notice changed")
    original_bytes = candidate.checked_bytes(
        candidate.RECORD.with_name("notices.json"), record["noticesSha256"])
    original = json.loads(original_bytes)
    candidate.check_node_sections(original, contents)
    check_declarations(review["node"], "preamble")
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
