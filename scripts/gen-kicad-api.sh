#!/bin/sh
# Generate the Rust code of the KiCad API protos: tools/router/core/proto -> tools/router/core/src/kicad/api/proto.
# Only needed when the protos change, so normal builds need no protoc. Runs in the rust image on a Docker host.
#   BUILD_LINUX_HOST=user@host scripts/gen-kicad-api.sh
set -eu
here=$(cd "$(dirname "$0")/.." && pwd -P)
host=${BUILD_LINUX_HOST:?set BUILD_LINUX_HOST=user@host (Docker)}
core=$here/tools/router/core
work=$(ssh "$host" 'mktemp -d /tmp/kicad-api-gen.XXXXXX')
trap 'ssh "$host" "docker run --rm -v $work:/w rust:1.93.1 sh -c \"rm -rf /w/*\"; rm -rf $work"' EXIT
COPYFILE_DISABLE=1 tar --no-xattrs -C "$core" -cf - proto | ssh "$host" "tar -x -C $work"
ssh "$host" "mkdir -p $work/gen/src && cat > $work/gen/Cargo.toml" <<'EOF'
[package]
name = "gen"
version = "0.1.0"
edition = "2024"

[dependencies]
prost-build = "0.14"
EOF
ssh "$host" "cat > $work/run.sh" <<'EOF'
set -eu
apt-get update -qq && apt-get install -y -qq protobuf-compiler >/dev/null
mkdir -p /w/out
cd /w/gen && cargo run --quiet
EOF
ssh "$host" "cat > $work/gen/src/main.rs" <<'EOF'
use std::path::PathBuf;

fn protos(dir: PathBuf, out: &mut Vec<PathBuf>) {
    for entry in std::fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            protos(path, out);
        } else if path.extension().is_some_and(|e| e == "proto") {
            out.push(path);
        }
    }
}

fn main() {
    let mut files = Vec::new();
    protos("/w/proto".into(), &mut files);
    files.sort();
    prost_build::Config::new()
        .out_dir("/w/out")
        .enable_type_names()
        .include_file("mod.rs")
        .compile_protos(&files, &["/w/proto"])
        .unwrap();
}
EOF
ssh "$host" "docker run --rm -v $work:/w rust:1.93.1 sh /w/run.sh"
rm -rf "$core/src/kicad/api/proto"
mkdir -p "$core/src/kicad/api/proto"
ssh "$host" "tar -C $work/out -cf - ." | tar -x -C "$core/src/kicad/api/proto"
ls "$core/src/kicad/api/proto"
