`tools/gerber_netcheck.ts` reconstructs copper connectivity from the fabrication
ZIP, then compares it with the schematic netlist. It uses `boardJson` solely for
numbered pad positions and copper layers: nanometres become mm and board Y is
negated for Gerber coordinates. Board net labels and Gerber X2 attributes are
ignored. The board is never edited.

Install the pinned parser and plotter with:

```sh
npm ci --ignore-scripts --prefix tools/gerber-netcheck
node --experimental-strip-types tools/gerber_netcheck.ts ENV-SENSE --root PROJECT
```

`GNC_ZIP` selects an archive copy. `KICAD_CLI` selects the schematic exporter.
The first invocation builds only the `gerber_netcheck` Rust executable, with
`-j 2`; unchanged sources reuse it. `GNC_NATIVE` selects an already built binary.
The native helper can also run directly on a `CheckInput` JSON document inside a
daemon job, without Node. It uses the branch's `kicad::geom` polygons, union,
difference, intersection and collision tests; no second clipping implementation.

The parser and plotter are the pinned Tracespace 4 packages. Their
[parser API](https://github.com/tracespace/tracespace/blob/main/packages/gerber-parser/API.md)
and [plotter API](https://github.com/tracespace/tracespace/blob/main/packages/gerber-plotter/API.md)
define the streams consumed by parse.ts. Parser/plotter warnings reject the
input, so an unsupported command cannot silently remove copper. Plated drills
use KiCad's metric decimal format, including G85 slots; inch drills are rejected
as before. Copper circles and strokes keep the original 24 segments per quadrant;
the hole overlap allowance remains 0.05 mm with 16 segments per quadrant.
Coordinates passed to the shared geometry round to whole nanometres.

The Python file remains because silk_jlc.py and fp_keepouts.py import its geometry
helpers, and fab-workflow.sh still invokes its CLI. Those callers are outside this
port's scope. The new CLI drops pcbnew pad extraction, Shapely/gerbonara runtime
dependencies, ZIP extraction and the leaked extraction directory. It rejects
implicit drill coordinate formats instead of silently interpreting them as mm.

Targeted checks:

```sh
cargo test --manifest-path tools/router/core/Cargo.toml -j 2 --bin gerber_netcheck
npm test --prefix tools/gerber-netcheck
npm run typecheck --prefix tools/gerber-netcheck
```

Typechecking uses the existing tools/package.json dev dependencies (`npm install
--ignore-scripts --no-package-lock --prefix tools`). The local tsconfig pins type
resolution to that Node version; the parser packages carry legacy Node types.
Tests cover Gerber polarity, local aperture holes, macros, arcs, regions, repeats,
inches, drills, plated connectivity, opens/shorts/missing copper, schematic mapping,
report text, and the CLI with cached board JSON and a fixture schematic exporter.
Real boards, live API reads, release workflows and Python-output comparisons have
not been run as part of this port.
