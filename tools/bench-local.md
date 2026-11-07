# Running a bench suite on this Mac

`tools/BENCH.md` describes the suite and the statistics. This is how to run one locally, and the CPU lock that keeps benchmark
runs on one Mac from sharing cores.

## The lock

`bench run` takes a machine-wide lock before the first trial and frees it when the run ends (also on SIGINT/SIGTERM):
`<system temp dir>/opencode/bench.lock` (override with `BENCH_LOCK`), a directory made with `mkdir`
that holds `owner.json` (pid, start time, label `bench SUITE -> OUT`, cwd).

- Held by a live process: `bench run` stops and names the holder. `--wait` queues behind it (polls every 5 s, prints the holder once).
- The owner's pid is gone (crash, `kill -9`): the lock is stale and the next run takes it over.
- `--no-lock` skips it. Use it only when you know nothing else is running. `analyze` and `compare` need no lock.
- `cat $LOCK/owner.json` shows who runs now. Never delete a live holder's lock.

## What a local run needs

A scratch project, never a lab checkout: `git -C ~/Documents/iot-lab archive origin/main hardware-design/boards/ENV-SENSE hardware-design/boards/RELAY-4 | tar -x -C SCRATCH`
(the suite needs a development and a holdout board), plus `rsync -a --exclude node_modules --exclude target tools/ SCRATCH/tools/`
and `SCRATCH/bin/` with the darwin binaries (`iotroute-darwin-arm64`, `iotplace-darwin-arm64`) of an installed toolchain
(`~/.local/share/pcb-toolchain/VERSION/bin`). Leave out `toolchain.lock`, or `bin/pcb` wants the pinned release. Then:

```sh
export IOT_LAB=SCRATCH IOTROUTE_BIN=SCRATCH/bin/iotroute-darwin-arm64 JOBD_URL= REMOTE_NO_DAEMON=1 PATH=/opt/homebrew/bin:$PATH
shasum -a 256 SCRATCH/hardware-design/boards/*/cad/*/*.kicad_pcb        # pin these in the suite
tools/pcb bench plan SUITE.json
tools/pcb bench run SUITE.json --out SCRATCH/out1 --root SCRATCH [--wait]
```

Trials run with SCRATCH as the working directory, so arms say `tools/pcb ...` and `--spec` paths relative to it.
Two arms that differ in effort (timeout, iterations) are refused by the evaluator as `unequal_case_or_execution`: change the
spec or the placement, not the budget.

## Routing locally: the route image under emulation

A route needs `kicad-cli-nightly` (the pinned KiCad nightly 10.99 with the IPC API). It exists only in image
`iot-lab-route:10.0-nightly-4fe1ca2060`; the PPA keeps no old builds. Copy that image to this Mac once (about 1.35 GB compressed,
3.9 GB loaded), then run each arm inside it with `tools/bench-in-route.sh`:

```sh
ssh HOST "docker save iot-lab-route:10.0-nightly-4fe1ca2060 | gzip -1" | gunzip | docker load
export BENCH_TOOLCHAIN=~/.local/share/pcb-toolchain/0.2.15/bin
# arm: ["tools/bench-in-route.sh", ".", "tools/pcb", "route", "{board}", "--router", "iotroute", "--timeout", "{timeout_s}", "--json"]
```

The container gets the project at the same path, the toolchain's Linux node/iotroute/iotplace, kicad-happy read-only, no network,
`BENCH_CPUS`/`BENCH_MEM` (default 2 CPUs, 4 GB). Measured 2026-11-06 on an M-series Mac: an ENV-SENSE `pcb route --router iotroute`
took 65 s and a fresh `pcb check` 10 s. Emulation is slower than the Hetzner box, so compare arms only within one machine; never
compare a local result with a Hetzner result.

## Which "verified"

That first local ENV-SENSE route had native DRC 0, unconnected 0, parity 0, but the full gate failed: rerouting made the board's
kicad-happy exemption RP-001 stale. The canonical board passes the gate. So a suite may set `"metric": "native"` to count native
DRC/unconnected/parity 0 (what the placer reports call verified); the default `"gate"` counts only a full configured-gate pass. The
result always reports the other metric too, as `secondary`.

## Earlier limit (2026-11-06, before the image copy): no local route

A route needs `kicad-cli-nightly` (the pinned KiCad nightly with the IPC API, built into image `iot-lab-route:10.0-nightly-4fe1ca2060`
on the Hetzner box; the PPA keeps no old builds). The Mac has only KiCad 10.0.6, so `iotroute run` stops at
`iotroute model on --lock-from failed` (a sealed, failed run), and the daemon path is not used here. Locally, a bench run proves the
runner, the run records, the evaluator and the lock, but not a verified route: every trial is a failure until the nightly image exists
on this machine. `REMOTE_NO_DAEMON=1` is what makes `pcb route` try the local path at all.
