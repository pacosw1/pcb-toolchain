// Pixel-art silkscreen checks, shared by the board audits.
// Geometry comes from tools/check_pixel_art.ts, which reads the board text and its board JSON.
// The art is made by tools/pixel-art.ts: one group "pixel-art <name>" per icon.

import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {TS_NODE} from './env.mjs';

const SILK = {'B.SilkS': ['B.SilkS', 'B.Silkscreen'], 'F.SilkS': ['F.SilkS', 'F.Silkscreen']};
const PROBE = fileURLToPath(new URL('../check_pixel_art.ts', import.meta.url));

function runProbe(pcb, names) {
  const out = execFileSync(process.execPath, [...TS_NODE, PROBE, pcb, ...names], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']});
  return JSON.parse(out.split('\n').find((line) => line.startsWith('{')));
}

// arts: {name: 'B.SilkS' | 'F.SilkS'}. check(name, ok, detail) records one result. measure: tests replace the probe.
export function pixelArtChecks({pcb, arts, check, measure = runProbe}) {
  let art = {};
  let edge = 0.5;
  try {
    const res = measure(pcb, Object.keys(arts));
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
