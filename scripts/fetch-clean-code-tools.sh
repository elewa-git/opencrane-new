#!/bin/sh

set -eu

destination=.tools/clean-code
export PIP_CACHE_DIR="$PWD/$destination/cache/pip"
export PIP_DISABLE_PIP_VERSION_CHECK=1
download_dir=$(mktemp -d "${TMPDIR:-/tmp}/opencrane-clean-code.XXXXXX")
trap 'rm -rf "$download_dir"' EXIT HUP INT TERM
mkdir -p "$destination"

verify_checksum() {
  checksum=$1
  archive=$2
  if command -v sha256sum >/dev/null 2>&1; then
    printf '%s  %s\n' "$checksum" "$archive" | sha256sum -c -
  else
    printf '%s  %s\n' "$checksum" "$archive" | shasum -a 256 -c -
  fi
}

fetch_tool() {
  tool=$1
  commit=$2
  checksum=$3
  archive=$download_dir/$tool.tar.gz
  curl --fail --location --retry 3 \
    "https://codeload.github.com/unclebob/$tool/tar.gz/$commit" --output "$archive"
  verify_checksum "$checksum" "$archive"
  tar -xzf "$archive" -C "$download_dir"
  # Verify every archive even when a previous installation exists.
  rm -rf "${destination:?}/$tool"
  mv "$download_dir/$tool-$commit" "$destination/$tool"
}

fetch_tool crapper c757ec79a6c15dc815238bbd9c2f4601eb54d3cc \
  9d807c02d171fc263e9b72db991ee1b09fc5efe04b4d9a3c80287ac5cfcda29c
fetch_tool dryer 66ff6d21a42c04afcad89c78a80066176d1294b0 \
  94609c58e1d35a74fba0f9b9385deddbd824d4cb00aa8c842436423eae20f62e
fetch_tool mutator 830ec7e9c39664d753f8699015bc796df67727b9 \
  77242e169942bc2ccf762b36d18d14a679cd0f114ebb82258b0a9018469e5b1b

# Bootstrap pinned pip inside the venv, including hosts without ensurepip.
python3 -m venv --without-pip "$destination/venv"
pip_wheel=$download_dir/pip-25.1.1-py3-none-any.whl
curl --fail --location --retry 3 \
  https://files.pythonhosted.org/packages/29/a2/d40fb2460e883eca5199c62cfc2463fd261f760556ae6290f88488c362c0/pip-25.1.1-py3-none-any.whl \
  --output "$pip_wheel"
verify_checksum 2913a38a2abf4ea6b64ab507bd9e967f3b53dc1ede74b01b0931e1ce548751af "$pip_wheel"
PYTHONPATH="$pip_wheel" "$destination/venv/bin/python" -m pip install \
  --only-binary=:all: --no-deps -r scripts/clean-code-requirements.txt
"$destination/venv/bin/python" -m pip install --no-build-isolation --no-deps \
  "$destination/crapper" "$destination/dryer" "$destination/mutator"
"$destination/venv/bin/python" -m pip check
