#!/bin/sh
# Build a pcb-toolchain release bundle: dist/pcb-toolchain-VERSION.tar.gz + SHA256SUMS. Never publishes.
#   scripts/build-bundle.sh VERSION [--linux]
# --linux also builds iotroute, iotplace and route-coverage for linux-x86_64 on BUILD_LINUX_HOST (user@host with Docker).
set -eu
here=$(cd "$(dirname "$0")/.." && pwd -P)
version=${1:?usage: build-bundle.sh VERSION [--linux]}
linux=${2:-}
if [ $# -gt 2 ]; then echo 'usage: build-bundle.sh VERSION [--linux]' >&2; exit 2; fi
case "$linux" in ''|--linux) ;; *) echo 'usage: build-bundle.sh VERSION [--linux]' >&2; exit 2 ;; esac
sha=$(git -C "$here" rev-parse HEAD)
[ -z "$(git -C "$here" status --porcelain)" ] || { echo 'FAIL: working tree not clean' >&2; exit 2; }
name="pcb-toolchain-$version"
stage=$(mktemp -d)
out="$stage/$name"
mkdir -p "$out/bin" "$here/dist"
echo "START: copy tool tree"
(cd "$here" && git archive --format=tar HEAD tools bin) | tar -x -C "$out"
echo "$version $sha" > "$out/VERSION"
mkdir -p "$out/tools/pcb-job"                                          # tools/remote.sh submits to the job daemon with this client
(cd "$here" && git archive --format=tar HEAD apps/job-daemon/src/client.ts apps/job-daemon/src/types.ts) | tar -x -C "$out/tools/pcb-job" --strip-components=3
echo "START: iotroute darwin-arm64"
(cd "$here/tools/router/core" && RUSTFLAGS="--remap-path-prefix=$HOME=~ --remap-path-prefix=$here=." cargo build --release --locked --quiet)   # no build-machine paths in the binary
cp "$here/tools/router/core/target/release/iotroute" "$out/bin/iotroute-darwin-arm64"
echo "START: iotplace darwin-arm64"
(cd "$here/tools/placer/core" && RUSTFLAGS="--remap-path-prefix=$HOME=~ --remap-path-prefix=$here=." cargo build --release --locked --quiet)
cp "$here/tools/placer/core/target/release/iotplace" "$out/bin/iotplace-darwin-arm64"
if [ "$linux" = --linux ]; then
  linux_host=${BUILD_LINUX_HOST:?set BUILD_LINUX_HOST=user@host (Docker) for --linux}
  # Bookworm's glibc 2.36 works both in the bookworm CI image and in the newer route image.
  linux_builder=rust:1.93.1-bookworm
  echo "START: iotroute linux-x86_64 ($linux_host)"
  rsrc=$(ssh "$linux_host" 'mktemp -d /tmp/iotroute-src.XXXXXX')
  # root-owned build output (target/) may block a plain rm; then clean up inside the rust image as root
  clean_linux() { ssh "$linux_host" "rm -rf '$rsrc' 2>/dev/null || { docker run --rm -v '$rsrc:/src' rust:1.93.1 sh -c 'rm -rf /src/* /src/.[!.]*'; rm -rf '$rsrc'; }" || echo "WARN: could not remove $rsrc on $linux_host" >&2; }
  trap clean_linux EXIT
  (cd "$here/tools/router/core" && git archive --format=tar HEAD .) | ssh "$linux_host" "tar -x -C '$rsrc'"
  ssh "$linux_host" "docker run --rm --cpus=2 --memory=4g -e RUSTFLAGS='--remap-path-prefix=/src=.' -v '$rsrc:/src' -w /src $linux_builder cargo build --release --locked --quiet"
  scp -q "$linux_host:$rsrc/target/release/iotroute" "$out/bin/iotroute-linux-x86_64"
  clean_linux
  echo "START: iotplace linux-x86_64 ($linux_host)"
  rsrc=$(ssh "$linux_host" 'mktemp -d /tmp/iotplace-src.XXXXXX')
  # iotplace links the iotroute library by path: both crates go, at their place in the tree
  (cd "$here" && git archive --format=tar HEAD tools/placer/core tools/router/core) | ssh "$linux_host" "tar -x -C '$rsrc'"
  ssh "$linux_host" "docker run --rm --cpus=2 --memory=4g -e RUSTFLAGS='--remap-path-prefix=/src=.' -v '$rsrc:/src' -w /src/tools/placer/core $linux_builder cargo build --release --locked --quiet"
  scp -q "$linux_host:$rsrc/tools/placer/core/target/release/iotplace" "$out/bin/iotplace-linux-x86_64"
  clean_linux
  echo "START: route-coverage linux-x86_64 ($linux_host)"
  rsrc=$(ssh "$linux_host" 'mktemp -d /tmp/route-coverage-src.XXXXXX')
  (cd "$here" && git archive --format=tar HEAD tools/route-coverage tools/router/core) | ssh "$linux_host" "tar -x -C '$rsrc'"
  ssh "$linux_host" "docker run --rm --cpus=2 --memory=4g -e RUSTFLAGS='--remap-path-prefix=/src=.' -v '$rsrc:/src' -w /src/tools/route-coverage $linux_builder cargo build --release --locked --quiet"
  scp -q "$linux_host:$rsrc/tools/route-coverage/target/release/route-coverage" "$out/bin/route-coverage-linux-x86_64"
  clean_linux
  trap - EXIT
fi
echo "START: manifest"
node "$here/scripts/write-bundle-manifest.mjs" "$out" "$version" "$sha"
COPYFILE_DISABLE=1 tar --no-xattrs -C "$stage" -czf "$here/dist/$name.tar.gz" "$name"   # macOS tar otherwise adds ._* files, visible only on Linux
got=$(gzip -dc "$here/dist/$name.tar.gz" | LC_ALL=C grep -a -c "/\._" || true)
[ "$got" = 0 ] || { echo "FAIL: $got ._ entries in the bundle" >&2; exit 1; }
(cd "$here/dist" && { grep -v "  $name.tar.gz\$" SHA256SUMS 2>/dev/null; shasum -a 256 "$name.tar.gz"; } > SHA256SUMS.new && mv SHA256SUMS.new SHA256SUMS && tail -1 SHA256SUMS)   # a rebuild replaces its line
rm -rf "$stage"
echo "PASS: dist/$name.tar.gz"
