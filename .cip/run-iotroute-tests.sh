#!/bin/sh
# The TS tests that drive the real iotroute binary (flock, the shared clock). tools-unit has node but no cargo, so they
# skip there; this job builds the binary from this commit and runs them, with a pinned node in the rust image.
# A test joins by testing iotrouteMissing. Ends with one PASS/FAIL line.
set -eu
cd "$(dirname "$0")/.."
version=v22.23.4
sum=1805bcd35e6815559bd2eb97db438d3fdb0eb3a5e6a977b7c1badca76337e9ce
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
curl -fsSL "https://nodejs.org/dist/$version/node-$version-linux-x64.tar.xz" -o "$work/node.tar.xz"
echo "$sum  $work/node.tar.xz" | sha256sum -c --quiet -
tar -xJf "$work/node.tar.xz" -C "$work" --strip-components=1
export PATH="$work/bin:$PATH"
cargo build --release --locked --quiet --manifest-path tools/router/core/Cargo.toml
export IOTROUTE_BIN="$PWD/tools/router/core/target/release/iotroute"
tests=$(grep -l iotrouteMissing tools/lib/*.test.ts)
if "$work/bin/node" --experimental-strip-types --no-warnings --test $tests; then
  echo "PASS: iotroute tests: $(echo $tests | wc -w) files"
else
  echo "FAIL: iotroute tests"
  exit 1
fi
