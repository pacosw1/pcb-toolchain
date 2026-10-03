#!/usr/bin/env node
// Routing worklist for a board on the gate runner: the open connections, by net, in the order to route them.
//   node tools/gate.mjs <BOARD> && node tools/route_plan.mjs <BOARD> [--md]
// It reads <board>/.gate/drc.json (from the last gate run) and the board data files:
//   current-paths.json  -> power nets with the design current
//   rp001-fast-nets.json, diff-pairs.json -> fast nets
// Order (CLAUDE.md section 4): 1 power, largest current first; 2 fast nets; 3 slow nets, shortest first.
// Reason: a power path needs width and a short signal needs little room; a long slow net needs a free corridor
// and goes last, by hand or by the autorouter. The list is a plan, not a result: each route still passes the gate.

import {readFileSync, existsSync} from 'node:fs';
import {join} from 'node:path';
import {root} from './lib/env.mjs';

const board = process.argv[2];
const dir = join(root, 'hardware-design/boards', board ?? '');
const drcFile = join(dir, '.gate/drc.json');
if (!board || !existsSync(drcFile)) {
  console.error('usage: node tools/route_plan.mjs <BOARD> [--md]   (run node tools/gate.mjs <BOARD> first)');
  process.exit(2);
}
const read = (name) => (existsSync(join(dir, name)) ? JSON.parse(readFileSync(join(dir, name), 'utf8')) : null);
// A net has one {amps, pads} entry or a list of chains; the plan uses the largest current of the net.
const amps = Object.fromEntries(Object.entries(read('current-paths.json')?.nets ?? {}).map(([n, v]) => [n, v.amps ?? Math.max(...(v.chains ?? []).map((c) => c.amps))]));
const fastGlobs = [...(read('rp001-fast-nets.json')?.fast ?? []), ...(read('diff-pairs.json')?.pairs ?? []).flatMap((p) => [p.p, p.n])];
const globToRegex = (g) => new RegExp(`^${g.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
const fast = fastGlobs.map(globToRegex);

const nets = new Map();
for (const u of JSON.parse(readFileSync(drcFile, 'utf8')).unconnected_items ?? []) {
  const [a, b] = u.items;
  const name = /\[([^\]]+)\]/.exec(a.description)?.[1] ?? '?';
  const len = Math.hypot(a.pos.x - b.pos.x, a.pos.y - b.pos.y);
  const n = nets.get(name) ?? {name, open: 0, mm: 0, links: []};
  n.open += 1;
  n.mm += len;
  n.links.push(`(${a.pos.x.toFixed(1)},${a.pos.y.toFixed(1)})-(${b.pos.x.toFixed(1)},${b.pos.y.toFixed(1)}) ${len.toFixed(1)} mm`);
  nets.set(name, n);
}
for (const n of nets.values()) {
  n.cls = n.name in amps ? 'power' : fast.some((r) => r.test(n.name)) ? 'fast' : 'slow';
  n.amps = amps[n.name] ?? null;
}
const rank = {power: 0, fast: 1, slow: 2};
const list = [...nets.values()].sort((x, y) => rank[x.cls] - rank[y.cls] || (x.cls === 'power' ? y.amps - x.amps : x.mm - y.mm) || x.name.localeCompare(y.name));

const total = list.reduce((s, n) => s + n.open, 0);
const count = (cls) => list.filter((n) => n.cls === cls);
const sum = (cls) => count(cls).reduce((s, n) => s + n.open, 0);
if (!process.argv.includes('--json')) console.log(`route plan ${board}: ${total} open connections in ${list.length} nets  (power ${sum('power')} in ${count('power').length} nets, fast ${sum('fast')} in ${count('fast').length}, slow ${sum('slow')} in ${count('slow').length})`);
if (process.argv.includes('--json')) {
  console.log(JSON.stringify(list.map(({name, cls, open, mm, amps: a}) => ({name, cls, open, mm: Number(mm.toFixed(1)), amps: a}))));
} else if (process.argv.includes('--md')) {
  console.log('\n| # | Class | Net | Open | Air length mm | Design A |\n| --- | --- | --- | ---: | ---: | ---: |');
  list.forEach((n, i) => console.log(`| ${i + 1} | ${n.cls} | ${n.name} | ${n.open} | ${n.mm.toFixed(1)} | ${n.amps ?? ''} |`));
} else {
  list.forEach((n, i) => console.log(`${String(i + 1).padStart(3)} ${n.cls.padEnd(5)} ${n.name.padEnd(34)} open ${String(n.open).padStart(2)}  ${n.mm.toFixed(1).padStart(6)} mm${n.amps ? `  ${n.amps} A` : ''}${n.open <= 2 ? `  ${n.links.join('; ')}` : ''}`));
}
