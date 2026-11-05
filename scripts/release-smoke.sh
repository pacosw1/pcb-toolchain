#!/bin/sh
# One small board through a toolchain build before a project bumps its lock: a throwaway copy of ENV-SENSE on the Linux host, the bundle
# synced into it as a real install, tools/pcb_workflow_smoke.ts in the scratch image. The source project is only read; its hashes are
# compared before and after. Never publishes, never touches a production image. The last line is one PASS, FAIL or STUCK. Each step prints
# STEP START and STEP PASS or FAIL with its seconds, on stdout and in $base/progress.log on the host; a RUNNING line every 20 s between them.
#
#   scripts/release-smoke.sh --bundle dist/pcb-toolchain-X.tar.gz [options]   a bundle with its Linux binaries (build-bundle.sh --linux)
#   scripts/release-smoke.sh --ref origin/main [options]                      the tools of REF, Linux binaries built on the host
#   scripts/release-smoke.sh --build-image                                    one-off: builds the scratch image on the host
#
# Options: --project DIR (IOT_LAB, else ~/code/iot-lab)  --host USER@HOST  --skip-step STAGE (repeatable; never silent)  --keep
#          --patch-copy: on the throwaway copy only, closes the known project gaps of a lock bump (always printed; see pcb_workflow_smoke.ts)
set -eu
here=$(cd "$(dirname "$0")/.." && pwd -P)
host=${RELEASE_SMOKE_HOST:-root@100.93.34.43}
base=/var/lib/docker/pcb-release-smoke
image=pcb-release-smoke:test
fastroute=/srv/iot-lab-route/fastroute/fastroute-0.1.7-linux-x64/fastroute
builder=rust:1.93.1-bookworm
board=ENV-SENSE
project=${IOT_LAB:-$HOME/code/iot-lab}
bundle='' ref='' skips='' keep='' build_image=''
progress=$base/progress.log
started=$(date +%s)
stage='' stage_at=0 heart=''
state=$(mktemp)
say() {
  line="$(date -u +%H:%M:%S) $*"
  echo "$line"
  printf '%s\n' "$line" | ssh "$host" "cat >> $progress" 2>/dev/null || true
}
ended() { [ -z "$stage" ] || say "STEP PASS $stage $(( $(date +%s) - stage_at )) s"; stage=''; }
begin() { ended; stage=$1; stage_at=$(date +%s); printf '%s %s\n' "$stage_at" "$1" > "$state"; say "STEP START $1"; }
# Steps here run for minutes without a word of their own: the 20 s beat runs beside them. The smoke has its own.
heartbeat() {
  ( while sleep 20; do read -r at name < "$state" && say "RUNNING: $name for $(( $(date +%s) - at )) s"; done ) &
  heart=$!
}
quiet() { if [ -n "$heart" ]; then pkill -P "$heart" 2>/dev/null || true; kill "$heart" 2>/dev/null || true; heart=''; fi; }
stuck() {
  quiet
  [ -z "$stage" ] || say "STEP FAIL $stage $(( $(date +%s) - stage_at )) s: $2"
  echo "STUCK: step $1: $2"
  exit 2
}
while [ $# -gt 0 ]; do
  case "$1" in
    --bundle) bundle=${2:?}; shift 2 ;;
    --ref) ref=${2:?}; shift 2 ;;
    --project) project=${2:?}; shift 2 ;;
    --host) host=${2:?}; shift 2 ;;
    --skip-step) skips="$skips --skip-step ${2:?}"; shift 2 ;;
    --patch-copy) skips="$skips --patch-copy"; shift ;;
    --keep) keep=1; shift ;;
    --build-image) build_image=1; shift ;;
    *) stuck arguments "unknown option $1" ;;
  esac
done

if [ -n "$build_image" ]; then
  ssh "$host" "mkdir -p $base/image && cp $fastroute $base/image/fastroute" || stuck image "no Linux fastroute at $fastroute on $host"
  scp -q "$here/tools/release-smoke.Dockerfile" "$host:$base/image/Dockerfile"
  ssh "$host" "docker build --pull=false -q -t $image $base/image && rm -rf $base/image" || stuck image 'docker build failed'
  echo "PASS: image $image on $host"
  exit 0
fi
[ -n "$bundle$ref" ] && [ -z "$bundle" -o -z "$ref" ] || stuck arguments 'give --bundle FILE or --ref GITREF'
[ -d "$project/hardware-design/boards/$board" ] || stuck arguments "no $board in $project"
ssh "$host" "mkdir -p $base && touch $progress && chmod 666 $progress" || stuck host "$host is not reachable"
ssh "$host" "docker image inspect $image >/dev/null" 2>/dev/null || stuck image "no $image on $host: run scripts/release-smoke.sh --build-image"

# The source project as hashes: the board, the tools and the lock.
source_hash() {
  (cd "$project" && find "hardware-design/boards/$board" tools toolchain.lock -name .gate -prune -o -name __pycache__ -prune -o -type f -print | LC_ALL=C sort | tr '\n' '\0' | xargs -0 shasum -a 256 | shasum -a 256)
}
before=$(source_hash)
run=$base/run-$(date +%s)-$$
cleanup() { quiet; rm -f "$state"; [ -n "$keep" ] || ssh "$host" "rm -rf $run"; }
trap cleanup EXIT
heartbeat
ssh "$host" "mkdir -p $run/toolchain $run/project $run/work"

begin toolchain_build
if [ -n "$bundle" ]; then
  [ -f "$bundle" ] || stuck toolchain "no bundle $bundle"
  scp -q "$bundle" "$host:$run/bundle.tar.gz"
  ssh "$host" "tar -xzf $run/bundle.tar.gz -C $run/toolchain --strip-components=1 && rm $run/bundle.tar.gz"
else
  sha=$(git -C "$here" rev-parse "$ref") || stuck toolchain "no ref $ref"
  git -C "$here" archive --format=tar "$sha" tools bin | ssh "$host" "tar -x -C $run/toolchain"
  git -C "$here" archive --format=tar "$sha" apps/job-daemon/src/client.ts apps/job-daemon/src/types.ts | ssh "$host" "mkdir -p $run/toolchain/tools/pcb-job && tar -x --strip-components=3 -C $run/toolchain/tools/pcb-job"
  ssh "$host" "cd $run && docker run --rm --cpus=8 --memory=12g -e CARGO_HOME=$base/cargo -e CARGO_TARGET_DIR=/t -e RUSTFLAGS=--remap-path-prefix=/w=. -v $run/toolchain:/w -v $base/cargo:$base/cargo $builder sh -c 'cd /w/tools/router/core && cargo build --release --locked --quiet && cp /t/release/iotroute /w/bin/iotroute-linux-x86_64 && cd /w/tools/route-coverage && cargo build --release --locked --quiet && cp /t/release/route-coverage /w/bin/route-coverage-linux-x86_64'" || stuck toolchain 'Linux binaries of the ref did not build'
  ssh "$host" "echo '0.0.0-smoke $sha' > $run/toolchain/VERSION"
fi
ssh "$host" "test -x $run/toolchain/bin/iotroute-linux-x86_64 && test -x $run/toolchain/bin/route-coverage-linux-x86_64" || stuck toolchain 'the build has no bin/iotroute-linux-x86_64 or bin/route-coverage-linux-x86_64: build-bundle.sh --linux'

begin copy_of_project
# What a board snapshot reads: the board, the shared registry without its bulk, the datasheets the board's schematic names, and the
# evidence the driver tables of the build name.
list=$(mktemp)
ssh "$host" "node -e \"for(const n of ['edge-rates','driver-edges','pin-ratings'])for(const e of JSON.parse(require('fs').readFileSync('$run/toolchain/tools/'+n+'.json')).evidence_files??[]){console.log(e.path);if(e.path.endsWith('.pdf'))console.log(e.path+'.source.json')}\"" > "$list.names" || stuck copy 'driver evidence list of the build is not readable'
sed -n 's/.*(property "Datasheet" "\([^"]*\.pdf\)".*/\1/p' "$project/hardware-design/boards/$board/cad/$board/$board.kicad_sch" | sed 's|.*/||; s|^|hardware-design/registry/datasheets/|' >> "$list.names"
sort -u "$list.names" | while read -r f; do if [ -f "$project/$f" ]; then echo "$f"; fi; done > "$list"
rm -f "$list.names"
rsync -a --exclude=__pycache__ --exclude=.gate --exclude='*.pyc' --exclude=registry/evidence --exclude=registry/datasheets --exclude=hardware-design/enclosure --exclude=hardware-design/reports \
  --include=/tools/*** --include=/AGENTS.md --include=/CLAUDE.md --include=/toolchain.lock --include=/hardware-design/ --include=/hardware-design/boards/ --include="/hardware-design/boards/$board/***" \
  --exclude='/hardware-design/boards/*' --include='/hardware-design/**' --exclude='/*' "$project/" "$host:$run/project/"
rsync -a --files-from="$list" "$project/" "$host:$run/project/"
rm -f "$list"

ended
quiet
say 'STEP START smoke'
# No network: the image holds everything a release runs, so a pass cannot lean on a service.
code=0
# ssh joins its arguments into one remote command line: the options go last, as words.
ssh "$host" sh -s -- "$run" "$image" "$board" "$progress" $skips <<'REMOTE' || code=$?
set -eu
run=$1 image=$2 board=$3 progress=$4
shift 4
skips=$*
version=$(cut -d' ' -f1 "$run/toolchain/VERSION")
sed -i "s/\"version\": \"[^\"]*\"/\"version\": \"$version\"/" "$run/project/toolchain.lock"   # the bump the project would make
chmod -R a+rX "$run/toolchain"
chown -R 1000:1000 "$run/project" "$run/work"
entry="/toolchain/bin/pcb --project /work/project toolchain-sync && exec node --experimental-strip-types --no-warnings /toolchain/tools/pcb_workflow_smoke.ts --project /work/project --board $board --output /work/run/smoke --timeout 600 --progress /work/progress.log $skips"
id=$(docker create --network none --cpus 8 --memory 16g -v "$run/toolchain:/toolchain:ro" -v "$run/project:/work/project" -v "$run/work:/work/run" -v "$progress:/work/progress.log" \
  -e PCB_TOOLCHAIN_ROOT=/toolchain -e IOTROUTE_BIN=/toolchain/bin/iotroute-linux-x86_64 -w /work/run --entrypoint sh "$image" -c "$entry")
code=0
docker start -a "$id" || code=$?
docker rm -f "$id" >/dev/null
exit "$code"
REMOTE

after=$(source_hash)
verdict=$(ssh "$host" "node -p \"const s=JSON.parse(require('fs').readFileSync('$run/work/smoke/summary.json'));const step=s.not_executed[0]??'';s.verdict+': '+(step&&'step '+step+': ')+s.cases.length+'/'+s.expected_cases.length+' cases; '+s.cause+(s.skipped?'; skipped '+s.skipped_steps.map(r=>r.stage).join(','):'')+(s.copy_patches.length?'; copy patched: '+s.copy_patches.length:'')\"" 2>/dev/null) || verdict="STUCK: step smoke: no summary.json (container exit $code)"
[ "$before" = "$after" ] || { say "STEP FAIL source_project_unchanged: $project changed during the smoke"; echo "FAIL: step source_project_unchanged: $project changed during the smoke"; exit 1; }
say "$verdict; source hashes unchanged; wall $(( $(date +%s) - started )) s"
echo "$verdict; source hashes unchanged; wall $(( $(date +%s) - started )) s"
exit "$code"
