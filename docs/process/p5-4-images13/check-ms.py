"""Check one dependency's complete grant and exact source transformation."""

import contextlib
import gzip
import hashlib
import importlib.util
import io
import json
import re
import sys
import tarfile
from pathlib import Path

REFUSAL = "FAIL ms grant evidence is missing, changed or unsupported"
RECORD = Path(__file__).with_name("grant.json")
REVIEW_SHA256 = "e615970c89b2a3cca30a51a569c24584cf4cec39539629c710b37415d2973b20"
try:
    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
        previous = RECORD.parent.parent / "p5-4-images9/check-corepack.py"
        specification = importlib.util.spec_from_file_location("corepack", previous)
        corepack = importlib.util.module_from_spec(specification)
        specification.loader.exec_module(corepack)
        candidate = corepack.candidate
except (Exception, SystemExit):
    # Withhold imported checker output and local paths when loading fails.
    print(REFUSAL, file=sys.stderr)
    sys.exit(1)


def trusted_review():
    return json.loads(candidate.checked_bytes(RECORD, REVIEW_SHA256))


def load_inputs(review):
    contents = {}
    for name, _, _ in review["sourceFiles"]:
        filename = name + ".gz"
        compressed = candidate.checked_bytes(
            RECORD.with_name(filename), review["compressedFiles"][filename])
        contents[name] = gzip.decompress(compressed)
    return contents


def transform_source(source, label):
    source_text = source.decode()
    body = re.sub(r"/\*\*.*?\*/", "", source_text, flags=re.DOTALL)
    body = body.replace("'", '"')
    body = body.replace("var s = 1000;", "var s = 1e3;")
    body = body.replace("module.exports", "module2.exports")
    body = body.replace("function (", "function(")
    body = body.replace("parse(", "parse4(")
    body = body.replace("plural(", "plural2(")
    body = re.sub(r"\bname\b", "name2", body)
    body = body.replace("return undefined;", "return void 0;")
    body = body.replace('val=" +\n      JSON.stringify(val)', 'val=" + JSON.stringify(val)')
    indented = []
    for line in body.splitlines():
        if line.strip():
            indented.append("    " + line)
    wrapped = (f"// {label}\nvar require_ms = __commonJS({{\n"
               f'  "{label}"(exports2, module2) {{\n')
    wrapped += "\n".join(indented) + "\n  }\n});\n\n"
    return wrapped.encode()


def check_review(review, inputs, bundle, regions):
    if review != trusted_review():
        raise ValueError("The reviewed source, grant or unresolved scope changed")
    for name, size, digest in review["sourceFiles"]:
        data = inputs[name]
        if len(data) != size:
            raise ValueError("Dependency source size changed")
        if hashlib.sha256(data).hexdigest() != digest:
            raise ValueError("Dependency source or complete licence changed")
    inventory = corepack.trusted_review()
    modules = []
    for row in inventory["modules"]:
        if row[0] == "ms":
            modules.append(row)
    if modules != [review["module"]]:
        raise ValueError("Require exactly one original dependency row")
    matching = []
    for row in regions:
        if row[2].endswith("/ms/index.js"):
            matching.append(row)
    if matching != review["ranges"]:
        raise ValueError("Require the exact module range once")
    for start, end, label, _ in matching:
        transformed = transform_source(inputs["index.js"], label)
        # Compare every reviewed byte; a package label or MIT claim proves no ancestry.
        if bundle[start:end] != transformed:
            raise ValueError("Unsupported dependency transformation")
    return "ms 2.1.3: MIT"


def check_evidence(directory, upstream):
    # Keep signed Node, all-layer candidate and full Corepack inventory checks mandatory.
    corepack.check_evidence(directory, upstream)
    review = trusted_review()
    candidate.checked_bytes(corepack.RECORD, review["inventorySha256"])
    path = corepack.RECORD.with_name("corepack-source.tar.gz")
    retained = candidate.checked_bytes(path, review["sourceFixtureSha256"])
    with tarfile.open(fileobj=io.BytesIO(retained), mode="r|*") as archive:
        rows, contents = corepack.scan(archive, "deps/", "lib/node_modules/")
    inventory = corepack.trusted_review()
    corepack.check_files(rows, inventory, source_only=True)
    corepack.check_review(inventory, contents)
    regions_path = corepack.RECORD.with_name("regions.json.gz")
    compressed_regions = candidate.checked_bytes(regions_path, review["regionsFixtureSha256"])
    regions = gzip.decompress(compressed_regions)
    check_review(review, load_inputs(review), contents[corepack.BUNDLE], json.loads(regions))


def main(arguments):
    try:
        if len(arguments) != 2:
            raise ValueError("Pass candidate and upstream evidence directories")
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            check_evidence(Path(arguments[0]).resolve(), Path(arguments[1]).resolve())
        print("PASS ms 2.1.3: exact module transformation and complete attributed MIT terms")
        print("PARTIAL distribution and remaining grants BLOCKED; image promotion still refuses")
    except (Exception, SystemExit):
        # Withhold parser, archive and dependency output, including private paths.
        print(REFUSAL, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
