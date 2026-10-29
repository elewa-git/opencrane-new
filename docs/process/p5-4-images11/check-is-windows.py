"""Check one dependency's complete grant and exact source transformation."""

import contextlib
import gzip
import hashlib
import importlib.util
import io
import json
import sys
import tarfile
from pathlib import Path

REFUSAL = "FAIL is-windows grant evidence is missing, changed or unsupported"
RECORD = Path(__file__).with_name("grant.json")
REVIEW_SHA256 = "2795f034c0e9cd4c4c5b56aec386562b8828bb43b40ad158d5e116b9bb6fa60b"
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
    notice, body = source_text.split("\n\n", 1)
    body = body.replace("'", '"')
    body = body.replace("exports && typeof exports", "exports2 && typeof exports2")
    body = body.replace("typeof module ", "typeof module2 ")
    body = body.replace("module.exports", "module2.exports")
    body = body.replace("function isWindows()", "function isWindows4()")
    lines = body.splitlines()
    indented = []
    for line in lines:
        indented.append("    " + line)
    wrapped = (f"// {label}\nvar require_is_windows = __commonJS({{\n"
               f'  "{label}"(exports2, module2) {{\n')
    wrapped += "\n".join(indented) + "\n  }\n});\n\n"
    lifted_start = notice.replace("/*!", "(*!")
    lifted = lifted_start.replace(" */", " *)")
    attribution = "is-windows/index.js:\n"
    for line in lifted.splitlines():
        attribution += "  " + line + "\n"
    return wrapped.encode(), attribution.encode()


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
        if row[0] == "is-windows":
            modules.append(row)
    if modules != [review["module"]]:
        raise ValueError("Require exactly one original dependency row")
    matching = []
    for row in regions:
        if row[2].endswith("/is-windows/index.js"):
            matching.append(row)
    if matching != [review["range"]]:
        raise ValueError("Require the exact module range once")
    start, end, label, _ = review["range"]
    transformed, attribution = transform_source(inputs["index.js"], label)
    # Compare the transformation itself; labels and licence names prove no ancestry.
    if bundle[start:end] != transformed:
        raise ValueError("Unsupported dependency transformation")
    start, end = review["inlineRange"][:2]
    inline = bundle[start:end]
    if inline.count(attribution) != 1 or not inline.endswith(attribution + b"*/\n"):
        raise ValueError("The original inline attribution changed")
    return "is-windows 1.0.2: MIT"


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
    compressed_regions = regions_path.read_bytes()
    regions = gzip.decompress(compressed_regions)
    check_review(review, load_inputs(review), contents[corepack.BUNDLE], json.loads(regions))


def main(arguments):
    try:
        if len(arguments) != 2:
            raise ValueError("Pass candidate and upstream evidence directories")
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            check_evidence(Path(arguments[0]).resolve(), Path(arguments[1]).resolve())
        print("PASS is-windows 1.0.2: exact module transformation, attribution and complete MIT terms")
        print("PARTIAL distribution and remaining grants BLOCKED; image promotion still refuses")
    except Exception:
        # Withhold parser, archive and dependency output, including private paths.
        print(REFUSAL, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
