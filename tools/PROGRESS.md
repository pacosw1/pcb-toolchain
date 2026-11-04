# IoT Lab terminal workbench

Run `tools/progress.sh --watch --color` in Ghostty or Kitty. Everything stays
inside the terminal: board cards, PCB and schematic images, live routing
candidates, and an interactive GPU 3D view. No browser or HTTP server is used.

The first run installs pinned Textual, textual-image, ModernGL and trimesh
dependencies into `.git/board-progress/venv`. KiCad CLI and its bundled Python
must be installed. SVG rasterization uses `rsvg-convert` when present, or macOS
Quick Look. Build dependencies may be needed if pip has no native GPU wheel for
the current Python. Nothing is installed into system Python.

The image protocol is detected before the TUI starts. `--image-protocol tgp`
forces full-resolution Kitty graphics; `sixel` and `halfcell` are also available.
The header shows the backend in use. Halfcell is a lower-resolution colored text
fallback, useful in ordinary terminals and tests. `--color` overrides `NO_COLOR`.
Resize to at least 110 columns and 40 rows for the full layout; smaller terminals
keep the image central and show Work/Changes/History on demand.

| Control | Action |
| --- | --- |
| Tab, card click, up/down, j/k | Select a board and pin it |
| 1 / 2 / 3 / 4 | PCB / schematic / router candidate / 3D |
| f | Toggle auto-follow of the latest file save or agent report |
| Mouse wheel or +/- | Zoom |
| Drag image | Pan 2D; orbit 3D |
| Left/right in 3D | Rotate camera |
| Space in 3D | Toggle 20 Hz orbit requests |
| 0 or Fit | Reset view |
| w / c / h | Work / changed files / history |
| r / q | Check now / quit |

PCB layers, schematic sheets, and 3D top/bottom/isometric views have on-screen
controls. Clicking a view pins it; press f to resume following agents.

## Hot reload and rendering

```text
Saved PCB / schematic --> isolated KiCad export --> terminal image
Freerouting snapshots --> isolated candidate PCB --> terminal image
Saved PCB --> cached GLB --> persistent GPU geometry --> terminal frames
```

Source files are watched every second. Only requested views are exported.
The last good image stays visible while its replacement is built. Images carry
source/render timestamps; candidates are explicitly labeled as unvalidated.
The source boards are never rewritten by the viewer. The generated image/model
cache is limited to 80 recent render directories.

3D geometry is exported once per saved source version. Camera changes use an
offscreen ModernGL context and reuse GPU buffers, rather than rerunning KiCad.
Mouse interaction and optional spin coalesce camera requests so stale frames do
not accumulate. Actual displayed frame rate depends on image encoding, terminal
size, terminal implementation and transport. If GPU initialization fails, the
UI reports it and falls back to discrete KiCad-rendered camera angles.

Model fidelity follows the board's attached CAD assets. The fast GPU view uses
geometry and material colors; it is not a photorealistic material qualification.

## Routing visibility

New `tools/freeroute.py` runs publish live snapshots automatically. A small Java
observer reads Freerouting 2.1.0's already-serialized SES output every two seconds.
It does not change routing settings, traverse the mutable board, or apply a
candidate to the canonical board. The final SES replaces the last intermediate
preview on completion. Original input geometry is frozen for the preview import.

Existing processes started before this integration cannot expose intermediate
geometry retroactively. They still appear as observed processes, and their
saved results hot reload. `--no-live` disables optional routing telemetry.
If the helper cannot compile against the selected JAR, routing continues normally
with a warning and no intermediate images. A JDK is required for the helper.

Activity refreshes every two seconds. DRC runs sequentially on temporary project
copies every 120 seconds after the previous sweep finishes. `--interval 60`
changes that delay. The dashboard never changes board files. Checks time out
after 90 seconds per board; failures retain the previous result with an error.
Quitting stops visual export processes. An in-flight DRC check finishes and cleans
up its temporary copy before the sampler exits.

`tools/progress.sh` runs one sweep and prints a snapshot. `--cached` reads existing
CSV history without running DRC; combine with `--watch` for additional viewers.
Only one dashboard sampler may run per checkout. Stop any older progress.sh
watch loop before launching this version (older processes do not use the lock).
Snapshots retain the existing `hardware-design/reports/progress-log.csv` format.

## Report current work

An agent can publish a short status at each meaningful step:

```sh
tools/progress.sh --report BASE-PWR --agent base-router --task 'Routing In2 power nets; checking clearance next'
tools/progress.sh --report BASE-PWR --agent base-router --task 'Reviewing connector clearances' --view 3d
```

Reports live in the Git directory, outside tracked board files. They show their
age and become visibly stale after five minutes; refresh them as work proceeds.
No agent conversation or private prompt is read. Existing agents must call this
command for their intent to appear. A matching routing/DRC/PCB-tool process is
shown separately as an observation. Work without a recognizable process or
status report cannot be inferred from silence.

## Reading progress

- OPEN is the KiCad unconnected-item count; the trend shows the last eight CSV
  samples and their net change. Negative means fewer open connections.
- DRC ERRORS excludes warnings; PARITY counts schematic parity findings.
- PCB modified means the canonical PCB has uncommitted changes. Details list
  changed files throughout that board's folder, including reports.
- Historical CSV results have no file fingerprint and are labeled accordingly.
  New checks fingerprint PCB, schematic, project and rule files. If any change
  after the check, the result says FILE CHANGED. A changing source during the
  copy is rejected and retried at the next check.
- A lower OPEN count does not prove electrical correctness or release readiness.

## Implementation references

- [Textual widgets](https://textual.textualize.io/guide/widgets/)
- [textual-image protocols and terminal support](https://github.com/lnqs/textual-image)
- [Kitty graphics and animation protocol](https://sw.kovidgoyal.net/kitty/graphics-protocol/)
- [ModernGL context backends](https://github.com/moderngl/glcontext)
- [Freerouting 2.1.0 serialized output updates](https://github.com/freerouting/freerouting/blob/v2.1.0/src/main/java/app/freerouting/management/RoutingJobSchedulerActionThread.java)
