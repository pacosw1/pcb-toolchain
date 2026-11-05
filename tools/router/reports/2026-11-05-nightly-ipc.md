# Pinned KiCad nightly headless IPC and runtime config (#1326)

**Headless Rust IPC works for reads, transactional edits, refill and SVG export. It cannot replace the stable save and
acceptance path:** the pinned protocol has no DRC/ERC/parity execution request, and a nightly-saved board is rejected by
stable KiCad 10.0.6. Production defaults and images stay unchanged; all measurements here are explicitly non-acceptance.

The earlier task notes predate the Python-to-Rust port. Current main already has a typed Rust protobuf/NNG client and
uses pinned nightly IPC for native board reads. Normal writes/refill/DRC remain on stable KiCad 10. The new
`runtime-probe` command adds a config-driven, copy-only experiment with stable mode as its default and nightly as explicit
opt-in. It does not switch normal job routing or introduce nightly board acceptance.

## Tested input and identities

One frozen ENV-SENSE project, not canonical CAD, on Hetzner `gopadel-ci1`, outside CI. Source base
`fc2934e4faeeae785fcc17b57ee2911bba55e556`; source PCB SHA-256
`b4bb4a9d759a5d6b9425127ca1a378b48f97e2c8b0b69cf0fa4d221bf2bce0f4`.
The complete source project hashes match before and after both profiles. Runs use two CPUs, 4 GiB, network disabled,
and the existing image `iot-lab-route:10.0-nightly-4fe1ca2060`, ID
`sha256:8c1c6d83c4050f4876f21926846e4e1d640b6be5194f448c3e239392c83a20af`.

| Component | Tested identity |
| --- | --- |
| Stable CLI | 10.0.6 |
| Nightly API | `10.99.0-unknown-4fe1ca2060~190~ubuntu24.04.1` |
| API/protobuf pin | `4fe1ca20605d722a8972dabe11b4a90fc6b3d879` |
| Rust probe binary | SHA-256 `b7f955ee4dfd10415733f1806c25f267789fa2b3045bce2e7c46e0ca783d2cb2` |
| Build | `rust:1.93.1-bookworm`, release/locked |

The installed image is hybrid. `import pcbnew` succeeds but reports **stable 10.0.6** at
`/usr/lib/python3/dist-packages/pcbnew.py`. The extracted nightly prefix contains `pcbnew` and `_pcbnew.kiface`, without
a Python `pcbnew` module. Import success therefore does not prove nightly SWIG support. The live IPC probe is Rust;
it uses neither a Python client nor the removed `model.py`/`write.py`. The presence check itself ran remotely, and no
Python implementation/file was added.

## Capability matrix

| Step | Pinned headless IPC | Measured result / boundary |
| --- | --- | --- |
| Start and open real board | yes | 0.1606 s startup; 23 footprints, 283 copper items, 6 zones, 11 nets |
| Native whole-board read | yes | Three warm reads match three cold CLI reads after membership normalization |
| Edit items and drop transaction | yes | Modified width returned, original item restored exactly; 0.0427 s |
| Refill zones | yes | Synchronous headless request completed; 0.0335 s |
| SVG export | yes | `JS_SUCCESS`, output exists and matches CLI SVG apart from title metadata |
| Other export jobs | declared, not executed here | STEP/Gerber/drill/etc. requests exist in pinned `board_jobs.proto`; no blanket runtime claim |
| Run DRC / ERC / schematic parity | no execution request in pinned protocol | Marker/error-injection messages are not a DRC runner; these checks remain CLI operations |
| Save a new board copy | yes | Copy is written, but upgraded format is incompatible with stable 10.0.6 |

The edit changes a width by 1 nm only inside a pending transaction on the owned copy. `UpdateItems` returns that modified
item, and `EndCommit(CMA_DROP)` restores the original protobuf item exactly. It is not a saved electrical edit.
The export precedes refill, so the cold/warm SVG comparison sees the same fills. Refill and save compatibility are
separate diagnostic operations.

## Cold and warm measurements

Each whole-board read includes native geometry and via-type reads, with the same board-value contents. Cold CLI
`board-json` includes process/server startup, file hashes and JSON output; warm reads reuse one server and serialize the
returned value. This measures the current CLI boundary versus a persistent-client path, not a pure transport microbench.

| Operation | Samples / seconds | Summary |
| --- | --- | --- |
| Nightly cold full-board CLI read | 0.3654, 0.3694, 0.3613 | median 0.3654 |
| Nightly warm full-board IPC read | 0.2001, 0.1955, 0.1957 | median 0.1957 |
| Nightly cold CLI SVG | 0.2112, 0.2093, 0.2044 | median 0.2093 |
| Nightly warm IPC SVG | 0.0597 | one sample only |
| Stable cold CLI SVG | 0.2659, 0.2626, 0.2658 | median 0.2658 |
| Stable CLI DRC with parity | 0.7727 | one sample only |
| Nightly CLI DRC with parity | 0.2829 | one sample only, diagnostic |

On this small board, keeping a server alive saves about 0.17 s per full read after startup. One startup plus one warm read
costs about the same as one cold read. This does not establish whole-workflow speedup, a large-board result, or a reason
to change runtime defaults. The single SVG/DRC samples are not statistical performance claims.

Initial raw read digests exposed process-dependent ordering of group member IDs. The probe now preserves raw hashes
and normalizes **only those unordered memberships** before comparing contents. All three final comparisons match;
the unit check also proves polygon point order still affects comparison. No production reader or geometry is rewritten.
CLI/API SVG page, layer, full drill marks and precision (4) match. Removing `<title>` metadata, which contains filename
and timestamp, makes the final cold and warm SVG files byte-identical. No geometry normalization is applied to SVG.

## Save and stable compatibility

| Copy | Format | Generator | Stable 10.0.6 result |
| --- | --- | --- | --- |
| Original stable project copy | 20260206 | 10.0 | opens; diagnostic DRC/opens/parity 0/0/0 |
| Nightly `SaveCopyOfDocument` output | 20261025 | 10.99 | exit 3, refuses newer format |

The stable error explicitly requires KiCad 10.99 or later / format 20261025 or later. The attempted reopen has matching
schematic/rule sidecars and retains the project generated by the save. This is a real format refusal, not a missing-input
failure. Stable and nightly diagnostics on the **original** copy both report 0 DRC errors, 0 opens and 0 parity errors;
neither result is board acceptance evidence for this task.

The result supports the existing split: pinned nightly reads where needed, stable KiCad 10 saves and acceptance. The
probe config can select either diagnostic profile without changing the production image or default runtime roles.
Canonical saves through nightly remain inappropriate for the tested version.

## Reproduction, checks and evidence

See [the command/config guide](../../KICAD-RUNTIME-PROBE.md). The command requires a new output directory, stages all
project files itself, verifies source hashes, and always emits `acceptance: false`. `Server::start` retains its existing
environment/default behavior; the explicit runtime constructor is used only by the probe. `Client::command` handles
void responses while retaining the existing envelope status checks.

- Full Rust core suite: 936 passed, 2 existing external-evidence tests ignored; no failures.
- Source/bundle sync suite: 9 passed. Copy guards, explicit-nightly config, typo refusal and membership-only comparison
  tests pass. No acceptance checker, threshold or CI gate was weakened.
- The first full-suite attempt lacked shared data tables in a reduced source archive. Supplying the unchanged repository
  tables fixed the environment; tests were not edited to hide the missing-fixture failures.
- The first digest/precision probes are retained separately. Final semantic and SVG comparisons use the explicit rules
  above; no passing board result was sought by repeating a routing attempt.

Raw outputs, complete source hashes, exact CLI commands, timings and errors are in
[the JSON record](2026-11-05-nightly-ipc.json). Durable archive:
`gopadel-ci1:/var/lib/cip/saved-artifacts/nightly-ipc-1326/evidence.tar.gz` (604 KiB), SHA-256
`fd2ac399de02ce16518355f83c95c9335b71d64069f34ad2cc4d95e2cfc744be`.
No canonical CAD file, production image, daemon setting or runtime default changed.
