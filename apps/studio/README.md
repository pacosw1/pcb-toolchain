# PCB Studio

Desktop app and agent-first engine that takes a PCB from brief to fab files through explicit, gated steps,
with a live board view, Claude chat, datasheets, BOM and parts in one window. Mac first, Linux later.

Plan: `~/.claude/plans/typed-bubbling-lemur.md` (approved 2026-10-24). Hardware data stays in the iot-lab repo,
which the app opens as a project.

## Layout
- `app/` — Electron + React + TypeScript (electron-vite). Main process: engine supervisor (`src/main/engine.ts`) and the
  Claude Agent SDK host. Renderer: the UI. The engine itself is `src/main/engineMain.ts`: a separate process on the app's
  own binary, WebSocket JSON-RPC on 127.0.0.1; it prints `READY {"port": N}` and exits when its stdin closes (the app
  owns it).
- `app/resources/pcbnew_worker.py` — the only Python here: it runs on KiCad's own Python because it calls the pcbnew API.

## Develop
```sh
cd app && npm install && npm run dev            # app (starts the engine itself)
node --no-warnings --test test/*.test.ts        # engine tests
npx electron-vite build && npx playwright test  # e2e: start, crash + restart, gate, route + adopt
npm run build:web && npm run web -- --project DIR   # read-only web viewer (publish with: tailscale serve --bg 8787)
```

Web viewer as a launchd user agent (survives reboots; after `npm run build:web`): `sh apps/studio/deploy/install-web-viewer.sh`, which writes `~/Library/LaunchAgents/com.pcbstudio.web.plist` and loads it.
Log: `~/Library/Logs/pcbstudio-web.log`; project override `PCBSTUDIO_PROJECT=DIR`; remove with `launchctl bootout gui/$(id -u)/com.pcbstudio.web`.

## Phases
0 mockups ✓ · 1 skeleton ✓ · 2 model + KiCad I/O + read-only browse · 3 runs + gates · 4 agent · 5 generic build
(NET-NODE pilot) · 6 parts, schematic, fab · 7 Linux.

### Native board specifications

Select a board, then **Specifications** to inspect native KiCad statistics, stackup,
and the footprint BOM. Exports run on temporary copies of the saved PCB and its
project companion. The view records the board SHA and capture time; **Refresh
specifications** reads a new snapshot. This is a saved-board inspector, not a live
IPC session. Supplier evidence remains in Parts / BOM; native exports do not supply
price quotes.

The adapter detects each export command using its help response. Unsupported
commands show an availability message; failed exports show an error without
hiding successful sections. Stackup nanometers are displayed in millimeters;
statistics retain KiCad's explicit units. No output cache is used in this version.

The existing runtime selection is unchanged. To opt into an installed nightly,
launch Studio with `PCBSTUDIO_KICAD_CLI=/absolute/path/to/kicad-cli-nightly`.
Use an executable wrapper if the nightly needs its own libraries. The tested
Linux nightly was upstream build `4fe1ca2060` (10.99.0); this does not install or
select a macOS nightly automatically. Board exports were tested on an isolated
ENV-SENSE copy; hierarchical schematic IPC and operation progress are separate work.

**Inspect native objects** now starts a short-lived, read-only IPC session for a
private snapshot of the PCB and its explicitly assigned schematic. It waits for
API readiness, binds requests to the server token, bounds reply sizes and time,
and closes the process afterward. It returns object counts, the exact API build,
and SHA-256 evidence for the copied inputs. Ordinary relative child sheets are
copied within the project boundary; external paths, variable-based paths, and
symlinked child sheets are rejected. macOS/Linux are supported by this transport;
Windows is reported as unavailable. This is an on-demand snapshot inspection,
not a stream of unsaved editor changes or routing progress. Flat PCB/schematic
inspection was verified against the pinned Linux nightly; hierarchical native
behavior still needs a real-project validation.

Parts / BOM also shows **recorded unit prices** when its revision's CSV supplies
`Unit price`, `Currency`, and a matching LCSC identifier (or matching MPN when no
LCSC identifier is supplied). Optional columns are `Supplier`, `Price observed
UTC`, and `Minimum quantity`. Part details retain per-reference provenance and
quantity breaks; missing dates or prices stay explicit. Values are historical
project evidence, not fetched quotes. No currency conversion or estimated board
total is computed.

### Interactive 3D preview

The viewer batches compatible opaque CAD faces inside each glTF mesh before
loading the model. Triangle data, normals, materials, node transforms, and
component boundaries are preserved. Transparent faces stay separate so their
sorting is preserved. Unsupported animated/compressed GLBs pass through unchanged.
Raw exports remain cached separately from versioned viewer assets.

The preview renders on camera/size changes, uses fixed bounded pixel density to prevent resolution jumps during interaction,
and uses neutral studio illumination, a cached shadow map, and material defaults
for diffuse-only CAD faces. Named board layers use a display palette matched to
KiCad's native render reference. This is a real-time preview style, not KiCad's
raytracer; no native renderer fork or per-mouse-movement CLI process is used.

Validation on the real BASE-PWR-B export reduced 104,860 primitives to 2,342
(63.8 MB to 42.8 MB). Every indexed vertex/normal and all material/node records
were compared before and after batching. The opt-in Electron benchmark
`PCBSTUDIO_3D_BENCHMARK=/path/to/iot-lab npx playwright test e2e/3d-performance.spec.ts`
checks bounded draw calls and idle rendering with pointer input isolated, then
captures orbit frame timings and a screenshot. Those timings depend on GPU,
viewport, and concurrent desktop activity.

The viewer renders silkscreen as opaque ink with a small depth bias, uses an opaque
board substrate, and disables depth writes for the translucent solder mask. This
keeps layer visibility stable while orbiting. Camera clipping adapts to zoom, orbit
motion settles with damping, and the presentation background is dark charcoal.

### Schematic viewer

The **Schematic** tab renders the selected board revision's explicitly assigned
schematic with KiCad's native SVG export. It copies the root, in-project child
sheets, and project companion into a disposable snapshot, verifies the source
bytes after export, and serves the generated SVGs as images. Root sheet appears
first; the sheet selector exposes every exported page. Drag or scroll to pan,
pinch or Ctrl+scroll (or +/-) to zoom around the pointer, and use **Fit sheet** (or F with the canvas focused) to reset.
**Refresh schematic** rereads the saved files. This is view-only; symbol editing
and linked schematic/PCB selection are not implemented.

Schematic exports use a private Studio Dark KiCad color configuration, leaving the
user's KiCad preferences unchanged. The SVG and WebGL canvases have transparent
backgrounds and inherit the app's dark surface; there is no white paper fill or
separate 3D backdrop.

Schematic navigation batches transforms once per animation frame without React
state updates on pointer movement. The SVG stays on a compositor layer during
gestures and rasterizes at the final scale after settling. The graphite palette
uses neutral symbol outlines, bright references, and green connections.

### Branded specification documents

**Specifications** opens the selected revision's assigned Markdown or PDF document.
Markdown uses the SW INDUSTRIES printable-sheet design recovered from iot-lab
commit `2450d95c`, `site/build.mjs` (`specSheet`) and `site/src/assets/sheet.css`:
monochrome logo/header, clear section rules, compact tables, and A4 print styles.
The source document is preserved, including its stated revision and limitations;
Studio does not invent ratings or silently substitute a different revision's spec.
The footer records the source path and content hash. **Print / Save PDF** opens the
platform print flow. **Native board data** retains the KiCad statistics/stackup/BOM
inspector. The document reader supports standard Markdown and GFM tables; raw HTML
is not executed. Existing PDF specs use the PDF viewer.

### Experimental routing controller

Runs includes an explicitly enabled, bounded routing loop shared with the CLI and Studio agent. It records round decisions and reasons, retains verified candidates separately from search results, and reuses the existing live viewer and candidate gates. The benchmark no-go remains; no speedup or automatic adoption is claimed. See [the controller contract](../../tools/ROUTING-LOOP.md).
