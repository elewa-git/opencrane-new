"""Check the Wasm API terms against signed Node source and shipped bytes."""

import hashlib
import importlib.util
import json
import sys
import tarfile
from collections import Counter
from pathlib import Path

RECORD = Path(__file__).with_name("wasm.json")
previous = RECORD.parent.parent / "p5-4-images6/check-pcre.py"
specification = importlib.util.spec_from_file_location("pcre", previous)
pcre = importlib.util.module_from_spec(specification)
specification.loader.exec_module(pcre)
candidate = pcre.candidate
REFERENCE = (pcre.REFERENCE[0], "V8 Wasm C/C++ API")
SOURCE_PATH = "deps/v8/third_party/wasm-api/LICENSE"
SOURCES = {
    "wasm-LICENSE": "deps/v8/third_party/wasm-api/LICENSE",
    "wasm.h": "deps/v8/third_party/wasm-api/wasm.h",
    "wasm.hh": "deps/v8/third_party/wasm-api/wasm.hh",
    "wasm-README.v8": "deps/v8/third_party/wasm-api/README.v8",
}
INPUTS = {
    "wasm-LICENSE": "c6596eb7be8581c18be736c846fb9173b69eccf6ef94c5135893ec56bd92ba08",
    "wasm.h": "a4690c2961e94259dc5020698b1bd03243315edac5afabe0806f14fd47f64007",
    "wasm.hh": "cdc02e5a44a2b28e8f7941c0ea73f6c19532b5db83b399d3cea252ddfb740b91",
    "wasm-README.v8": "04d6239b64c5ce5717a7045886f799fecef63d863ff79b29ecd208e26376812c",
    "node-version.h": pcre.INPUTS["node-version.h"],
    "node-LICENSE": pcre.node.NODE_NOTICE,
}
SOURCE_FILES = {}
for name, location in SOURCES.items():
    SOURCE_FILES[location] = INPUTS[name]
GRANTS = [("Wasm C/C++ API", ("Apache-2.0",))]


def check_review(review, inputs):
    if set(review) != pcre.FIELDS | {"sourceFiles"} or review["status"] != "PARTIAL":
        raise ValueError("Wasm API evidence cannot approve the complete image")
    if review["method"] != "reviewed embedded terms":
        raise ValueError("Wasm API absence has not been proved")
    expected = (pcre.VERSION, pcre.COMMIT, SOURCE_PATH, pcre.BINARY)
    actual = (review["nodeVersion"], review["upstreamCommit"],
              review["sourcePath"], review["nodeBinarySha256"])
    if (actual != expected or review["files"] != pcre.FILES
            or review["sourceFiles"] != SOURCE_FILES):
        raise ValueError("Wasm API source version or build inputs differ")
    if review["references"] != [list(REFERENCE)]:
        raise ValueError("Wasm API requires its exact reference once")
    candidate.checked_bytes(candidate.RECORD, review["candidateSha256"])
    historical = candidate.checked_bytes(pcre.node.RECORD, review["nodeNoticesSha256"])
    for name, digest in INPUTS.items():
        if hashlib.sha256(inputs[name]).hexdigest() != digest:
            raise ValueError("Wasm API source or notice bytes changed")
    pcre.node.check_review(json.loads(historical), inputs["node-LICENSE"])
    grants = []
    for declaration in review["declarations"]:
        candidate.checker.check_bundled_notice(declaration, candidate.OSI)
        if not isinstance(declaration[3], str) or not declaration[3].strip():
            raise ValueError("Wasm API grants need an individual reason")
        if declaration[2] != SOURCE_PATH:
            raise ValueError("Wasm API terms must identify the reviewed source")
        grants.append((declaration[0], tuple(declaration[1])))
    if Counter(grants) != Counter(GRANTS):
        raise ValueError("Wasm API component and licence pairs differ")
    return REFERENCE[1]


def check_upstream(directory):
    # Reuse release and tag signatures, version, notice and official binary comparisons.
    inputs = pcre.check_upstream(directory)
    for name, location in SOURCES.items():
        inputs[name] = pcre.run_checked([
            "git", "-C", str(directory / "upstream"), "show", f"{pcre.COMMIT}:{location}"])
    source_files = {}
    with tarfile.open(directory / "node-v22.23.1.tar.xz", mode="r|xz") as archive:
        for member in archive:
            location = member.name.removeprefix("node-v22.23.1/")
            if location in SOURCE_FILES and member.isfile():
                source_files[location] = archive.extractfile(member).read()
    expected = {}
    for name, location in SOURCES.items():
        expected[location] = inputs[name]
    if source_files != expected:
        raise ValueError("Wasm API Git source and release source differ or are missing")
    return inputs


def check_evidence(directory, upstream):
    inputs = check_upstream(upstream)
    review = candidate.checker.read_json(RECORD)
    check_review(review, inputs)
    candidate_review = candidate.checker.read_json(candidate.RECORD)
    pcre.check_candidate(candidate_review, directory)


def main(arguments):
    try:
        if len(arguments) != 2:
            raise ValueError("Pass candidate and upstream evidence directories")
        check_evidence(Path(arguments[0]).resolve(), Path(arguments[1]).resolve())
        print("PASS V8 Wasm C/C++ API: exact source terms and all-layer Node bytes checked")
        print("PARTIAL image review; seven other references, bundles and exact-source R3 remain")
    except (KeyError, ValueError, OSError, TypeError, IndexError, AttributeError,
            candidate.lzma.LZMAError, tarfile.TarError):
        # Withhold source text, local paths and dependency output on refusal.
        print("FAIL Wasm API source-bound evidence is missing, changed or unsupported",
              file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
