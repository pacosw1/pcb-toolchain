# KiCad runtime probe

`iotroute runtime-probe CONFIG.json BOARD.kicad_pcb NEW_OUTDIR` measures a runtime on an isolated project copy.
It is a diagnostic command; every result has `acceptance: false`. It does not select the runtime for normal routing,
change the job image, install software, or qualify a board.

Run it in a bounded Linux/Hetzner job using the existing pinned hybrid image. Its stable KiCad 10 CLI and pinned nightly
CLI coexist. The input is copied with its project/schematic/rule sidecars; an existing output path is refused. The probe
hashes the source project before/after and keeps output and logs under the new directory.

```
iotroute runtime-probe tools/kicad-runtime-probe.stable.json INPUT.kicad_pcb /work/probe-stable
iotroute runtime-probe tools/kicad-runtime-probe.nightly.json INPUT.kicad_pcb /work/probe-nightly
```

The config accepts `runtime` (`stable`, the default, or explicit `nightly`), `stable_cli`, `nightly_cli`, and `repeats`
(1-10, default 3). Unknown keys or runtimes are errors. CLI paths are passed as executable arguments, without a shell.
Nightly IPC checks its version against the pinned protobuf commit before making typed board calls.

Stable mode measures cold SVG export and CLI DRC with parity. Nightly mode additionally measures:

- A persistent headless server, full native board reads, and fresh `board-json` CLI reads of the same copy.
- A one-nanometre pending track-width edit, the modified item returned by the API, and exact restoration after dropping
  the transaction. The pending edit is not committed or saved.
- SVG export and zone refill through IPC.
- A new nightly-saved copy and an attempted stable CLI reopen, with the error and files retained.

The board-value comparison sorts only group member IDs, which are unordered membership sets. Polygon point order and
other geometry remain significant. Raw value hashes/files are retained alongside comparable hashes. The SVG comparison
in the measured report excludes title metadata only and uses the same layer, page size, full drill marks and precision.

Current production readers already use pinned nightly IPC in Rust; `KICAD_API_CLI` still selects that reader executable.
Stable `KICAD_CLI` still handles saved boards and acceptance. This probe's config is separate from those production roles.
The tested nightly save upgrades the format beyond what stable 10.0.6 can open, so it is unsuitable for canonical saves.

See [the measured capability and compatibility report](router/reports/2026-11-05-nightly-ipc.md) and its raw evidence.
