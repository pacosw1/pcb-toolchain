// Pixel-art silkscreen checks, shared by the board audits.
// Geometry comes from tools/check_pixel_art.py (KiCad bundled Python, pcbnew).
// The art is made by tools/pixel-art.py: one group "pixel-art <name>" per icon.

import {execFileSync} from 'node:child_process';

const SILK = {'B.SilkS': ['B.SilkS', 'B.Silkscreen'], 'F.SilkS': ['F.SilkS', 'F.Silkscreen']};

// arts: {name: 'B.SilkS' | 'F.SilkS'}. check(name, ok, detail) records one result.
export function pixelArtChecks({python, probe, pcb, arts, check}) {
  let art = {};
  let edge = 0.5;
  try {
    const out = execFileSync(python, [probe, pcb, ...Object.keys(arts)], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']});
    const res = JSON.parse(out.split('\n').find((line) => line.startsWith('{')));
    art = res.art;
    edge = res.edge_mm;
  } catch (e) {
    check('pixel-art probe runs', false, String(e.message).slice(0, 200));
    return;
  }
  for (const [name, layer] of Object.entries(arts)) {
    const a = art[name] ?? {exists: false};
    const onLayer = a.exists && a.shapes > 0 && a.layers.length === 1 && SILK[layer].includes(a.layers[0]);
    check(`pixel art "${name}": group "pixel-art ${name}" on ${layer}`, onLayer,
      a.exists ? `${a.shapes} shapes on ${a.layers.join(', ')}, bbox ${a.bbox.join(' ')}` : 'no group');
    check(`pixel art "${name}": inside the board with >= ${edge} mm margin`, a.exists && a.shapes > 0 && a.outside.length === 0,
      a.exists ? (a.outside.length ? `${a.outside.length} shapes too near the edge: ${JSON.stringify(a.outside.slice(0, 3))}` : 'all shapes') : 'no group');
    check(`pixel art "${name}": clear of pads, mask openings, holes, hole keepouts, the barrier, courtyards, the JLC text and other silkscreen`,
      a.exists && a.shapes > 0 && a.hits.length === 0,
      a.exists ? (a.hits.length ? `touches: ${a.hits.slice(0, 6).join('; ')}` : 'no overlap') : 'no group');
  }
}
